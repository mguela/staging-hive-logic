// scripts/capture-commercial-frames.mjs
// Captures the real HiveLogic screens used as frames in the product film
// (HIVELOGIC-COMMERCIAL-SCRIPT.md).
//
// WHY REAL SCREENS AND NOT MOCKUPS: the film's closing claim is that HiveLogic
// produced the film. A mockup frame would make that claim false in the most
// visible possible way. Every frame here is the shipped public/ tree, rendered
// by a real browser, against the same stubbed-API harness the UI tests use
// (test/browser/serve.mjs) -- so what is on screen is what deploys.
//
// WHY RAW CDP AND NOT PLAYWRIGHT: Playwright's chromium download is broken on
// Windows in this environment (its extract step dies on chrome.exe), and the
// repo's Playwright harness cannot run here at all. Chrome itself is installed
// and speaks the DevTools Protocol over a WebSocket, which Node has had built
// in since v22 -- so this drives the real browser with no dependency at all.
//
// Usage:  node scripts/capture-commercial-frames.mjs [outDir]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../test/browser/serve.mjs';

const OUT_DIR = process.argv[2] || path.join(process.cwd(), 'commercial-frames');
const WIDTH = 1920;
const HEIGHT = 1080;

// The film's Act IV beats, in cut order. `view` is the app's own view id --
// the same argument the app's nav passes to showView -- so this list stays
// honest about which screens actually exist.
const SHOTS = [
  { file: '01-command-center', view: 'cc', settle: 6000, note: 'Act III reveal - the whole company on one screen' },
  { file: '02-schedule', view: 'schedule', settle: 5000, note: 'Act IV/9 - the schedule builds itself' },
  { file: '03-jobs', view: 'jobs', settle: 4000, note: 'Act IV - the work' },
  { file: '04-clients', view: 'clients', settle: 4000, note: 'Act IV - the rolodex' },
  { file: '05-estimates', view: 'estimates', settle: 4000, note: 'Act IV/10 - the estimate goes out' },
  { file: '06-invoices', view: 'invx', settle: 4000, note: 'Act IV - money in' },
  { file: '07-finances', view: 'finances', settle: 4000, note: 'Act IV/11-13 - the books close' },
  { file: '08-pnl', view: 'pnlx', settle: 4000, note: 'Act IV - the numbers' },
  { file: '09-marketing', view: 'marketing_cc', settle: 5000, note: 'Act IV/19 - where the money actually is' },
  { file: '10-reports', view: 'reports', settle: 4000, note: 'Act IV - reporting' },
  { file: '11-hiveconnect', view: 'hiveconnect', settle: 4000, note: 'Act IV - the team talks here' },
  { file: '12-takeoff', view: 'tox', settle: 5000, note: 'Act IV - takeoffs' },
];

function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge binary found. Set CHROMIUM_PATH.');
}

// ---------------------------------------------------------------------
// A minimal CDP client. One socket, one id counter, one pending map.
// ---------------------------------------------------------------------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('CDP socket error: ' + (e.message || 'unknown'))));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.method + ': ' + msg.error.message));
      else resolve(msg.result);
    }
  });
  return {
    ready,
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

async function evaluate(client, expression, awaitPromise = false) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// Polls in the page rather than sleeping a fixed amount, so a slow boot is
// waited out and a fast one is not paid for.
async function waitFor(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(client, `!!(${expression})`)) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + expression);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Measures how much is actually DRAWN in the content region of a capture --
// everything right of the left navigation and below the top bar. A view that
// failed to populate still produces a full-size, perfectly valid PNG of an
// empty panel, which is indistinguishable from a good frame by file size and
// is only obvious once it is on screen in a film. Reported at capture time
// instead.
const BLANK_STDEV_THRESHOLD = 12;

async function contentDetail(client, base64Png) {
  return evaluate(client, `(function(){
    return new Promise(function(resolve){
      var img = new Image();
      img.onload = function(){
        // Sample only the content pane: the left nav and top bar are always
        // populated, and including them makes an empty view look busy.
        var sx = Math.round(img.width * 0.14), sy = Math.round(img.height * 0.10);
        var sw = img.width - sx, sh = img.height - sy;
        var c = document.createElement('canvas');
        c.width = 200; c.height = 120;
        var x = c.getContext('2d');
        x.drawImage(img, sx, sy, sw, sh, 0, 0, 200, 120);
        var d = x.getImageData(0, 0, 200, 120).data;
        var n = 200 * 120, sum = 0, lums = new Array(n);
        for (var i = 0; i < n; i++) {
          var l = 0.2126*d[i*4] + 0.7152*d[i*4+1] + 0.0722*d[i*4+2];
          lums[i] = l; sum += l;
        }
        var mean = sum / n, v = 0;
        for (var j = 0; j < n; j++) v += (lums[j]-mean)*(lums[j]-mean);
        resolve(Math.round(Math.sqrt(v/n) * 10) / 10);
      };
      img.onerror = function(){ resolve(-1); };
      img.src = 'data:image/png;base64,' + ${JSON.stringify(base64Png)};
    });
  })()`, true);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const srv = await startServer({});
  const baseUrl = srv.url || `http://127.0.0.1:${srv.port}`;
  console.log('serving the real public/ tree at ' + baseUrl);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-frames-'));
  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--remote-debugging-port=9333',
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--use-gl=swiftshader',
    '--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch { /* already gone */ }
    try { srv.close(); } catch { /* already closed */ }
  };
  process.on('exit', cleanup);

  // Chrome writes its debugging endpoint asynchronously; poll for it.
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch('http://127.0.0.1:9333/json/list');
      const targets = await res.json();
      target = targets.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome never exposed a debugging target.');

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });

  // The app's own escape hatch: index.html hides the login overlay when the
  // hash contains 'win'. Used rather than deleting the element, so the harness
  // reaches the app the way the app itself allows.
  await client.send('Page.navigate', { url: `${baseUrl}/index.html#win` });
  await waitFor(client, 'typeof window.showView === "function"');
  // The workforce clock-in modal arms on a timer and would drift into a shot.
  // Set the app's own dismissal flag rather than racing it.
  await evaluate(client, `try{localStorage.setItem('hlWfClockInDismissed', new Date().toDateString())}catch(e){}`);
  console.log('app booted, login overlay down');

  const captured = [];
  for (const shot of SHOTS) {
    try {
      await evaluate(client, `showView(${JSON.stringify(shot.view)})`);
      if (shot.view === 'cc') {
        // The grid needs a sized container before it will lay out; hlInitCcGrid
        // is idempotent, so calling it here is safe whether or not it already ran.
        await evaluate(client, `(function(){ if (window.hlInitCcGrid) window.hlInitCcGrid(); return true; })()`);
      }
      await new Promise((r) => setTimeout(r, shot.settle));
      const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(OUT_DIR, shot.file + '.png');
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      const bytes = fs.statSync(file).size;
      const detail = await contentDetail(client, data);
      const blank = detail >= 0 && detail < BLANK_STDEV_THRESHOLD;
      captured.push({ ...shot, bytes, detail, blank });
      console.log(`  ${blank ? 'BLANK   ' : 'captured'} ${shot.file}.png  (${Math.round(bytes / 1024)} KB, detail ${detail})  ${shot.note}`);
    } catch (e) {
      console.log(`  SKIPPED ${shot.file}: ${e.message}`);
    }
  }

  client.close();
  cleanup();
  fs.writeFileSync(path.join(OUT_DIR, 'frames.json'), JSON.stringify(captured, null, 2));
  const usable = captured.filter((c) => !c.blank);
  const blanks = captured.filter((c) => c.blank);
  console.log(`\n${usable.length}/${SHOTS.length} usable frames in ${OUT_DIR}`);
  if (blanks.length) {
    console.log(`${blanks.length} rendered empty and must NOT be used in a film: ` + blanks.map((b) => b.file).join(', '));
    console.log('(These views load their content from an API the offline harness does not serve.)');
  }
  if (!usable.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
