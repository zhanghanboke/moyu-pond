// test.js —— 用 CDP 跑一遍功能自检：素材、交互、设置、倒计时、报错。
// 用法: node tools/test.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const url = process.argv[2] || 'http://127.0.0.1:8765/?fresh=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '  通过' : '  失败'}  ${name}${extra !== undefined && !ok ? '  -> ' + JSON.stringify(extra) : ''}`);
  ok ? pass++ : fail++;
}

(async () => {
  const profile = fs.mkdtempSync(os.tmpdir() + '/moyu-test-');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--disable-gpu', '--no-sandbox',
    '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

  let page = null;
  for (let i = 0 && !page; i < 40 && !page; i++) {
    await sleep(400);
    try { const t = await getJSON('/json/list'); page = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) { }
  }
  if (!page) { console.log('连不上 Chrome'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(JSON.stringify(m.params.args.map(a => a.value)));
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => { ws.onopen = r; });
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {          // 单条断言出错不该整个脚本崩掉
      errs.push('EVAL ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
      return undefined;
    }
    return r.result.value;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(5000);

  console.log('== 素材与渲染 ==');
  check('脚本加载完、资源就绪', await ev('!!(window.Sprites&&window.Sim&&window.MoyuHUD&&__moyu&&Sprites.assets.ready)'));
  check('底图 + 5 种锦鲤 + 5 种装饰都在', await ev(
    `Object.keys(Sprites.assets.koi).length===5 && Object.keys(Sprites.assets.decor).length===5 && !!Sprites.assets.base`));
  check('摆尾图集已烘好(每种鱼都有 atlas)', await ev(
    `Object.values(Sprites.assets.koi).every(r=>r.atlas&&r.atlas.canvas.width>1000)`));
  check('静态层已烘好', await ev(`!!__moyu.state.bg && __moyu.state.decor.length>0`));
  check('鱼数量与面积换算后的目标一致', await ev(`__moyu.state.fishes.length===__moyu.state.wantCount`),
    await ev(`[__moyu.state.fishes.length, __moyu.state.wantCount, __moyu.cfg.fishCount]`));
  check('鱼在动（两帧位置有变化）', await ev(`new Promise(r=>{const a=__moyu.state.fishes.map(f=>[f.x,f.y]);
    setTimeout(()=>r(__moyu.state.fishes.some((f,i)=>Math.abs(f.x-a[i][0])+Math.abs(f.y-a[i][1])>0.5)),400)})`));
  check('鱼没有全部堆在边界', await ev(
    `(()=>{const w=__moyu.world,h=__moyu.world;let e=0;__moyu.state.fishes.forEach(f=>{if(f.x<20||f.y<20||f.x>innerWidth-20||f.y>innerHeight-20)e++});return e/__moyu.state.fishes.length<0.15})()`));

  console.log('== 交互 ==');
  // 先把鱼群整段摘走：否则落在鱼嘴边的饵会在几十毫秒内被吃光，读到 0 会被误判成「没投食」
  await ev(`window.__savedFish = __moyu.state.fishes.splice(0);
    __moyu.state.foods.length=0; __moyu.state.ripples.length=0; null`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 400, button: 'left', clickCount: 1 });
  await sleep(120);
  const fed = await ev(`[__moyu.state.foods.length, __moyu.state.ripples.length]`);
  check('点击会投放鱼食并打出涟漪', fed[0] >= 1 && fed[1] >= 1, fed);
  await ev(`__moyu.state.fishes.push(...window.__savedFish); delete window.__savedFish; null`);
  // 数量单独同步验：异步检查时鱼可能已经把饵吃掉，导致断言抖动
  check('一次点击投放 4~6 粒鱼食', await ev(`(()=>{
    __moyu.state.foods.length=0;
    document.getElementById('pond').dispatchEvent(
      new PointerEvent('pointerdown',{clientX:400,clientY:300,bubbles:true}));
    const n=__moyu.state.foods.length; __moyu.state.foods.length=0;
    return n>=4 && n<=6})()`));
  check('附近的鱼被吸引过去', await ev(`new Promise(r=>{
    const f0=__moyu.state.foods[0]||{x:700,y:400};
    const near=__moyu.state.fishes.filter(f=>Math.hypot(f.x-700,f.y-400)<300);
    const d0=near.map(f=>Math.hypot(f.x-f0.x,f.y-f0.y));
    setTimeout(()=>{
      const d1=near.map(f=>Math.hypot(f.x-700,f.y-400));
      const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
      r(d1.length>0 && avg(d1)<avg(d0)+40);
    },1800);
  })`));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 500, buttons: 0 });
  await sleep(60);
  check('鼠标位置被跟踪', await ev(`__moyu.mouse.x===900 && __moyu.mouse.y===500 && __moyu.mouse.inside`),
    await ev(`[__moyu.mouse.x, __moyu.mouse.y, __moyu.mouse.inside]`));
  // 惊散模式：和"关闭互动"作对照。量的是"这段时间游了多远"（累计行程），
  // 不是"离起点多远"——后者会把正常巡游算进去，信噪比太低，容易偶发误报。
  const fleeRun = mode => ev(`new Promise(r=>{
    __moyu.cfg.interact='${mode}';
    const cx=innerWidth/2, cy=innerHeight/2;
    const f=__moyu.state.fishes.slice().sort((a,b)=>
      Math.hypot(a.x-cx,a.y-cy)-Math.hypot(b.x-cx,b.y-cy))[0];
    let last={x:f.x,y:f.y}, dist=0;
    const iv=setInterval(()=>{dist+=Math.hypot(f.x-last.x,f.y-last.y);last={x:f.x,y:f.y}},40);
    __moyu.mouse.x=f.x+30;__moyu.mouse.y=f.y+20;__moyu.mouse.inside=true;
    setTimeout(()=>{clearInterval(iv);__moyu.mouse.inside=false;r(Math.round(dist))},1500)})`);
  const fled = await fleeRun('shy');
  const calm = await fleeRun('off');
  check('惊散模式：指针靠近后鱼游得明显更远（对比无互动）', fled > calm * 1.5, [fled, calm]);
  /* 绕行（dodge）与惊散（shy）是两种不同的让路方式：dodge 斜着让开、只有贴脸才窜，
   * shy 一进圈就背身逃。满池鱼里统计 burst 太靠运气（被推开的鱼会待在圈外），
   * 所以拿一条鱼放在鼠标左侧 60px、头朝鼠标，喂给 update 固定输入跑 0.4 秒 ——
   * 完全确定性：burst 只可能来自鼠标这一段（没有食物、没有障碍）。 */
  const dodgeProbe = mode => ev(`(()=>{
    __moyu.cfg.interact='${mode}';
    const cx=600, cy=400;
    const f=new Sim.Fish(__moyu.world, Sprites.KOI);
    f.school=null; f.x=cx-60; f.y=cy; f.angle=0; f.speed=40; f.burst=0;
    const sim={fishes:[f], mouse:{x:cx,y:cy,inside:true,speed:0}, foods:[], cfg:__moyu.cfg,
      obstacles:[], env:__moyu.env(), spawnRipple:function(){}};
    let peak=0;
    for(let i=0;i<24;i++){ f.update(1/60,__moyu.world,sim); if(f.burst>peak) peak=f.burst; }
    const turn=Math.abs(Math.atan2(Math.sin(f.angle),Math.cos(f.angle))*180/Math.PI);
    return [+turn.toFixed(1), +peak.toFixed(2), Math.round(Math.hypot(f.x-cx,f.y-cy))];
  })()`);
  const dgP = await dodgeProbe('dodge');
  const shyP = await dodgeProbe('shy');
  const offP = await dodgeProbe('off');
  check('绕行模式：正对鼠标的鱼会侧偏让开，且不会像惊散那样猛逃',
    dgP[0] > 5 && dgP[1] > 0.05 && dgP[1] < shyP[1] * 0.6 && offP[1] < 0.02,
    { dodge: dgP, shy: shyP, off: offP });
  await ev(`__moyu.cfg.interact='feed'; null`);
  check('有"塘主"级的大锦鲤（存在体长>中位数 1.6 倍的个体）', await ev(
    `(()=>{const L=__moyu.state.fishes.map(f=>f.len).sort((a,b)=>a-b);const med=L[Math.floor(L.length/2)];
      return L.filter(x=>x>med*1.55).length>=1})()`));

  console.log('== 碰撞体积 / 池塘深浅 / 池底投影 ==');
  /* 鱼身体是个沿体轴的椭圆（半长轴 0.42·体长、半短轴 0.42·体长·0.38），
   * 两条深度相近的鱼不允许叠在一起。整值LoRA:这里直接数"椭圆重叠的对"，
   * 容忍擦一下（穿透深度 < 0.35），但不允许有对身体互相穿过去。 */
  const body = await ev(`(()=>{
    const fs=__moyu.state.fishes, cfg=__moyu.cfg;
    const L=f=>(f.len||0)*(cfg.size||1);
    let pairs=0, hit=0, worst=0, nnMin=1e9;
    for(let i=0;i<fs.length;i++) for(let j=i+1;j<fs.length;j++){
      const a=fs[i], b=fs[j];
      if(Math.abs((a.depthNow||0)-(b.depthNow||0))>0.2) continue;
      const dx=b.x-a.x, dy=b.y-a.y;
      const ux=Math.cos(a.angle), uy=Math.sin(a.angle);
      const al=dx*ux+dy*uy, la=-dx*uy+dy*ux;
      const A=L(a)*0.42+L(b)*0.42;
      const B=(L(a)*(a.bodyAR||.38)*0.42)+(L(b)*(b.bodyAR||.38)*0.42);
      const q=(al/A)*(al/A)+(la/B)*(la/B); const d=Math.hypot(dx,dy);
      pairs++; if(q<1){hit++; worst=Math.max(worst,1-Math.sqrt(q));}
      nnMin=Math.min(nnMin, d/Math.max(L(a),L(b)));
    }
    return {pairs, hit, worst:+worst.toFixed(3), nnMin:+nnMin.toFixed(2)}})()`);
  check('鱼的身体不会叠在一起（椭圆碰撞）', body.hit / Math.max(body.pairs, 1) < 0.01 && body.worst < 0.35, body);
  // 0.2 是"两条鱼贴着擦身"的理论下限（各自的半短轴加起来约 0.32 个体长，斜着会更近一点）
  check('最近的邻居也没有穿模（间距 > 0.2 个体长）', body.nnMin > 0.2, body);

  const shallow = await ev(`new Promise(r=>{
    const mid=(()=>{const L=__moyu.state.fishes.map(f=>f.len).sort((a,b)=>a-b);return L[L.length>>1]})();
    const deep=(()=>{const d=__moyu.state.fishes.map(f=>f.depthNow).sort((a,b)=>a-b);return d[d.length-1]})();
    const set=v=>{const el=document.getElementById('pondDepth'); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true}))};
    set(1);
    setTimeout(()=>{
      const a=__moyu.state.fishes.map(f=>f.len).sort((x,y)=>x-y)[__moyu.state.fishes.length>>1];
      set(0.35);
      setTimeout(()=>{
        const b=__moyu.state.fishes.map(f=>f.len).sort((x,y)=>x-y)[__moyu.state.fishes.length>>1];
        const dmax=Math.max(...__moyu.state.fishes.map(f=>f.depthNow));
        set(0.58);
        setTimeout(()=>r({deep:+a.toFixed(1), shallow:+b.toFixed(1), dmax035:+dmax.toFixed(2)}), 500);
      }, 500);
    }, 500)})`);
  check('拖"池水深浅"立刻改体型：越浅越大', shallow.shallow > shallow.deep * 1.1, shallow);
  check('深度被池塘深浅压住了（拖到 0.35 后没有更深的鱼）', shallow.dmax035 <= 0.36, shallow);

  check('每种锦鲤都烘好了投影剪影', await ev(`(()=>{
    const rs=Object.values(Sprites.assets.koi);
    return rs.length>0 && rs.every(r=>r.sil && r.sil.canvas.width>10)})()`),
    await ev(`Object.values(Sprites.assets.koi).map(r=>!!r.sil)`));
  /* 影子必须画在所有鱼之前：它们投在最下面那一层上，混着画会让先出现的鱼压住后一条鱼的影子。
   * 做法：每帧第一次 drawImage 是背景，拿它当帧的分隔符，看接下来是不是"先一排 S 再一排 F"。 */
  const order = await ev(`new Promise(r=>{
    // 影子会被降级阶梯整层拿掉（弱机的保护），所以量它的时候得把 autoDrop 按住
    const iv=setInterval(()=>{__moyu.state.autoDrop=0; __moyu.state.shadowOff=false},100);
    const P=CanvasRenderingContext2D.prototype, orig=P.drawImage;
    const sils=Object.values(Sprites.assets.koi).map(x=>x.sil&&x.sil.canvas);
    const atls=Object.values(Sprites.assets.koi).map(x=>x.atlas&&x.atlas.canvas);
    const bg=__moyu.state.bg; const seq=[]; const alphas={lo:1,hi:0};
    P.drawImage=function(im){
      if(im===bg) seq.push('B');
      else if(sils.indexOf(im)>=0){ seq.push('S'); alphas.lo=Math.min(alphas.lo,this.globalAlpha); alphas.hi=Math.max(alphas.hi,this.globalAlpha); }
      else if(atls.indexOf(im)>=0) seq.push('F');
      return orig.apply(this,arguments)};
    setTimeout(()=>{P.drawImage=orig; clearInterval(iv);
      /* 帧边界不能用"背景那次 drawImage"：开着折射时背景是分 26 带画的，一帧里 26 次 B，
       * 相邻两个 B 之间根本没画鱼。把 B 和别的都滤掉只看 S/F，一帧就是一段 S 接一段 F。 */
      const sf=seq.filter(c=>c==='S'||c==='F').join('');
      const m=/^(S+)(F+)/.exec(sf.slice(sf.indexOf('S')));
      const s=m?m[1].length:0, f=m?m[2].length:0;
      r({head:sf.slice(0,20), s:s, f:f, alphas})},500)})`);
  check('影子画在所有鱼之前（一帧里先一整排 S 再一整排 F）',
    order.s > 10 && order.f > 10, order);
  check('影子的浓淡按深浅分层（深的更深、贴水面的更淡）',
    order.alphas.hi > order.alphas.lo * 1.3, order.alphas);
  const shadowOff = await ev(`new Promise(r=>{
    const iv=setInterval(()=>{__moyu.state.autoDrop=0; __moyu.state.shadowOff=false},100);
    const c=document.getElementById('fishShadow'); c.checked=false; c.dispatchEvent(new Event('input',{bubbles:true}));
    const P=CanvasRenderingContext2D.prototype, orig=P.drawImage; let hits=0;
    const sils=Object.values(Sprites.assets.koi).map(x=>x.sil&&x.sil.canvas);
    P.drawImage=function(im){ if(sils.indexOf(im)>=0) hits++; return orig.apply(this,arguments)};
    setTimeout(()=>{P.drawImage=orig; clearInterval(iv); c.checked=true; c.dispatchEvent(new Event('input',{bubbles:true})); r(hits)},400)})`);
  check('关掉"鱼的影子"就不再画投影', shadowOff === 0, shadowOff);
  // 降级阶梯：掉帧到一定程度影子会整层让位（弱机的保护），开了再自动回来
  const ladder = await ev(`new Promise(r=>{
    const sils=Object.values(Sprites.assets.koi).map(x=>x.sil&&x.sil.canvas);
    const iv=setInterval(()=>{__moyu.state.autoDrop=1},50);        // 模拟"这台机器扛不住"
    setTimeout(()=>{
      // 先给它两帧把开关落下去，再开始数
      let hits=0; const P=CanvasRenderingContext2D.prototype, orig=P.drawImage;
      P.drawImage=function(im){ if(sils.indexOf(im)>=0) hits++; return orig.apply(this,arguments)};
      setTimeout(()=>{ clearInterval(iv); const off=hits; hits=0;
        const iv2=setInterval(()=>{__moyu.state.autoDrop=0; __moyu.state.shadowOff=false},50);
        setTimeout(()=>{ clearInterval(iv2); P.drawImage=orig; __moyu.state.autoDrop=0;
          r([off, hits]) },600) },600) },300)})`);
  check('掉帧时影子整层让位，缓过来再回来',
    ladder[0] < 5 && ladder[1] > 20, ladder);

  console.log('== 游姿 ==');
  /* 匀速前进是最假的一件事：真锦鲤是"抖一下尾给一股推力，然后伸直身体滑一段"。
   * gait 用 sin^6 造这个节奏（半周期里只约 3 成时间在推），所以巡航速度的均值不变、
   * 但瞬时速度一鼓一鼓的。这里跑 6 秒采样 min/max，看它到底有没有起伏。 */
  const surge = await ev(`(()=>{
    const f=new Sim.Fish(__moyu.world, Sprites.KOI);
    f.school=null; f.x=600; f.y=400; f.speed=f.baseSpeed; f.burst=0;
    const sim={fishes:[f], mouse:{x:-999,y:-999,inside:false,speed:0}, foods:[], cfg:__moyu.cfg,
      obstacles:[], env:__moyu.env(), spawnRipple:function(){}};
    let lo=1e9, hi=0, bendMax=0;
    for(let i=0;i<360;i++){ f.update(1/60,__moyu.world,sim);
      if(i<60) continue;                       // 前 1 秒是起步瞬态，别算进去
      lo=Math.min(lo,f.speed); hi=Math.max(hi,f.speed);
      bendMax=Math.max(bendMax,Math.abs(f.bend)); }
    return {ratio:+(hi/lo).toFixed(2), bend:+bendMax.toFixed(3)}})()`);
  check('巡航不是匀速：一次摆尾给一股推力，然后滑行', surge.ratio > 1.12, surge);
  check('直线巡游时身体基本是直的（不会一直歪着）', surge.bend < 0.2, surge);

  /* 转弯的两件事同时发生：身体往弯道内侧弯（bend），航线已经拐了、身体还没转过来（pose 滞后）。
   * 拿一条鱼正对着鼠标跑 0.5 秒 —— 完全确定性，不涉及整池鱼的概率。 */
  const posture = await ev(`(()=>{
    const f=new Sim.Fish(__moyu.world, Sprites.KOI);
    f.school=null; f.x=600; f.y=400; f.angle=0; f.pose=0; f.speed=45; f.burst=0; f.bend=0;
    const cfg=Object.assign({},__moyu.cfg,{interact:'shy'});
    const sim={fishes:[f], mouse:{x:625,y:400,inside:true,speed:0}, foods:[], cfg:cfg,
      obstacles:[], env:__moyu.env(), spawnRipple:function(){}};
    let bendMax=0, lagMax=0;
    for(let i=0;i<30;i++){ f.update(1/60,__moyu.world,sim);
      bendMax=Math.max(bendMax,Math.abs(f.bend));
      lagMax=Math.max(lagMax,Math.abs(f.angle-f.pose)); }
    return {bend:+bendMax.toFixed(3), lag:+lagMax.toFixed(3),
      sign:Math.sign(f.bend), rot:Math.sign(f.angle)}})()`);
  check('转弯时身体弯成弧形（且尾巴甩向弯道外侧）',
    posture.bend > 0.05 && posture.sign === posture.rot, posture);
  check('转弯时身体转得比航线慢（侧滑）', posture.lag > 0.08, posture);

  /* 上面验的是数值，这条验的是"真的画出来了"：弯曲是一次 ctx.transform 的剪切，
   * 一帧里只要有若干次 drawImage 带着非零的 b 分量，就说明走的是带姿态的那条路径。 */
  const drawn = await ev(`new Promise(r=>{
    const P=CanvasRenderingContext2D.prototype, orig=P.drawImage; let maxB=0, hits=0;
    P.drawImage=function(){ const b=Math.abs(this.getTransform().b||0);
      if(b>maxB) maxB=b; if(b>0.01) hits++; return orig.apply(this,arguments)};
    const old=__moyu.state.fishes.map(f=>f.bend);
    __moyu.state.fishes.forEach(f=>{f.bend=0.3});
    setTimeout(()=>{P.drawImage=orig; __moyu.state.fishes.forEach((f,i)=>f.bend=old[i]);
      r({maxB:+maxB.toFixed(3), hits:hits})},400)})`);
  check('弯曲真的画进了鱼身上（drawImage 带着剪切项）', drawn.maxB > 0.2 && drawn.hits > 20, drawn);

  console.log('== 设置面板 ==');
  check('面板默认关闭', await ev(`!document.getElementById('panel').classList.contains('open')`));
  await ev(`document.getElementById('gear').click(); null`);
  check('点"设置"能打开面板', await ev(`document.getElementById('panel').classList.contains('open')`));
  await ev(`(()=>{const el=document.getElementById('fishCount');el.value=25;el.dispatchEvent(new Event('input',{bubbles:true}))})(); null`);
  await sleep(200);
  check('拖动数量滑杆会立刻改鱼群', await ev(`__moyu.state.fishes.length===__moyu.state.wantCount && __moyu.state.wantCount<25`),
    await ev(`[__moyu.state.fishes.length, __moyu.state.wantCount]`));
  check('设置写进了 localStorage', await ev(`JSON.parse(localStorage.getItem('moyu-pond:cfg:v1')).fishCount===25`));
  await ev(`document.getElementById('gear').click(); null`);
  check('能再关掉', await ev(`!document.getElementById('panel').classList.contains('open')`));

  /* 面板踩过一个坑：以前唯一的入口"设置"按钮在卡片里，而面板一开卡片整体 visibility:hidden，
   * 卡片整体 visibility:hidden，于是点开就再也点不回来。现在面板自带顶栏（返回 + 分页）。 */
  await ev(`HUD.togglePanel(true); null`);
  check('面板顶栏有返回按钮', await ev(`(()=>{const b=document.getElementById('pclose'),
    p=document.getElementById('panel');
    if(!b) return false;
    const r=b.getBoundingClientRect(), pr=p.getBoundingClientRect();
    return r.width>0 && r.top>=pr.top-1 && r.top<pr.top+60})()`));
  await ev(`document.getElementById('pclose').click(); null`);
  check('点顶栏的返回能回到卡片界面', await ev(`(()=>{
    return !document.getElementById('panel').classList.contains('open') &&
      getComputedStyle(document.querySelector('.card-main')).visibility==='visible'})()`),
    await ev(`[document.getElementById('panel').classList.contains('open'),
      getComputedStyle(document.querySelector('.card-main')).visibility]`));
  await ev(`HUD.togglePanel(true); null`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); null`);
  check('Esc 也能关掉面板', await ev(`!document.getElementById('panel').classList.contains('open')`));

  /* 滚动条：设置项 + 画板塞在一页里必然超屏，原来的解法是给 .panel 加 overflow-y:auto，
   * 结果是右侧一条灰白实心杠。现在拆成两页，每页自己装得下，滚动条就没了。 */
  await ev(`(()=>{HUD.togglePanel(true); HUD.openTab('set'); return null})()`);
  await sleep(80);
  const fitSet = await ev(`(()=>{const s=document.getElementById('paneSet');
    return [s.scrollHeight, s.clientHeight]})()`);
  await ev(`HUD.openTab('koi'); null`);
  await sleep(80);
  const fitKoi = await ev(`(()=>{const k=document.getElementById('paneKoi'), s=document.getElementById('paneSet');
    return [k.scrollHeight, k.clientHeight, getComputedStyle(s).display]})()`);
  check('设置页装得下，不需要滚动条', fitSet[0] <= fitSet[1] + 2, fitSet);
  check('我的锦鲤页也装得下（另一页让出了高度）',
    fitKoi[0] <= fitKoi[1] + 2 && fitKoi[2] === 'none', fitKoi);
  check('面板没有溢出屏幕之外', await ev(`(()=>{const r=document.getElementById('panel').getBoundingClientRect();
    return r.top>=0 && r.bottom<=innerHeight+1 && r.right<=innerWidth+1})()`),
    await ev(`(()=>{const r=document.getElementById('panel').getBoundingClientRect();
      return [Math.round(r.top), Math.round(r.bottom), innerHeight]})()`));
  await ev(`HUD.openTab('set'); null`);

  console.log('== 涟漪（波列 + 折射）==');
  const rings = await ev(`(()=>{
    const r=new Sim.Ripple(500,500,1.0,1); r.age=r.life*0.35;
    const R=r.front(); let n=0;
    for(let i=0;i<14;i++){const rr=r.crestR(i,R); if(rr>R)break;
      if(rr>5 && r.env(rr,R)>0.06) n++;}
    return n})()`);
  check('一次点击生成 3 圈以上的波列', rings >= 3, rings);
  check('波长随半径变长（外疏内密）', await ev(`(()=>{
    const r=new Sim.Ripple(500,500,1.0,1); r.age=r.life*0.5; const R=r.front();
    const g=[]; for(let i=0;i<r.N;i++)g.push(r.crestR(i,R));
    const d1=g[1]-g[0], d2=g[3]-g[2];
    return d1>0 && d2>d1})()`));
  check('前缘只扩不缩、且越跑越慢', await ev(`(()=>{
    const r=new Sim.Ripple(500,500,1.0,1); const a=[];
    for(let i=0;i<5;i++){a.push(r.front()); r.update(r.life/8);}
    return a.every((v,i)=>i===0||v>=a[i-1]) && (a[1]-a[0])>(a[4]-a[3])})()`));
  // 数折射调用次数时要按住 autoDrop：软件渲染下帧率会触发自动降级，
  // 降级会把整层折射跳过，那是设计行为，不该被这条断言当成 bug
  check('折射每帧真的在画', await ev(`new Promise(r=>{
    const P=Sim.Ripple.prototype, orig=P.drawRefraction; let hits=0;
    P.drawRefraction=function(){hits++; return orig.apply(this,arguments)};
    __moyu.cfg.refract=true;
    __moyu.state.ripples.push(new Sim.Ripple(600,400,1.0,1));
    const iv=setInterval(()=>{__moyu.state.autoDrop=0;
      if(!__moyu.state.ripples.some(x=>x.s===1)) __moyu.state.ripples.push(new Sim.Ripple(600,400,1.0,1));
    },100);
    setTimeout(()=>{clearInterval(iv);P.drawRefraction=orig;r(hits)},700)})`) > 20);
  check('关掉折射开关后不再调用', await ev(`new Promise(r=>{
    const P=Sim.Ripple.prototype, orig=P.drawRefraction; let hits=0;
    P.drawRefraction=function(){hits++; return orig.apply(this,arguments)};
    __moyu.cfg.refract=false;
    __moyu.state.ripples.push(new Sim.Ripple(600,400,1.0,1));
    setTimeout(()=>{P.drawRefraction=orig; __moyu.cfg.refract=true; r(hits)},700)})`) === 0);
  const peak = await ev(`new Promise(r=>{
    let peak = 0;
    const iv = setInterval(()=>{ peak = Math.max(peak, __moyu.state.ripples.length); }, 60);
    setTimeout(()=>{ clearInterval(iv); r(peak); }, 9000)})`);
  check('同屏涟漪不超过预算上限 8', peak <= 8, peak);
  // 折射是这次的关键，静帧看不出来，做像素级断言。
  // 用"环带 vs 远处对照区"的相对差，而不是绝对阈值：Rmax 本身带随机，
  // 绝对值会抖；采样点也要放在包络最强的环带(u≈0.6)上，中心区本来就没坡。
  const warpRaw = await ev(`(()=>{ try {
    const cv=document.getElementById('pond'), ctx=cv.getContext('2d'), bg=__moyu.state.bg;
    const g={pad:__moyu.state.overscan,dx:0,dy:0,dpr:__moyu.world.dpr,bw:bg.width,bh:bg.height};
    const cx=900, cy=500, w=44, h=44;
    const r=new Sim.Ripple(cx, cy, 1.0, 1); r.age=r.life*0.45;
    const R=r.front();
    const zones={band:[Math.round(cx+R*0.60-w/2), Math.round(cy-h/2)],
                 ctrl:[Math.round(cx+R*2.6), Math.round(cy-h/2)]};
    const before={};
    for(const [nm,[bx,by]] of Object.entries(zones)){
      ctx.fillStyle='#000'; ctx.fillRect(bx,by,w,h);
      ctx.drawImage(bg,(bx+g.pad)*g.dpr,(by+g.pad)*g.dpr,w*g.dpr,h*g.dpr,bx,by,w,h);
      before[nm]=ctx.getImageData(bx,by,w,h).data.slice(0);
    }
    r.drawRefraction(ctx, bg, g);
    const out={R:Math.round(R)};
    for(const [nm,[bx,by]] of Object.entries(zones)){
      const B=ctx.getImageData(bx,by,w,h).data, A=before[nm];
      let d=0,mx=0,n=0;
      for(let i=0;i<A.length;i+=4){
        const v=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]);
        d+=v; mx=Math.max(mx,v); n++;
      }
      out[nm]={mean:+(d/n).toFixed(2), max:mx};
    }
    return JSON.stringify(out);
  } catch (e) {
    // file:// 下图片算跨域，canvas 被污染后 getImageData 抛 SecurityError。
    // 应用本身不读像素所以照常运行，只是这条断言在这个模式下没法跑。
    return JSON.stringify({ skipped: e.name + ': ' + e.message });
  }})()`);
  const warp = warpRaw ? JSON.parse(warpRaw) : null;
  check('折射把水底弯了：环带像素差远大于远处对照区',
    !!(warp && warp.skipped) || (warp && warp.band && warp.ctrl &&
      warp.band.mean > warp.ctrl.mean + 1.2 && warp.band.max > 6),
    (warp && warp.skipped) || warp);
  check('涟漪会自己消散（不堆积）', await ev(`new Promise(r=>{
    const one=new Sim.Ripple(600,400,0.3,1); __moyu.state.ripples.push(one);
    setTimeout(()=>r(!__moyu.state.ripples.includes(one)), one.life*1000+900)})`));

  console.log('== 装饰与避障 ==');
  check('水下植物层已加载', await ev(`!!Sprites.assets.weed && Sprites.assets.weed.width > 400`));
  check('岸边实体障碍已生成（石头 + 两丛芦苇）', await ev(`__moyu.state.obstacles.length >= 3`),
    await ev(`__moyu.state.obstacles.map(o=>Math.round(o.r))`));
  check('装饰缓存带根部支点，bank/float 两种都有', await ev(
    `(()=>{const d=__moyu.state.decor;return d.length>=10 && d.some(x=>x.it.kind==='bank') &&
       d.every(x=>x.pivX>0 && x.pivY>0)})()`));
  const stuck = await ev(`new Promise(r=>{
    setTimeout(()=>{
      const obs = __moyu.state.obstacles;
      let bad = 0;
      for (const f of __moyu.state.fishes) for (const o of obs)
        if (Math.hypot(f.x - o.x, f.y - o.y) < o.r * 0.85) bad++;
      r(bad);
    }, 2500);
  })`);
  check('鱼不会卡在石头/芦苇里', stuck === 0, stuck);
  check('改水下植物浓度会重烘背景', await ev(`(()=>{const a=__moyu.state.bg;
    document.getElementById('weed').value=0.0;
    document.getElementById('weed').dispatchEvent(new Event('input',{bubbles:true}));
    return __moyu.cfg.weed===0 && __moyu.state.bg!==a})()`));

  console.log('== 小动物 ==');
  // 蝴蝶是日行的：月夜里收翅不飞、状态机不动，所以先切到正午再测
  await ev(`(()=>{const el=document.getElementById('scene');el.value='noon';
    el.dispatchEvent(new Event('input',{bubbles:true}));return null})()`);
  check('石头上趴着乌龟（大石头两只、小石头一只）', await ev(`__moyu.state.turtles.length>=3`),
    await ev(`__moyu.state.turtles.length`));
  check('乌龟都在自己那块石头的范围内', await ev(`(()=>{
    return __moyu.state.turtles.every(t=>{
      const p=t.pos(__moyu.world), r=t.rock, w=r.s*__moyu.world.w;
      return Math.hypot(p.x-r.x*__moyu.world.w, p.y-r.y*__moyu.world.h) < w*0.5})})()`));
  // 不能用"涟漪总数前后对比"：1.4 秒窗口里旧涟漪会到期消失，总数反而变少。
  // 改成按位置找——滑水那圈一定打在乌龟入水点附近。
  const slip = await ev(`new Promise(r=>{
    const t=__moyu.state.turtles[0];
    t.state='bask'; t.t=30; t.slip=0;      // 测的是"惊动->滑水->涟漪"这条链，不是调度时机
    const p=t.pos(__moyu.world);
    t.startle();
    setTimeout(()=>{
      const hit=__moyu.state.ripples.some(rr=>Math.hypot(rr.x-p.x,rr.y-p.y)<70);
      r([t.state, hit]);
    },1400)})`);
  check('惊动乌龟会滑进水里并在入水点打出涟漪', slip[0] !== 'bask' && slip[1] === true, slip);
  check('荷叶上有一窝蝌蚪', await ev(`__moyu.state.tadpoleNests.length>=2 && __moyu.state.tadpoleNests.every(n=>n.list.length>=5)`),
    await ev(`__moyu.state.tadpoleNests.map(n=>n.list.length)`));
  check('蝌蚪不会爬出荷叶', await ev(`new Promise(r=>{
    const nests=__moyu.state.tadpoleNests;
    setTimeout(()=>r(nests.every(n=>n.list.every(td=>Math.hypot(td.u,td.v/0.86)<0.85))),2500)})`));
  check('蝴蝶会降落停留、也会再起飞', await ev(`new Promise(r=>{
    const b=__moyu.state.butterflies[0];
    const tg=__moyu.state.bflyTargets[0];
    b.x=tg.x*innerWidth+110; b.y=tg.y*innerHeight+80;   // 放到目标附近：横穿全池要半分钟，测的是降落逻辑不是巡航
    b.state='approach'; b.target=tg; b.t=99;
    const seen={};
    const iv=setInterval(()=>{seen[b.state]=1},80);
    setTimeout(()=>{clearInterval(iv); r(!!seen.rest)},6000)})`));
  check('蝴蝶停落点真的在荷花/荷叶上', await ev(`(()=>{
    const b=__moyu.state.butterflies.find(x=>x.state==='rest');
    if(!b) return true;   // 这一刻没停着的就算了，上面那条已验过状态机
    const t=b.target;
    return Math.hypot(b.x-t.x*__moyu.world.w, b.y-t.y*__moyu.world.h)<12})()`));

  console.log('== 场景氛围 ==');
  const setScene = name => ev(`(()=>{const el=document.getElementById('scene');el.value='${name}';
    el.dispatchEvent(new Event('input',{bubbles:true})); return __moyu.state.scene})()`);
  check('切到月夜：场景生效且萤火虫出现', await (async () => {
    const sc = await setScene('night');
    await new Promise(r => setTimeout(r, 400));
    const n = await ev(`[__moyu.state.fireflies.length, __moyu.state.petals.length, __moyu.state.mists.length]`);
    return sc === 'night' && n[0] === 9;
  })(), await ev(`[__moyu.state.scene,__moyu.state.fireflies.length]`));
  check('切到清晨：薄雾和落花数量对', await (async () => {
    const sc = await setScene('dawn');
    await new Promise(r => setTimeout(r, 300));
    const n = await ev(`[__moyu.state.mists.length, __moyu.state.petals.length, __moyu.state.fireflies.length]`);
    return sc === 'dawn' && n[0] === 3 && n[1] === 4 && n[2] === 0;
  })());
  check('场景切换会重烘背景', await ev(`(()=>{const a=__moyu.state.bg;
    const el=document.getElementById('scene');el.value='dusk';
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return __moyu.state.scene==='dusk' && __moyu.state.bg!==a})()`));
  check('跟随时间：小时数映射到正确场景', await ev(`(()=>{
    const f=h=>Sim.sceneForHour(h);
    return f(2)==='night'&&f(6)==='dawn'&&f(12)==='noon'&&f(18)==='dusk'&&f(21)==='night'})()`));
  await setScene('auto');

  console.log('== 水面波动 ==');
  check('扫描线折射的行数跟画质档走', await ev(`__moyu.state.warpRows >= 14`), await ev(`__moyu.state.warpRows`));
  check('波纹光带的平铺图已烘好（512²，四边能接上）', await ev(
    `!!__moyu.state.waveTile && __moyu.state.waveTile.width === 512`));
  const chopTest = await ev(`new Promise(r=>{
    const c=document.getElementById('chop');
    c.value=0; c.dispatchEvent(new Event('input',{bubbles:true}));
    setTimeout(()=>{ const off=__moyu.state.waveAmp;
      c.value=1.0; c.dispatchEvent(new Event('input',{bubbles:true}));
      setTimeout(()=>r([off, __moyu.state.waveAmp]),700); },700)})`);
  check('波动幅度跟着"水面波动"滑杆走（拉到 0 就平了）', chopTest[0] < 0.3 && chopTest[1] > 0.5, chopTest);
  // 光带必须真的在铺，而且是"pattern 整屏填一次"而不是逐块 drawImage：
  // 后者要画满屏幕+一块砖，1920×1080 下两层约 1180 万像素/帧，软件渲染实测 51→33 fps。
  // 降级会把光带淡掉（那是设计行为），所以这里同样按住 autoDrop。
  const chopPainted = await ev(`new Promise(r=>{
    const P=CanvasRenderingContext2D.prototype, orig=P.fillRect; let pat=0;
    P.fillRect=function(){ if(this.fillStyle instanceof CanvasPattern) pat++; return orig.apply(this,arguments)};
    __moyu.cfg.chop=1;
    const iv=setInterval(()=>{__moyu.state.autoDrop=0},100);
    setTimeout(()=>{clearInterval(iv); const on=pat; pat=0; __moyu.cfg.chop=0;
      setTimeout(()=>{P.fillRect=orig; const off=pat; __moyu.cfg.chop=1; r([on,off])},700)},700)})`);
  check('波纹光带每帧真的在铺（拉到 0 就一笔不画）', chopPainted[0] > 10 && chopPainted[1] === 0, chopPainted);

  console.log('== 天气与右下角卡片 ==');
  check('WMO 天气码映射成中文描述与强度', await ev(`(()=>{
    const w=Weather, a=w.info(0), b=w.info(61), c=w.info(75);
    return a.text==='晴' && a.icon==='sun' && b.text==='小雨' && b.rain>0.3 && c.snow>0.5})()`));
  check('断网兜底：本地模拟能给出合理的天气和温度', await ev(`(()=>{
    const s=Weather.simulate(new Date());
    return s.code>=0 && typeof s.temp==='number' && s.temp>-30 && s.temp<50 && s.daily.length===3})()`));
  check('卡片显示城市 / 当前天气 / 三天预报', await ev(`(()=>{
    return document.getElementById('city').textContent.length>0 &&
      /[°℃]/.test(document.getElementById('wtext').textContent) &&
      document.getElementById('fc').children.length===3})()`),
    await ev(`[document.getElementById('city').textContent, document.getElementById('wtext').textContent]`));
  check('卡片是毛玻璃（背景模糊 + 大圆角）', await ev(`(()=>{
    const cs=getComputedStyle(document.querySelector('.card-main'));
    const bf=cs.backdropFilter||cs.webkitBackdropFilter||'';
    return /blur\\(/.test(bf) && parseFloat(cs.borderTopLeftRadius)>10})()`),
    await ev(`getComputedStyle(document.querySelector('.card-main')).backdropFilter`));
  check('卡片贴在右下角', await ev(`(()=>{const r=document.getElementById('card').getBoundingClientRect();
    return r.right>innerWidth-40 && r.bottom>innerHeight-40 && r.left>innerWidth*0.5})()`));
  check('天气导出的一组系数（光照/焦散/风/鱼活性）都在', await ev(`(()=>{const e=__moyu.station.env;
    return ['light','causticK','rippleRate','swayK','chopK','fishSpeed','fishDepth','wind','rain','fog'].every(k=>typeof e[k]==='number')})()`));
  // 注入一场大雨：雨点粒子、水面涟漪、障碍摆动都该跟着变
  const rainy = await ev(`new Promise(r=>{
    Object.assign(__moyu.station.env,{rain:0.9,snow:0,wind:0.8,chopK:1.5,fog:0.3});
    const c=document.getElementById('weatherOn');
    c.checked=false; c.dispatchEvent(new Event('input',{bubbles:true}));
    c.checked=true; c.dispatchEvent(new Event('input',{bubbles:true}));
    setTimeout(()=>r([__moyu.state.rain.length, __moyu.state.ripples.length, __moyu.state.autoDrop<0.5]),1800)})`);
  check('下雨：雨点粒子出现、水面被打出涟漪', rainy[0] > 60 && rainy[1] >= 1, rainy);
  await ev(`(()=>{const e=__moyu.station.env; e.rain=0; e.snow=0; e.fog=0;
    const c=document.getElementById('weatherOn'); c.checked=false; c.dispatchEvent(new Event('input',{bubbles:true}));
    c.checked=true; c.dispatchEvent(new Event('input',{bubbles:true})); return null})()`);

  console.log('== 我的锦鲤（画板）==');
  // 面板分页之后画板搬进了"我的锦鲤"这一页。折叠用的是 display:none（只有这样才能把高度
  // 让出来、取消滚动条），而 display:none 的元素 rect 全是 0 —— 坐标换算、图层叠加、
  // 像素取样都会失真。所以先把这一页切出来再测，就跟人手点一下是一样的。
  await ev(`(()=>{HUD.togglePanel(true); HUD.openTab('koi'); return null})()`);
  check('画板两层是叠着的（漏 CSS 类会变成上下排列、涂色看不见）', await ev(`(()=>{
    const st=document.getElementById('pStage');
    if(!st || st.children.length<2) return false;
    const a=st.children[0].getBoundingClientRect(), b=st.children[1].getBoundingClientRect();
    return Math.abs(a.left-b.left)<2 && Math.abs(a.top-b.top)<2 && a.width>40})()`));

  // 参考层现在不是"一片白"了（它带鱼鳍、鳍条、眼睛），所以不能再用"参考层几乎没有深色
  // 像素"来判断；直接比前后差分更硬：参考层必须一个像素都不动。
  const rndDiff = await ev(`(()=>{
    const st=document.getElementById('pStage'), ref=st.children[0], ink=st.children[1];
    const grab=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const br=grab(ref), bi=grab(ink);
    Paint.randomPattern();
    const ar=grab(ref), ai=grab(ink);
    const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4){
      if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])n++}return n};
    return [diff(br,ar), diff(bi,ai)]})()`);
  check('随机花纹画在涂色层上（参考层一个像素都不动）', rndDiff[0] === 0 && rndDiff[1] > 2000, rndDiff);

  // 参数化轮廓：拖滑杆参考层要重画（不是拉伸位图），且胖瘦/尾长各自有效
  const shape = await ev(`(()=>{
    const ref=document.getElementById('pStage').children[0];
    const area=()=>{const d=ref.getContext('2d').getImageData(0,0,ref.width,ref.height).data;
      let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>16) n++; return n};
    const fat=document.getElementById('pFat'), tail=document.getElementById('pTail');
    fat.value=0.05; fat.dispatchEvent(new Event('input',{bubbles:true})); const thin=area();
    fat.value=1;    fat.dispatchEvent(new Event('input',{bubbles:true})); const chubby=area();
    tail.value=0;   tail.dispatchEvent(new Event('input',{bubbles:true})); const stub=area();
    tail.value=1;   tail.dispatchEvent(new Event('input',{bubbles:true})); const long=area();
    return [thin, chubby, stub, long]})()`);
  check('身体轮廓滑杆真的在改鱼形（细↔胖 面积差 1.5 倍以上）',
    shape[0] > 0 && shape[1] > shape[0] * 1.5, shape);
  check('尾部长度滑杆真的在改鱼形', shape[2] !== shape[3] && Math.abs(shape[2] - shape[3]) > 200, shape);

  const mine = await ev(`(()=>{ const sp=Paint.apply();
    return [!!Sprites.assets.koi.koi_custom, sp.width, sp.height,
            Sprites.assets.koi.koi_custom ? Sprites.assets.koi.koi_custom.atlas.canvas.width : 0]})()`);
  check('放入鱼池后注册成第 6 种鱼并烘好摆尾图集', mine[0] && mine[3] > 1000, mine);
  await sleep(500);
  check('鱼群里出现了"我的锦鲤"（不重建鱼群，只换掉一部分）', await ev(
    `__moyu.state.fishes.some(f=>f.kind==='koi_custom')`),
    await ev(`__moyu.state.fishes.filter(f=>f.kind==='koi_custom').length`));
  check('关掉开关后它换回内置花色', await ev(`(()=>{
    const c=document.getElementById('customFish'); c.checked=false; c.dispatchEvent(new Event('input',{bubbles:true}));
    return !Sprites.assets.koi.koi_custom && !__moyu.state.fishes.some(f=>f.kind==='koi_custom')})()`));
  await ev(`(()=>{const c=document.getElementById('customFish'); c.checked=true;
    c.dispatchEvent(new Event('input',{bubbles:true})); return null})()`);

  // 涂色是"raw 离屏 + 按鱼形裁一刀"两层：出界的笔迹在预览上必须看不见。
  // 放在 apply() 之后 —— 得先有一条设计，笔迹才谈得上"存进它"。
  // 鱼尾最高只到 0.32*CH，所以 0.06 高度那一带一定是空白，落笔点安全。
  const clip = await ev(`new Promise(r=>{
    const ink=document.getElementById('pStage').children[1];
    const rect=ink.getBoundingClientRect();
    const at=(fx,fy)=>({clientX:rect.left+rect.width*fx, clientY:rect.top+rect.height*fy});
    const fire=(type,p)=>ink.dispatchEvent(new PointerEvent(type,{
      clientX:p.clientX, clientY:p.clientY, bubbles:true, pointerId:1, isPrimary:true}));
    fire('pointerdown', at(0.06,0.06));
    fire('pointermove', at(0.24,0.06));
    fire('pointerup',   at(0.24,0.06));
    setTimeout(()=>{                       // 等 dirty 的 500ms 落盘
      const shown=ink.getContext('2d').getImageData(ink.width*0.15, ink.height*0.06, 1,1).data[3];
      const im=new Image();
      im.onload=()=>{
        const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
        c.getContext('2d').drawImage(im,0,0);
        const raw=(Paint.current()||{}).ink||'';
        const rawA=c.getContext('2d').getImageData(c.width*0.15, c.height*0.06, 1,1).data[3];
        r([shown, rawA, raw.slice(0,15)]);
      };
      im.onerror=()=>r([shown,-1,'load-fail']);
      im.src=(Paint.current()||{}).ink||'';
    }, 800)})`);
  check('涂出鱼身的笔迹：原始层留着、预览层被裁掉', clip[0] === 0 && clip[1] > 0, clip);


  const named = await ev(`(()=>{
    document.getElementById('pRandName').click();
    const rnd=document.getElementById('pName').value;
    const nm=document.getElementById('pName');
    nm.value='小张的鱼'; nm.dispatchEvent(new Event('input',{bubbles:true}));
    const d=Paint.current();
    return [rnd, d && d.name, nm.maxLength]})()`);
  check('起名：随机起名能给名字、手打的写进设计、最多 16 字',
    named[0].length > 0 && named[1] === '小张的鱼' && named[2] === 16, named);

  // 画廊：再加一条 → 两条自定义鱼同时在池子里，但自定义鱼总占比还是约 9%
  const two = await ev(`(()=>{
    document.getElementById('pNew').click();
    Paint.randomPattern();
    const nm=document.getElementById('pName');
    nm.value='第二条'; nm.dispatchEvent(new Event('input',{bubbles:true}));
    const fat=document.getElementById('pFat');
    fat.value=1; fat.dispatchEvent(new Event('input',{bubbles:true}));
    Paint.apply();
    return [Sprites.customKinds().length, Sprites.customKinds().slice().sort(),
            document.querySelectorAll('#pGal .p-item[data-id]').length]})()`);
  check('画廊能再加一条并同时进池', two[0] === 2 && two[2] === 2, two);
  await sleep(700);
  const both = await ev(`(()=>{
    const k=Sprites.customKinds();
    return [k.every(x=>__moyu.state.fishes.some(f=>f.kind===x)),
            k.map(x=>[x, __moyu.state.fishes.filter(f=>f.kind===x).length])]})()`);
  check('两条自定义鱼都真的游在池子里', both[0], both[1]);
  const share = await ev(`(()=>{
    const n=__moyu.state.fishes.filter(f=>f.mine).length;
    return [n, __moyu.state.fishes.length, +(n/__moyu.state.fishes.length).toFixed(3)]})()`);
  check('自定义鱼总数仍只占约 9%（加鱼不会把它堆满）', share[2] > 0.03 && share[2] < 0.16, share);

  check('v2 存档：带版本号 / 名字 / 几何参数 / 涂色图',
    await ev(`(()=>{const o=JSON.parse(localStorage.getItem('moyu-pond:koi:v2')||'{}');
      const d=(o.list||[])[0]||{};
      return [o.v, (o.list||[]).length, d.name, typeof d.fat, typeof d.tail,
              typeof d.ink==='string' && d.ink.indexOf('data:image/png')===0]})()`)
      .then(a => a[0] === 2 && a[1] === 2 && a[2] === '小张的鱼' && a[3] === 'number' && a[4] === 'number' && a[5]),
    await ev(`(()=>{const o=JSON.parse(localStorage.getItem('moyu-pond:koi:v2')||'{}');
      return {v:o.v, n:(o.list||[]).length, names:(o.list||[]).map(d=>d.name)}})()`));

  // 删一条：池子里它的鱼换回内置花色，图集也真的释放（一条约 2.5MB，8 条就是 20MB）
  const gone = await ev(`(()=>{
    const doomed=Sprites.customKinds()[1];
    const before=Sprites.customKinds().length;
    Paint.remove(doomed.slice('koi_custom_'.length));
    return [before, Sprites.customKinds().length, !!Sprites.assets.koi[doomed],
            document.querySelectorAll('#pGal .p-item[data-id]').length,
            __moyu.state.fishes.some(f=>f.kind===doomed)]})()`);
  check('删一条会换回内置花色并释放它的图集',
    gone[0] === 2 && gone[1] === 1 && gone[2] === false && gone[3] === 1 && gone[4] === false, gone);

  // 真刷新一次。hud.js 建面板的时机早于 Paint.boot()（素材后加载），
  // 所以恢复完必须主动刷界面 —— 不刷的话画廊是空的，用户得点一下才看得见自己的鱼。
  await send('Page.reload');
  await sleep(7000);
  const re = await ev(`(()=>{
    const box=document.querySelector('#pGal');
    return [document.body.classList.contains('ready'),
            Paint.designs().length, Sprites.customKinds().length,
            box ? box.querySelectorAll('.p-item[data-id]').length : -1,
            document.getElementById('pName').value,
            __moyu.state.fishes.some(f=>f.mine)]})()`);
  check('刷新后画好的鱼还在：画廊、名字、进池一起恢复',
    re[0] && re[1] === 1 && re[2] === 1 && re[3] === 1 && re[4].length > 0 && re[5], re);

  console.log('== 时钟 / 下班倒计时 ==');
  const cd = await ev(`(()=>{const D=MoyuHUD.DEFAULTS;const mk=(hh,mm,day)=>{const d=new Date(2026,8,day,hh,mm,0);d.setHours(hh,mm,0);return d};
    const cfg=Object.assign({},D,{workStart:'09:00',workEnd:'18:00',lunchStart:'12:00',lunchEnd:'13:30',useLunch:true,workdaysOnly:false});
    const wk=(h,m)=>MoyuHUD.countdown(cfg,new Date(2026,8,28,h,m,0));   // 周一
    return {early:wk(8,0), morning:wk(10,30), lunch:wk(12,30), after:wk(14,0), late:wk(18,30),
            sat:MoyuHUD.countdown(Object.assign({},cfg,{workdaysOnly:true}),new Date(2026,8,26,10,0)),
            bad:MoyuHUD.countdown(Object.assign({},cfg,{workEnd:'00:00'}),new Date(2026,8,28,10,0))}})()`);
  const C = o => (o && o.text) || '(无)';
  check('上班前 → 距上班', /距上班/.test(C(cd.early)), cd.early);
  check('上午 → 距下班且进度在 0~1', /距下班/.test(C(cd.morning)) && cd.morning && cd.morning.pct > 0 && cd.morning.pct < 1, cd.morning);
  check('午休中 → 提示午休', /午休/.test(C(cd.lunch)), cd.lunch);
  check('午休后进度 > 午休前', cd.after && cd.lunch && cd.after.pct > cd.lunch.pct, [cd.after && cd.after.pct, cd.lunch && cd.lunch.pct]);
  check('过了下班点 → 已经下班', /已经下班/.test(C(cd.late)), cd.late);
  check('勾了周末不计时 → 周六显示今天不上班', /今天不上班/.test(C(cd.sat)), cd.sat);
  check('时间设置非法时不崩', typeof C(cd.bad) === 'string' && C(cd.bad).length > 0, cd.bad);
  check('时钟文本正确', await ev(`(()=>{const d=new Date();return document.getElementById('clock').textContent===
    (String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'))})()`));

  console.log('== 响应式 / 稳定性 ==');
  const kInvariant = () => ev(`(()=>{
    const k = Math.max(0.6, Math.min(1.7, innerWidth / 1920));
    return Math.abs(__moyu.world.k - k) < 1e-6 &&
           __moyu.state.fishes.every(f => Math.abs(f.len / f.lenBase - k) < 1e-6);
  })()`);
  check('鱼体长随视口宽度等比缩放', await kInvariant());
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  check('换到小窗口后缩放比例仍然成立', await kInvariant());
  check('缩小窗口后画面跟着缩放', await ev(`__moyu.world.w===1024 && __moyu.state.bg.width>0`),
    await ev(`[__moyu.world.w, __moyu.state.bg.width]`));
  check('没有鱼被甩出画面外', await ev(`__moyu.state.fishes.every(f=>f.x>-60&&f.y>-60&&f.x<__moyu.world.w+60&&f.y<__moyu.world.h+60)`));
  // 面板比卡片宽（画板那块挤在 320px 里会全变成换行），所以窄屏上必须自己收窄，
  // 不能因为"锚在右下角、向左长"就把左边的字切出屏幕。
  // 得真的缩到比面板还窄才有意义：1024 宽下面板（420）根本没被挤到。
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const narrow = await ev(`(()=>{
    const p=document.getElementById('panel');
    if(!p.classList.contains('open')) document.getElementById('gear').click();
    const r=p.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.right), innerWidth,
            document.documentElement.scrollWidth]})()`);
  check('窄屏下面板收窄到视口内（不横向溢出）',
    narrow[0] >= 0 && narrow[1] <= narrow[2] + 1 && narrow[3] <= narrow[2] + 1, narrow);
  await ev(`(function(){const g=document.getElementById('gear'); if(document.getElementById('panel').classList.contains('open')) g.click(); return null})()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  check('恢复尺寸后仍在跑', await ev(`new Promise(r=>{const a=__moyu.state.fishes[0].x;setTimeout(()=>r(Math.abs(__moyu.state.fishes[0].x-a)>0.2),350)})`));
  check('全程没有 JS 报错', errs.length === 0, errs.slice(0, 4));

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}: ${pass} 通过 / ${fail} 失败`);
  ws.close(); proc.kill(); process.exit(fail === 0 ? 0 : 1);
})();
