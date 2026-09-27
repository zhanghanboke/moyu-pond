// shotx.js —— 带脚本注入的截图：先跑一段 JS 布置场景，再抓帧。
// 用法: node tools/shotx.js 输出.png [宽] [高] [url] ["布置表达式"]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const [, , out = '.tmp.png', w = '1920', h = '1080',
  url = 'http://127.0.0.1:8765/?fresh=1', setup = ''] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  const profile = fs.mkdtempSync(os.tmpdir() + '/moyu-shotx-');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--disable-gpu', '--no-sandbox',
    `--window-size=${w},${h}`, '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

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
  const ev = expression => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(5200);
  if (setup) await ev(setup);
  await sleep(+(process.env.WAIT || 1400));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved ->', out, fs.statSync(out).size);
  ws.close(); proc.kill(); process.exit(0);
})();
