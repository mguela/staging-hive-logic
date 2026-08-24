// scripts/render-commercial.mjs
// Renders the HiveLogic product film to a real video file, locally.
//
// This is the SAME renderer the product ships (public/reel-studio.js) driven
// by the same inputs the Content Studio would give it -- the point being that
// the film is not made by a separate one-off pipeline. If this produces a good
// cut, so does the button in the app.
//
// Chrome is driven over raw CDP (see capture-commercial-frames.mjs for why not
// Playwright). The finished blob is handed to Chrome's own download machinery
// rather than base64'd back through the debugger: a 3-minute 1080p file is
// well over a hundred megabytes, and moving that through a single
// Runtime.evaluate return value is a good way to hang the socket.
//
// Usage:
//   node scripts/render-commercial.mjs [framesDir] [outDir] [voiceMp3]
//
// voiceMp3 is optional. Without it the film renders silent, timed to the
// script's own word count -- the picture edit is final either way, and the
// narration drops in when a deployment with OPENAI_API_KEY records it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FRAMES_DIR = process.argv[2] || path.join(ROOT, 'commercial-frames');
const OUT_DIR = process.argv[3] || path.join(ROOT, 'commercial-out');
const VOICE_MP3 = process.argv[4] || null;

// The film, in the shape the shipped renderer expects. Lifted verbatim from
// HIVELOGIC-COMMERCIAL-SCRIPT.md -- if the two ever disagree, the markdown is
// the script and this is the bug.
const SCRIPT = {
  hook: 'It is 6:41 in the morning. And you are already behind.',
  beats: [
    // Frames are the nine the capture step marked usable. The three views that
    // render empty against the offline harness (finances, marketing, connect)
    // are deliberately absent -- an empty panel on screen would undercut every
    // claim the narration is making over it.
    //
    // The Command Center opens the film and closes it. Coming back to the same
    // frame for the kicker is the point: the thing that made this film is the
    // thing you were looking at three minutes ago.
    { frame: '01-command-center.png', onScreenText: 'One system. The whole company.',
      say: 'Every piece of software you have ever bought promised to fix this. And every one of them just gave you one more place to type. What if it worked the other way around? This is HiveLogic. One system that runs the whole company. Not another tab. The whole company.' },
    { frame: '02-schedule.png', onScreenText: 'The schedule builds itself',
      say: 'The schedule builds itself around where your trucks actually are.' },
    { frame: '03-jobs.png', onScreenText: 'Every job. Every margin.',
      say: 'Every job, every margin, every crew, on one board that tells you what is at risk before it goes wrong.' },
    { frame: '05-estimates.png', onScreenText: 'Priced before you leave',
      say: 'The estimate goes out before you get back to the truck.' },
    { frame: '12-takeoff.png', onScreenText: 'Measured off the plan',
      say: 'Takeoffs get measured straight off the drawing, and priced the way you actually price work.' },
    { frame: '06-invoices.png', onScreenText: 'Invoiced. Chased. Paid.',
      say: 'The invoice follows the work. Nobody has to remember to send it, and nobody has to remember to chase it.' },
    { frame: '08-pnl.png', onScreenText: 'The books close themselves',
      say: 'A photo of a receipt becomes a posted entry. Coded, matched, reconciled. Purchase orders match themselves. The books close. Payroll runs.' },
    { frame: '04-clients.png', onScreenText: 'Reina finds the money',
      say: 'Her name is Reina. She reads every job, every invoice, every message, and she does not wait to be asked. Monday morning she tells you where the money actually is. The estimates nobody followed up on. The customers who quietly stopped calling. And she has already drafted the campaign.' },
    { frame: '10-reports.png', onScreenText: '39 days old',
      say: 'Here is the part that should worry your competition. HiveLogic is thirty-nine days old. Two thousand commits. Two hundred and forty tables. Four thousand tests, passing. It got better while you were watching this.' },
    { frame: '01-command-center.png', onScreenText: 'HiveLogic made this film',
      say: 'One more thing. This commercial. The script. The voice you are listening to right now. The edit, the timing, the words on screen. HiveLogic made it. That was one afternoon of work. Imagine what it does with your company.' },
  ],
  caption: 'HiveLogic - run the whole thing.',
  hashtags: [],
};

// 358 words at the scripted 119 wpm read. Stated rather than derived so the
// picture edit does not silently change length if a line is reworded.
const RUNTIME_SECONDS = 180;

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
  const listeners = [];
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
      if (msg.error) reject(new Error(msg.method + ': ' + msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return {
    ready,
    on(fn) { listeners.push(fn); },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

// A one-file page that pulls in the shipped renderer and calls it. Served over
// http rather than opened as file:// because canvas.captureStream taints on a
// cross-origin image, and file:// treats every sibling file as cross-origin.
function pageHtml(frames, voiceUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:#161e2e;}</style></head><body>
<script src="/reel-studio.js"></script>
<script>
window.RENDER_INPUT = ${JSON.stringify({ frames, voiceUrl })};
window.__done = null;
window.__progress = 0;
window.startRender = function(){
  // document.fonts.ready matters: without it the first seconds render in a
  // fallback face and the type pops when Montserrat arrives mid-take.
  return document.fonts.ready.then(function(){
    return window.HLReelStudio.render({
      kind: 'commercial',
      frames: window.RENDER_INPUT.frames,
      voiceUrl: window.RENDER_INPUT.voiceUrl,
      script: ${JSON.stringify(SCRIPT)},
      narrationSeconds: ${RUNTIME_SECONDS},
      brandName: 'HiveLogic',
      tagline: 'Run the whole thing.',
      onProgress: function(p){ window.__progress = p; }
    });
  }).then(function(out){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(out.blob);
    a.download = 'hivelogic-commercial.' + (out.mimeType === 'video/mp4' ? 'mp4' : 'webm');
    document.body.appendChild(a);
    a.click();
    window.__done = { mimeType: out.mimeType, bytes: out.blob.size, seconds: out.durationSeconds };
    return true;
  }).catch(function(e){ window.__done = { error: e.message }; return false; });
};
</script></body></html>`;
}

function startServer(frames) {
  const files = new Map();
  files.set('/reel-studio.js', { path: path.join(ROOT, 'public', 'reel-studio.js'), type: 'application/javascript' });
  for (const f of frames) files.set(f.url, { path: f.diskPath, type: 'image/png' });
  if (VOICE_MP3) files.set('/voice.mp3', { path: VOICE_MP3, type: 'audio/mpeg' });

  const html = pageHtml(frames.map((f) => ({ id: f.url, url: f.url })), VOICE_MP3 ? '/voice.mp3' : null);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }
    const entry = files.get(url);
    if (!entry || !fs.existsSync(entry.path)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': entry.type });
    return fs.createReadStream(entry.path).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function main() {
  if (!fs.existsSync(FRAMES_DIR)) throw new Error('No frames at ' + FRAMES_DIR + ' -- run capture-commercial-frames.mjs first.');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Frames follow the script's own beat order, so a missing capture is a
  // loud failure rather than a silently shorter film.
  const frames = SCRIPT.beats.map((b) => {
    const diskPath = path.join(FRAMES_DIR, b.frame);
    if (!fs.existsSync(diskPath)) throw new Error('missing frame: ' + b.frame);
    return { url: '/' + b.frame, diskPath };
  });

  const { server, port } = await startServer(frames);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`serving ${frames.length} frames + the shipped renderer at ${baseUrl}`);
  console.log(VOICE_MP3 ? `voiceover: ${VOICE_MP3}` : 'voiceover: none -- rendering silent, timed to the script');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-render-'));
  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--remote-debugging-port=9334',
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio',
    // Software GL is enough: the canvas work here is compositing and text,
    // and swiftshader keeps the render deterministic across machines.
    '--disable-gpu', '--use-gl=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1920,1080',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch { /* gone */ }
    try { server.close(); } catch { /* closed */ }
  };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch('http://127.0.0.1:9334/json/list');
      target = (await res.json()).find((t) => t.type === 'page');
    } catch { /* not up */ }
  }
  if (!target) throw new Error('Chrome never exposed a debugging target.');

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR });

  await client.send('Page.navigate', { url: baseUrl + '/' });
  for (let i = 0; i < 40; i++) {
    if (await evaluate(client, 'typeof window.startRender === "function" && !!window.HLReelStudio')) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const mime = await evaluate(client, 'window.HLReelStudio.pickMimeType()');
  console.log(`recording as ${mime}`);
  console.log(`rendering ${RUNTIME_SECONDS}s in real time -- this takes ${Math.ceil(RUNTIME_SECONDS / 60)} minutes`);

  await evaluate(client, 'window.startRender()');

  const deadline = Date.now() + (RUNTIME_SECONDS + 120) * 1000;
  let result = null;
  let lastShown = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await evaluate(client, 'window.__done');
    if (result) break;
    const p = await evaluate(client, 'window.__progress');
    const pct = Math.floor((p || 0) * 100 / 10) * 10;
    if (pct > lastShown) { lastShown = pct; console.log(`  ${pct}%`); }
  }
  if (!result) throw new Error('the render never finished');
  if (result.error) throw new Error('render failed: ' + result.error);

  // The download is written by the browser after the click, so wait for the
  // file to stop growing rather than assuming it landed instantly.
  let file = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const candidates = fs.readdirSync(OUT_DIR).filter((f) => /\.(mp4|webm)$/.test(f));
    if (candidates.length) {
      file = path.join(OUT_DIR, candidates[0]);
      const a = fs.statSync(file).size;
      await new Promise((r) => setTimeout(r, 1500));
      if (fs.statSync(file).size === a && a > 0) break;
    }
  }
  client.close();
  cleanup();

  if (!file) throw new Error('the browser never wrote the video file');
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`\nrendered: ${file}`);
  console.log(`${mb} MB · ${result.mimeType} · ${Math.round(result.seconds)}s`);
  if (result.mimeType !== 'video/mp4') {
    console.log('NOTE: recorded as WebM. TikTok accepts it; Instagram does not.');
  }
  if (!VOICE_MP3) {
    console.log('NOTE: silent cut. Record the voiceover in Content Studio, then re-run with the mp3 as the third argument.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
