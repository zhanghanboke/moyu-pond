// mem.js —— 量一下常驻纹理内存：壁纸是 24 小时不关的进程，这项必须看。
// 用法: node tools/mem.js [url]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338;
const url = process.argv[2] || 'http://127.0.0.1:8765/?fresh=1';
const setup = process.argv[3] || '';   // 先跑的布置表达式，比如画一条自定义锦鲤
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const PROBE = `(() => {
  const B = (w, h) => w * h * 4;
  let base = 0, decor = 0, atl = 0, sil = 0;
  base += B(Sprites.assets.base.width, Sprites.assets.base.height);
  for (const d of Object.values(Sprites.assets.decor)) decor += B(d.width, d.height);
  for (const rec of Object.values(Sprites.assets.koi)) {
    atl += B(rec.atlas.canvas.width, rec.atlas.canvas.height);
    if (rec.sil) sil += B(rec.sil.canvas.width, rec.sil.canvas.height);
  }
  const bg = B(__moyu.state.bg.width, __moyu.state.bg.height);
  const ca = B(__moyu.state.causticTile.width, __moyu.state.causticTile.height);
  const wv = __moyu.state.waveTile ? B(__moyu.state.waveTile.width, __moyu.state.waveTile.height) : 0;
  const cv = B(document.getElementById('pond').width, document.getElementById('pond').height);
  const mb = x => (x / 1048576).toFixed(1);
  // 摆尾图集那一项：画过自定义锦鲤的话，里面已经含了第 6 种鱼的图集
  return JSON.stringify({ 底图: mb(base), 装饰: mb(decor), 摆尾图集: mb(atl),
    鱼影剪影: mb(sil), 背景缓存: mb(bg), 光斑: mb(ca), 波光砖: mb(wv), 画布: mb(cv),
    锦鲤种类: Object.keys(Sprites.assets.koi).length,
    合计常驻MB: mb(base+decor+atl+sil+bg+ca+wv+cv) });
})()`;

(async () => {
  const profile = fs.mkdtempSync(os.tmpdir() + '/moyu-mem-');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--disable-gpu', '--no-sandbox',
    '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(400);
    try { const t = await getJSON('/json/list'); page = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (e) { }
  }
  if (!page) { console.log('连不上 Chrome'); proc.kill(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(6000);
  if (setup) { await send('Runtime.evaluate', { expression: setup, awaitPromise: true, returnByValue: true }); await sleep(1500); }
  const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log('探测失败:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  else {
    const o = JSON.parse(r.result.value);
    console.log('== 常驻纹理内存 ==');
    for (const [k, v] of Object.entries(o)) console.log(`  ${k.padEnd(10)} ${v}`);
    console.log('  (自定义锦鲤算在"摆尾图集"里：一条约 +2.5MB，靠"锦鲤种类"能看出有几条)');
  }
  ws.close(); proc.kill(); process.exit(0);
})();
