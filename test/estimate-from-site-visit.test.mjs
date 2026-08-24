// Chris, 2026-08-23: "lets do all 3."
//
// The third was a shortcut, not a missing path. Lead -> estimate already
// worked: rlmStartEstimate, on a button in the lead modal, writing
// lead_pipeline.estimate_id. But the whole point of a site visit is the
// estimate that follows it, and from the schedule board the estimator had to
// remember the client, leave the board, find the same lead again in the Leads
// tab and press it there.
//
// The board is an iframe and the estimate builder lives in the parent page, so
// this is the same postMessage shape as the crew-board token handshake.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8');
const APP = R('public/schedule-board/app.js');
const DATA = R('public/schedule-board/data.js');
const HTML = R('public/index.html');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---- the board carries the link at all ------------------------------------

test('an appointment brings its source lead onto the board', () => {
  // Without this the button has nothing to send, and the estimate could not
  // record where it came from.
  assert.match(DATA, /sourceLeadId:a\.source_lead_id \|\| null/);
  assert.match(DATA, /clientRef:a\.client_ref \|\| null/);
});

// ---- when the button appears ----------------------------------------------

test('the button is offered only on a DONE site visit that came from a lead', () => {
  const fn = extractFunction(APP, 'function openJobSheet(vid){');
  const i = fn.indexOf('estimateFromVisit');
  assert.ok(i > -1, 'the action must be reachable from the visit sheet');
  const guard = fn.slice(Math.max(0, i - 400), i);
  assert.match(guard, /v\.kind==='sitevisit'/, 'a field job is not a site visit');
  assert.match(guard, /v\.sourceLeadId/, 'no lead means the estimate cannot be linked back');
  assert.match(guard, /v\.status==='done'/, 'writing it up before the visit happened is not the flow');
});

// ---- what it sends ---------------------------------------------------------

function boardSandbox(visit) {
  const posted = [];
  const toasts = [];
  const ctx = {
    console,
    visits: visit ? [visit] : [],
    closeModal: () => { ctx.closed = true; },
    toast: (m, bad) => toasts.push({ m, bad }),
    location: { origin: 'https://hivelogic-live.vercel.app' },
    posted, toasts,
  };
  const parent = { postMessage: (msg, origin) => posted.push({ msg, origin }) };
  ctx.window = { parent };
  vm.createContext(ctx);
  // Lift the method off the LabUI object literal so the real body runs.
  const src = extractFunction(APP, 'estimateFromVisit(vid){');
  vm.runInContext('function estimateFromVisit(vid){' + src.slice(src.indexOf('{') + 1), ctx);
  return ctx;
}

const VISIT = { id: 'v1', kind: 'sitevisit', status: 'done', sourceLeadId: 'L-1', clientRef: 'C42', type: 'Kitchen reno', client: 'Lori Kendall' };

test('it asks the parent to open the estimate, carrying the lead and the client', () => {
  const ctx = boardSandbox(VISIT);
  ctx.estimateFromVisit('v1');
  assert.equal(ctx.posted.length, 1);
  assert.deepEqual(ctx.posted[0].msg, {
    type: 'hl-estimate-from-lead', leadId: 'L-1', clientId: 'C42', title: 'Kitchen reno',
  });
  assert.equal(ctx.posted[0].origin, 'https://hivelogic-live.vercel.app',
    'targeted at our own origin, never "*" -- this carries a client record');
  assert.equal(ctx.closed, true, 'and the sheet gets out of the way');
});

test('a visit with no lead says so rather than opening a blank estimate', () => {
  const ctx = boardSandbox(Object.assign({}, VISIT, { sourceLeadId: null }));
  ctx.estimateFromVisit('v1');
  assert.equal(ctx.posted.length, 0);
  assert.match(ctx.toasts[0].m, /not linked to a lead/);
});

test('the board opened on its own admits it cannot do this', () => {
  // Standalone, window.parent === window. Posting to yourself would look like
  // it worked and do nothing, which is the failure mode worth avoiding.
  const ctx = boardSandbox(VISIT);
  ctx.window.parent = ctx.window;
  ctx.estimateFromVisit('v1');
  assert.equal(ctx.posted.length, 0);
  assert.match(ctx.toasts[0].m, /inside HiveLogic/);
});

test('an unknown visit id does nothing at all', () => {
  const ctx = boardSandbox(VISIT);
  ctx.estimateFromVisit('nope');
  assert.deepEqual(ctx.posted, []);
  assert.deepEqual(ctx.toasts, []);
});

// ---- what the parent does with it ------------------------------------------

test('the parent answers only its own origin', () => {
  const i = HTML.indexOf("d.type !== 'hl-estimate-from-lead'");
  assert.ok(i > -1, 'the parent must listen for it');
  const block = HTML.slice(Math.max(0, i - 500), i + 300);
  assert.match(block, /ev\.origin !== location\.origin/,
    'this opens a form pre-filled with a client\'s details -- an arbitrary page must not drive it');
});

test('a message with no lead id is ignored, not turned into a blank estimate', () => {
  const i = HTML.indexOf("d.type !== 'hl-estimate-from-lead'");
  const line = HTML.slice(i, i + 120);
  assert.match(line, /!d\.leadId/);
});

test('it hands off to the function that already existed, not a second copy', () => {
  // estFormFromLead is what makes the estimate record its lead, so the card
  // advances itself when the estimate is sent. Reimplementing that here would
  // be two ways to start an estimate that drift apart.
  const i = HTML.indexOf("d.type !== 'hl-estimate-from-lead'");
  const block = HTML.slice(i, i + 400);
  assert.match(block, /window\.estFormFromLead\(d\.leadId/);
  assert.match(block, /typeof window\.estFormFromLead !== 'function'/,
    'guarded, because the parent block defining it runs later in the page');
});
