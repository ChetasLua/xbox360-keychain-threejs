#!/usr/bin/env node
// Headless-Chrome frame capture for the film (zero dependencies, Node >= 22).
//   node tools/capture.mjs --frames 0:390:1 --out out/frames [--w 1440 --h 1080] [--page index.html] [--q png|jpg] [--wav out/sound.wav]
// Serves the repo over http, opens the page with ?capture=1, waits for window.__READY,
// then for each frame calls `await window.__renderFrame(n)` and screenshots the viewport.
// Console messages are written to <out>/console.log. Chrome runs on the real GPU (ANGLE/Metal on macOS).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const LIST = arg('list', '') ? arg('list').split(',').map(Number) : null; // --list 80,112,160
const [fa, fb, fs_] = arg('frames', '0:1:1').split(':').map(Number);
const OUT = path.resolve(arg('out', path.join(ROOT, 'out/frames')));
const W = +arg('w', 1440), H = +arg('h', 1080);
const PAGE = arg('page', 'index.html');
const EXTRA = arg('query', '');
const FMT = arg('q', 'png');
const WAV = arg('wav', '');
const LIVE = process.argv.includes('--live'); // smoke-test the interactive player instead of capturing
const TIMEOUT = +arg('timeout', 180000);
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'x360cap-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--hide-scrollbars', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--force-device-scale-factor=1'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = ''; const to = setTimeout(() => rej(new Error('chrome start timeout')), 20000);
  chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
let nextId = 1; const pending = new Map(); const listeners = new Set();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.to); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else for (const l of listeners) l(m);
});
function send(method, params = {}, sessionId, ms = TIMEOUT) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, ms);
    pending.set(id, { res, rej, to });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const logLines = [];
const cleanup = () => { try { chrome.kill('SIGTERM'); } catch {} server.close(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  listeners.add(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled') logLines.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logLines.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  const url = LIVE ? `http://127.0.0.1:${PORT}/${PAGE}` : `http://127.0.0.1:${PORT}/${PAGE}?capture=1&w=${W}&h=${H}${EXTRA ? '&' + EXTRA : ''}`;
  await send('Page.navigate', { url }, sessionId);
  const ev = async (expr, ms) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const t0 = Date.now();
  if (LIVE) {
    const shot = async (n) => fs.writeFileSync(path.join(OUT, n), Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 }, sessionId)).data, 'base64'));
    await new Promise(r => setTimeout(r, 7000)); await shot('live_start.jpg');
    await ev("document.querySelector('#start .play') && document.querySelector('#start .play').click(), true");
    await new Promise(r => setTimeout(r, 4000)); await shot('live_play.jpg');
    console.log('live', await ev('JSON.stringify({err: window.__ERROR || null, info: window.__INFO || null})'));
    throw new Error('__live_done__');
  }
  while (true) {
    const st = await ev('JSON.stringify({ready: !!window.__READY, err: window.__ERROR || null})', 10000).catch(() => '{}');
    const s = JSON.parse(st || '{}');
    if (s.err) throw new Error('page error: ' + s.err);
    if (s.ready) break;
    if (Date.now() - t0 > TIMEOUT) throw new Error('timeout waiting for __READY');
    await new Promise(r => setTimeout(r, 250));
  }
  const info = await ev('JSON.stringify(window.__INFO || {})');
  console.log('ready in', Date.now() - t0, 'ms', info);
  const times = [];
  const frames = LIST || Array.from({ length: Math.max(0, Math.ceil((fb - fa) / fs_)) }, (_, i) => fa + i * fs_);
  for (const f of frames) {
    const t1 = Date.now();
    await ev(`window.__renderFrame(${f})`);
    const shot = await send('Page.captureScreenshot', { format: FMT === 'jpg' ? 'jpeg' : 'png', quality: FMT === 'jpg' ? 95 : undefined }, sessionId);
    fs.writeFileSync(path.join(OUT, `f_${String(f).padStart(3, '0')}.${FMT}`), Buffer.from(shot.data, 'base64'));
    times.push(Date.now() - t1);
  }
  if (WAV) {
    const b64 = await ev('window.__exportWav ? window.__exportWav() : null', TIMEOUT);
    if (b64) fs.writeFileSync(WAV, Buffer.from(b64, 'base64'));
  }
  console.log('frames', times.length, 'avg ms', Math.round(times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1)));
} catch (e) {
  if (e.message !== '__live_done__') { console.error('CAPTURE FAILED:', e.message); process.exitCode = 1; }
} finally {
  fs.writeFileSync(path.join(OUT, 'console.log'), logLines.join('\n'));
  if (logLines.some(l => l.startsWith('[error]') || l.startsWith('[exception]'))) console.log('console errors:\n' + logLines.filter(l => /^\[(error|exception)\]/.test(l)).slice(0, 20).join('\n'));
  cleanup();
  process.exit();
}
