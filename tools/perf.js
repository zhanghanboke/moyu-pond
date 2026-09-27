// perf.js —— 用 CDP 起一个真实浏览器跑几秒，量实际帧率。
// 无头截图用的是 virtual time，量不出真 FPS，所以单独走 CDP。
// 用法: node tools/perf.js [url] [鱼数量]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const url = process.argv[2] || 'http://127.0.0.1:8765/?fresh=1';
const count = +(process.argv[3] || 0);
const secs = +(process.argv[4] || 5);
const setup = process.argv[5] || '';   // 先跑的布置表达式，比如改设置

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  const profile = fs.mkdtempSync(os.tmpdir() + '/moyu-perf-');
  // MOYU_GPU=1 时用真实 GPU 光栅化（更接近用户桌面），默认软件渲染，数字更悲观
  const gpu = process.env.MOYU_GPU === '1';
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    ...(gpu ? ['--use-angle=d3d11'] : ['--disable-gpu']),
    '--no-sandbox', '--window-size=1920,1080',
    '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(500);
    try {
      const t = await getJSON('/json/list');
      page = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.log('连不上 Chrome DevTools'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => { ws.onopen = r; });
  const ev = expression => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(4500);                                  // 等素材加载完
  if (count) await ev(`__moyu.setCount(${count})`);
  if (setup) await ev(setup);
  await sleep(1200);

  if (process.env.MOYU_EVAL) {          // 直接跑一段表达式并打印，用来做微基准
    const one = await ev(process.env.MOYU_EVAL);
    console.log(one.exceptionDetails
      ? 'EVAL 报错: ' + (one.exceptionDetails.exception?.description || one.exceptionDetails.text)
      : JSON.stringify(one.result.value));
    ws.close(); proc.kill(); process.exit(0);
  }
  const out = await ev(`new Promise(r=>{
    let n=0,t0=performance.now(),last=t0,worst=0;
    (function f(){const now=performance.now();worst=Math.max(worst,now-last);last=now;n++;
      if(now-t0<${secs * 1000})requestAnimationFrame(f);
      else r(JSON.stringify({fps:+(n/((now-t0)/1000)).toFixed(1), worstFrameMs:+worst.toFixed(1),
                             fish:__moyu.state.fishes.length, ripples:__moyu.state.ripples.length,
                             drop:+__moyu.state.autoDrop.toFixed(2), dpr:__moyu.world.dpr}));})()})`);
  console.log(out.result.value);
  ws.close(); proc.kill(); process.exit(0);
})();
