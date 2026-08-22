// findChromium() unit tests -- no browser launch, just the path resolution.
// Found during the 8/18 Dev To-Do triage: the function only ever checked
// process.env.HOME + '.cache/ms-playwright' and Linux/Mac binary names, so it
// silently found nothing on Windows even with Chromium correctly installed
// via `npx playwright install chromium` (which defaults to
// %LOCALAPPDATA%\ms-playwright there, with a chrome-win/chrome.exe layout).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findChromium } from './driver.mjs';

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  Object.assign(process.env, overrides);
  try { return fn(); } finally { for (const key of Object.keys(overrides)) {
    if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
  } }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hl-find-chromium-'));
}

test('CHROMIUM_PATH / CHROME_PATH override wins outright when the file exists', () => {
  const dir = tempDir();
  const fake = path.join(dir, 'my-chrome.exe');
  fs.writeFileSync(fake, '');
  try {
    withEnv({ CHROMIUM_PATH: fake, CHROME_PATH: '', LOCALAPPDATA: '', PLAYWRIGHT_BROWSERS_PATH: '', HOME: '' }, () => {
      assert.equal(findChromium(), fake);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Windows-style %LOCALAPPDATA%\\ms-playwright\\chromium-*\\chrome-win\\chrome.exe layout is found', () => {
  const dir = tempDir();
  const chromiumDir = path.join(dir, 'ms-playwright', 'chromium-1148', 'chrome-win');
  fs.mkdirSync(chromiumDir, { recursive: true });
  const bin = path.join(chromiumDir, 'chrome.exe');
  fs.writeFileSync(bin, '');
  try {
    withEnv({ CHROMIUM_PATH: '', CHROME_PATH: '', LOCALAPPDATA: dir, PLAYWRIGHT_BROWSERS_PATH: '', HOME: '' }, () => {
      assert.equal(findChromium(), bin);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PLAYWRIGHT_BROWSERS_PATH still takes priority over the default cache locations', () => {
  const dir = tempDir();
  const chromiumDir = path.join(dir, 'chromium-1148', 'chrome-win');
  fs.mkdirSync(chromiumDir, { recursive: true });
  const bin = path.join(chromiumDir, 'chrome.exe');
  fs.writeFileSync(bin, '');
  const decoyDir = tempDir();
  try {
    withEnv({ CHROMIUM_PATH: '', CHROME_PATH: '', LOCALAPPDATA: decoyDir, PLAYWRIGHT_BROWSERS_PATH: dir, HOME: '' }, () => {
      assert.equal(findChromium(), bin);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(decoyDir, { recursive: true, force: true });
  }
});

test('a Linux-style chrome-linux/chrome layout under LOCALAPPDATA is still recognized, not just chrome-win', () => {
  // A Chromium build only ever ships the binary matching the host OS, but the
  // search must not assume Windows just because LOCALAPPDATA happens to be
  // set (e.g. a cross-platform CI image) -- it tries every known layout.
  const dir = tempDir();
  const chromiumDir = path.join(dir, 'ms-playwright', 'chromium-1148', 'chrome-linux');
  fs.mkdirSync(chromiumDir, { recursive: true });
  const bin = path.join(chromiumDir, 'chrome');
  fs.writeFileSync(bin, '');
  try {
    withEnv({ CHROMIUM_PATH: '', CHROME_PATH: '', LOCALAPPDATA: dir, PLAYWRIGHT_BROWSERS_PATH: '', HOME: '' }, () => {
      assert.equal(findChromium(), bin);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing found in any configured root returns null, or a real system install, but never throws', () => {
  // findChromium() also falls back to a short list of hardcoded absolute
  // system paths (/usr/bin/chromium and friends). This test controls every
  // env-based root but cannot control whether the machine RUNNING this test
  // happens to have chromium installed at one of those system paths -- a
  // GitHub Actions Ubuntu runner with the "Install browser system deps" step
  // genuinely does. Asserting a bare null here would fail on exactly the CI
  // machine this is meant to protect, for the right reason (it found a real
  // browser) reported as the wrong one (a crash in the fallback logic).
  const SYSTEM_FALLBACK_PATHS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const emptyDir = tempDir();
  try {
    withEnv({ CHROMIUM_PATH: '', CHROME_PATH: '', LOCALAPPDATA: emptyDir, PLAYWRIGHT_BROWSERS_PATH: '', HOME: emptyDir }, () => {
      const result = findChromium();
      if (result !== null) assert.ok(SYSTEM_FALLBACK_PATHS.includes(result), `expected null or a known system path, got: ${result}`);
    });
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
