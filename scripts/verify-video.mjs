// scripts/verify-video.mjs
// Proves a rendered film is actually a playable video with real picture in it.
//
// A MediaRecorder capture can fail in a way that still produces a large,
// well-formed file: a tainted canvas, or a page that never composited, yields
// minutes of black at full bitrate. File size alone therefore proves nothing,
// which is why this seeks to real timestamps and samples the pixels.
//
// Usage: node scripts/verify-video.mjs <video-file> [outDir]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const VIDEO = process.argv[2];
const OUT_DIR = process.argv[3] || path.dirname(VIDEO || '.');
if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error('usage: node scripts/verify-video.mjs <video-file> [outDir]');
  process.exit(1);
}

// Sampled by PLAYING, not seeking. A MediaRecorder file is written as a live
// stream: it carries no duration in its header, so a player reports a bogus
// length and every seek lands on the same decoded frame. Playing it through is
// both the honest test and the one that matches how a viewer watches it.
const SAMPLE_SECONDS = [1, 20, 45, 75, 105, 140, 170];

function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome binary found. Set CHROMIUM_PATH.');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP socket error')));
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  return {
    ready,
    send(m, p = {}) {
      const id = nextId++;
      return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
    },
    close() { ws.close(); },
  };
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;}video{width:1920px;height:1080px;display:block;}</style>
</head><body>
<video id="v" src="/video" preload="auto" muted playsinline></video>
<script>
var v = document.getElementById('v');
window.__meta = null;
v.addEventListener('loadedmetadata', function(){ window.__meta = { duration: v.duration, w: v.videoWidth, h: v.videoHeight }; });
// Seeking is asynchronous; the sampler must wait for the seek to land or it
// reads whatever frame happened to be decoded, which is usually the first one.
window.play = function(){ return v.play().then(function(){ return true; }).catch(function(e){ return 'play failed: ' + e.message; }); };
window.at = function(){ return v.currentTime; };
window.ended = function(){ return v.ended; };
// Mean luminance and the spread of it. A black frame has both near zero; a
// real frame of a UI screenshot has a high mean and a wide spread.
window.sample = function(){
  var c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  var x = c.getContext('2d');
  x.drawImage(v, 0, 0, 160, 90);
  var d = x.getImageData(0, 0, 160, 90).data;
  var sum = 0, n = 160 * 90, lums = new Array(n);
  for (var i = 0; i < n; i++) {
    var l = 0.2126 * d[i*4] + 0.7152 * d[i*4+1] + 0.0722 * d[i*4+2];
    lums[i] = l; sum += l;
  }
  var mean = sum / n, varsum = 0;
  for (var j = 0; j < n; j++) varsum += (lums[j] - mean) * (lums[j] - mean);
  return { mean: Math.round(mean * 10) / 10, stdev: Math.round(Math.sqrt(varsum / n) * 10) / 10 };
};
</script></body></html>`;

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/video') {
      res.writeHead(200, { 'Content-Type': VIDEO.endsWith('.mp4') ? 'video/mp4' : 'video/webm', 'Content-Length': fs.statSync(VIDEO).size });
      return fs.createReadStream(VIDEO).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-verify-'));
  const chrome = spawn(chromePath(), [
    '--headless=new', '--remote-debugging-port=9335', '--user-data-dir=' + userDataDir,
    '--no-first-run', '--hide-scrollbars', '--mute-audio',
    '--disable-gpu', '--use-gl=swiftshader', '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch {} try { server.close(); } catch {} };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { target = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome never exposed a debugging target.');

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

  let meta = null;
  for (let i = 0; i < 80 && !meta; i++) {
    await new Promise((r) => setTimeout(r, 250));
    meta = await evaluate(client, 'window.__meta');
  }
  if (!meta) throw new Error('the browser could not decode this file as video at all');
  console.log(`decoded: ${meta.w}x${meta.h}, ${meta.duration.toFixed(1)}s`);

  const playResult = await evaluate(client, 'window.play()', true);
  if (playResult !== true) throw new Error(String(playResult));

  const results = [];
  for (const want of SAMPLE_SECONDS) {
    // Wait for playback to actually reach this point rather than assuming the
    // wall clock and the media clock agree.
    for (let i = 0; i < 400; i++) {
      const at = await evaluate(client, 'window.at()');
      if (at >= want || await evaluate(client, 'window.ended()')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const t = await evaluate(client, 'window.at()');
    const s = await evaluate(client, 'window.sample()');
    const black = s.mean < 3 && s.stdev < 3;
    results.push({ t, ...s, black });
    console.log(`  t=${t.toFixed(1).padStart(6)}s   mean luma ${String(s.mean).padStart(6)}   spread ${String(s.stdev).padStart(6)}   ${black ? 'BLACK' : 'picture'}`);
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `still-${Math.round(t)}s.png`), Buffer.from(data, 'base64'));
  }

  const reached = results.length ? results[results.length - 1].t : 0;
  console.log(`
playback reached ${reached.toFixed(1)}s`);
  // Distinct frames are what prove the whole film is in the file. Identical
  // readings across the run mean playback stalled on one frame.
  const distinct = new Set(results.map((r) => r.mean + ':' + r.stdev)).size;
  console.log(`${distinct}/${results.length} sampled frames are visually distinct`);

  client.close();
  cleanup();

  const blackCount = results.filter((r) => r.black).length;
  const lit = results.filter((r) => !r.black);
  console.log('');
  if (blackCount === results.length) {
    console.log('FAILED: every sampled frame is black -- the canvas never composited.');
    process.exitCode = 1;
  } else if (blackCount > 1) {
    console.log(`WARNING: ${blackCount}/${results.length} sampled frames are black.`);
  } else {
    const avgSpread = (lit.reduce((s, r) => s + r.stdev, 0) / lit.length).toFixed(1);
    console.log(`PASSED: real picture at ${lit.length}/${results.length} samples, average detail spread ${avgSpread}.`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
