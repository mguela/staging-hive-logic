// The Subs layer, rendered in a real browser.
//
// The source-level tests assert the code SAYS the right thing. These assert the
// board actually draws it: that sub rows are absent until the layer is on, that
// when they appear they sit below every in-house row, and that there is a
// visible break between the two groups.
//
// Chris's requirement, verbatim: "in house techs and then a space and then
// subs, a hard delineation between them."

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, unavailableReason, openBoard } from './driver.mjs';
import { SUB } from './fixtures.mjs';

const reason = unavailableReason();
const opts = reason && !process.env.HL_UI_TESTS_REQUIRED ? { skip: reason } : {};

let server, browser, page;

before(async () => {
  if (reason && !process.env.HL_UI_TESTS_REQUIRED) return;
  server = await startServer();
  const { chromium } = await import(findPlaywright() ? 'playwright-core' : 'playwright-core');
  const opened = await openBoard(chromium, server.url);
  browser = opened.browser; page = opened.page;
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Row labels in the order the board draws them. */
async function rowNames() {
  return page.$$eval('.row .who b', (els) => els.map((e) => e.textContent.trim()));
}

test('with the layer off, the sub has no row at all', opts, async () => {
  const names = await rowNames();
  assert.ok(names.length > 0, 'the board must have drawn some crew rows');
  assert.equal(
    names.some((n) => n.includes(SUB.name)), false,
    'a sub row while the layer is off is exactly the congestion this design avoids',
  );
  assert.equal(await page.locator('.subsplit').count(), 0, 'no divider without sub rows');
});

test('turning the layer on adds the sub, below every in-house row', opts, async () => {
  await page.evaluate(() => window.toggleLens('subs'));
  await page.waitForTimeout(300);

  const names = await rowNames();
  const idx = names.findIndex((n) => n.includes(SUB.name));
  assert.ok(idx >= 0, `expected a row for ${SUB.name}, got: ${names.join(' | ')}`);
  assert.equal(idx, names.length - 1, 'the sub must be last, never interleaved with your crews');
});

test('a hard delineation separates them', opts, async () => {
  assert.equal(await page.locator('.subsplit').count(), 1);
  const label = await page.locator('.subsplit span').first().textContent();
  assert.match(label.trim(), /Subcontractor/i, 'the break must be labelled, not just a line');

  // And it sits between the two groups, not at the top or bottom of the board.
  const order = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.row, .subsplit').forEach((el) => {
      out.push(el.classList.contains('subsplit') ? 'SPLIT' : (el.classList.contains('extrow') ? 'SUB' : 'MINE'));
    });
    return out;
  });
  const split = order.indexOf('SPLIT');
  assert.ok(split > 0, 'something of yours must come before the break');
  assert.ok(order.slice(0, split).every((x) => x === 'MINE'), 'no sub rows above the break');
  assert.ok(order.slice(split + 1).every((x) => x === 'SUB'), 'nothing of yours below the break');
});

test('the sub work is on the board, not just the row', opts, async () => {
  const jobs = await page.$$eval('.row.extrow .job', (els) => els.map((e) => e.textContent));
  assert.ok(jobs.length >= 1, 'the sub row must carry the sub appointment');
});

test('turning it off removes the rows and the divider again', opts, async () => {
  await page.evaluate(() => window.toggleLens('subs'));
  await page.waitForTimeout(300);
  const names = await rowNames();
  assert.equal(names.some((n) => n.includes(SUB.name)), false);
  assert.equal(await page.locator('.subsplit').count(), 0);
});
