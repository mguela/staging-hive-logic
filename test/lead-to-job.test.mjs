// Chris, 2026-08-23, walking the workflow he actually runs:
//
//   NEW LEAD > T&M JOB > JOB HITS SCHEDULE > TECHS COMPLETE > INVOICE > PAYMENT
//
// Every link in that chain already existed except the first one. A lead could
// become an ESTIMATE (rlmStartEstimate, which writes lead_pipeline.estimate_id
// and has a button on the lead card) but never a JOB. So the T&M half of the
// business -- the half that skips the estimate entirely -- had no way out of
// the pipeline: the card sat there while somebody retyped the whole thing into
// New Job, and nothing connected the two afterwards.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const TRACK1 = fs.readFileSync(path.join(__dirname, '..', 'api', 'track1.js'), 'utf-8');

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

// ---- the way in ------------------------------------------------------------

test('the lead card offers to start the job, not only an estimate', () => {
  // The button is the whole feature. rlmStartEstimate sat unreachable for weeks
  // for exactly this reason -- plumbing with no way to press it is the same as
  // no plumbing.
  assert.match(HTML, /onclick="rlmStartJob\(\)"/);
  const i = HTML.indexOf('onclick="rlmStartEstimate()"');
  const j = HTML.indexOf('onclick="rlmStartJob()"');
  assert.ok(j > i && j - i < 400, 'it belongs beside Start estimate, as the other exit from the pipeline');
});

test('an unsaved lead is told why, not quietly converted into an orphan job', () => {
  const fn = extractFunction(HTML, 'function rlmStartJob() {');
  assert.match(fn, /if \(!l\.id\)/);
  assert.match(fn, /Save this lead first/);
  // It must bail BEFORE opening the form, or he fills in a job that can never
  // link back.
  assert.ok(fn.indexOf('Save this lead first') < fn.indexOf("openForm('job')"));
});

test('it opens the form pre-filled rather than creating a job behind his back', () => {
  // A T&M job needs a rate type picked. Choosing one on his behalf is how you
  // bill at the wrong rate, and he would never see it happen.
  const fn = extractFunction(HTML, 'function rlmStartJob() {');
  assert.match(fn, /openForm\('job'\)/);
  assert.ok(!/create_job/.test(fn), 'must not create the job itself');
  assert.match(fn, /njob-title/, 'carries what they asked for');
  assert.match(fn, /njob-client/, 'and who asked');
});

// ---- closing the loop ------------------------------------------------------

function linkSandbox() {
  const ctx = { console, chirpToast: () => {}, loadLeadsLive: () => { ctx.reloaded = true; } };
  ctx.patches = [];
  ctx.hlApiPatch = (resource, body) => {
    ctx.patches.push({ resource, body });
    return Promise.resolve({ ok: true });
  };
  // The handoff lives on WINDOW, not as a block-local var. It used to be
  // `var NJOB_SOURCE_LEAD` inside an IIFE-wrapped <script> block, which meant
  // the two other blocks that write it -- njobSave and the New Lead form --
  // were assigning an implicit global of the same name while this function read
  // the private one. Two variables, one name, and a lead that never advanced.
  // The sandbox models that correctly by making `window` the context itself.
  ctx.window = ctx;
  ctx.NJOB_SOURCE_LEAD = null;
  vm.createContext(ctx);
  vm.runInContext(extractFunction(HTML, 'function njobLinkSourceLead(jobRef) {'), ctx);
  return ctx;
}

test('a job made from a lead marks that lead won, and says which job', () => {
  const ctx = linkSandbox();
  ctx.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
  ctx.njobLinkSourceLead('JOB-9');
  assert.deepEqual(ctx.patches, [{
    resource: 'leads',
    body: { leadId: 'L1', clientId: 'C1', stage: 'won', jobRef: 'JOB-9' },
  }]);
});

test('the link is used once and never leaks into the next job', () => {
  // NJOB_SOURCE_LEAD is module state. If it survived, the next job created from
  // the rail would silently close somebody else's lead.
  const ctx = linkSandbox();
  ctx.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
  ctx.njobLinkSourceLead('JOB-9');
  assert.equal(ctx.NJOB_SOURCE_LEAD, null);
  ctx.njobLinkSourceLead('JOB-10');
  assert.equal(ctx.patches.length, 1, 'the second job must not touch a lead');
});

test('a job created the ordinary way touches no lead at all', () => {
  const ctx = linkSandbox();
  ctx.njobLinkSourceLead('JOB-9');
  assert.deepEqual(ctx.patches, []);
});

test('no job id means no patch -- a lead must never be marked won for nothing', () => {
  const ctx = linkSandbox();
  ctx.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
  ctx.njobLinkSourceLead(null);
  assert.deepEqual(ctx.patches, [], 'losing the job ref must not still close the lead');
});

test('the job is what matters -- a failed lead update does not undo it', () => {
  const ctx = linkSandbox();
  const said = [];
  ctx.chirpToast = (m) => said.push(m);
  ctx.hlApiPatch = () => Promise.resolve({ ok: false, error: 'pipeline table missing' });
  ctx.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
  assert.doesNotThrow(() => ctx.njobLinkSourceLead('JOB-9'));
  return Promise.resolve().then(() => {
    assert.equal(said.length, 1, 'but it has to SAY so -- a silently stuck card is the bug being fixed');
    assert.match(said[0], /lead did not advance/);
  });
});

test('it passes the job record id, not the J-10001 label', () => {
  // jobRef is the human number. Pointing lead_pipeline.job_ref at it would
  // dangle, because every join in the app is on jobs.jobber_id.
  const i = HTML.indexOf('njobLinkSourceLead((r.job');
  assert.ok(i > -1, 'must read from r.job, not r.jobRef');
  const call = HTML.slice(i, i + 120);
  assert.match(call, /jobber_id/);
});

// ---- the server end --------------------------------------------------------

test('the API stores jobRef, and refuses one that points at nothing', () => {
  const i = TRACK1.indexOf('if (b.jobRef !== undefined)');
  assert.ok(i > -1, 'PATCH leads must accept jobRef');
  const block = TRACK1.slice(i, i + 700);
  assert.match(block, /jobs\?jobber_id=eq\./, 'validated against the jobs table, not trusted');
  assert.match(block, /That job does not exist/);
  assert.match(block, /patch\.job_ref = jobRef/);
});

test('clearing the link is allowed, so a mistaken conversion is reversible', () => {
  const i = TRACK1.indexOf('if (b.jobRef !== undefined)');
  const block = TRACK1.slice(i, i + 700);
  assert.match(block, /if \(!jobRef\) patch\.job_ref = null/);
});

test('the column exists in a migration, not only in the code that writes it', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const hit = fs.readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .find((sql) => /alter table lead_pipeline add column if not exists job_ref/i.test(sql));
  assert.ok(hit, 'a column the app writes but no migration creates is a production 500 waiting to happen');
});
