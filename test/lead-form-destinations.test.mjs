// Chris, 2026-08-23, on the New Lead form:
//
//   "Trade Text box and Came in on (Brand Line) are not needed... Preferred
//    window + Backup are not needed either... Access - Not needed...
//    (Not - to Exceed) - not needed - Replace with Approximated cost...
//    gold memeber and asset link dont belong here... 'Next step' needs a
//    better name. These should be buttons, not check boxes. each button
//    progrsses the lead to its next destination"
//
// Two separate problems, and the second is the one that mattered.
//
// The removed fields were <select>s with no id. Nothing read them, nothing
// saved them, and no API has ever had a column for them -- six controls that
// looked like they were collecting information and were collecting nothing.
//
// "Next step" was worse than decoration: it was a radio group that wrote a
// `nextStep` string the leads API does not read. Picking "Create estimate" and
// pressing Save produced a lead and no estimate, with a toast saying the lead
// was saved -- which was true, and told you nothing about the estimate that
// never happened. Only site_visit did anything at all, and only after being
// wired up separately.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Read normalised: these files are CRLF on a Windows checkout and LF in CI, and
// two needles below span a line break. Unlike the loud version of this bug, both
// of these failed QUIETLY on Windows -- the `stage: 'new',\n` check is a
// negative assertion, so a needle that cannot match makes it pass against
// nothing, and the `ownrow` indexOf returned -1 so the slice below widened to
// most of the file instead of the intended block. Green, and guarding air.
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');
const TRACK1 = readSource('api', 'track1.js');

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

// The New Lead form only. The pipeline card modal (rlm-) and the old mockup
// rail form are different forms with their own markup, and a match there would
// make these assertions meaningless.
const NL_FORM = (() => {
  const start = HTML.indexOf('<div id="nl-tm-fields">');
  const end = HTML.indexOf('<div class="nl-foot">', start);
  assert.ok(start > -1 && end > start, 'the New Lead form should still be findable');
  return HTML.slice(start, end);
})();

// ---- the fields that were collecting nothing -------------------------------

test('the six dead selects are gone from the New Lead form', () => {
  for (const label of ['TRADE', 'CAME IN ON', 'PREFERRED WINDOW', 'ACCESS', 'NOT-TO-EXCEED']) {
    assert.ok(!NL_FORM.includes('<label>' + label), label + ' should no longer be on this form');
  }
  assert.ok(!NL_FORM.includes('GOLD MEMBER'), 'the gold member chip belongs to the client record, not a new lead');
  assert.ok(!NL_FORM.includes('ASSET LINK'), 'the asset chip belongs to the client record, not a new lead');
});

test('nothing still promises the NTE that was removed', () => {
  // The purple explainer under the T&M fields said "NTE protects everyone".
  // Leaving that in describes a control that is no longer there.
  assert.ok(!NL_FORM.includes('NTE protects everyone'));
});

test('the photo drop stayed -- he asked for it to stay', () => {
  assert.match(NL_FORM, /Photos of the problem/);
});

test('approximate cost is a real field, not another id-less select', () => {
  assert.match(NL_FORM, /id="nl-approx"/);
  assert.match(NL_FORM, /<label>APPROXIMATE COST<\/label>/);
  // It is a TEXT box now, deliberately: Chris asked to see the figure as money,
  // and <input type="number"> cannot render a comma or a dollar sign -- browsers
  // reject both as invalid characters in a number field. The formatting is done
  // by nlMoneyInput and undone by nlMoneyValue, so the comma never reaches the
  // API, which is the thing type="number" was protecting against.
  const field = NL_FORM.slice(NL_FORM.indexOf('id="nl-approx"'));
  assert.match(field.slice(0, 200), /type="text"/);
  assert.match(field.slice(0, 200), /inputmode="decimal"/, 'a phone should still show a number pad');
  assert.match(field.slice(0, 200), /oninput="nlMoneyInput\(this\)"/);
});

test('approximate cost is actually sent, as the estimated value', () => {
  const fn = extractFunction(HTML, 'function nlReadForm() {');
  assert.match(fn, /nl-approx/);
  assert.match(fn, /estimatedValue:/);
  // Read back through the parser, or "$1,250" arrives as a string and the API
  // stores null -- a lead he priced, saved as unpriced.
  assert.match(fn, /nlMoneyValue\(v\('nl-approx'\)\)/);
  // Guarded the same way the API guards it -- a blank box is null, not 0, and
  // a lead worth $0 is not the same as a lead nobody has priced.
  assert.match(fn, /approx > 0/);
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /estimatedValue: f\.estimatedValue/);
});

test('the urgency picker that survived is the one that was wired', () => {
  // There were two: a <select> with no id inside the T&M block, and the #nl-prio
  // tiles the save actually reads. Keeping the dead one would leave him setting
  // urgency in the place that does not count.
  assert.ok(!NL_FORM.includes('<label>URGENCY'), 'the dead duplicate select is gone');
  assert.match(HTML, /id="nl-prio"/);
  assert.match(extractFunction(HTML, 'function nlReadForm() {'), /#nl-prio \.po\.sel/);
});

// ---- the destinations ------------------------------------------------------

test('the section has a name that says what it does', () => {
  assert.ok(!HTML.includes('&#8594;</span>Next step'), '"Next step" was the name he asked to be changed');
  assert.match(HTML, /Where does this go\?/);
});

test('all five destinations are buttons that act, not options that get ticked', () => {
  const steps = HTML.slice(HTML.indexOf('<div class="steps" id="nl-nextsteps">'));
  const block = steps.slice(0, steps.indexOf('</div>\n            <div class="ownrow"'));
  for (const dest of ['site_visit', 'job', 'estimate', 'callback', 'not_a_fit']) {
    assert.ok(block.includes("nlGo('" + dest + "')"), dest + ' should press through to nlGo');
  }
  // The selection handler is what made them checkboxes. If it comes back, so
  // does "picked it and nothing happened".
  assert.ok(!HTML.includes('nlPickNextStep'), 'the radio-group behaviour is gone');
  assert.ok(!block.includes('class="step-o sel"'), 'no destination is pre-ticked -- pressing one is the choice');
});

test('schedule a job exists at all -- it was the missing one', () => {
  assert.match(HTML, /Schedule a job/);
  assert.match(HTML, /function nlGoJob\(\)/);
});

test('every destination saves the lead before it goes anywhere', () => {
  for (const fn of ['nlGoJob', 'nlGoEstimate', 'nlGoSiteVisit', 'nlGoCallback', 'nlGoNotAFit']) {
    const src = extractFunction(HTML, 'function ' + fn + (fn === 'nlGoNotAFit' ? '(keep) {' : '() {'));
    assert.match(src, /nlSaveLeadCore\(/, fn + ' must save the lead');
  }
});

test('a failed save does not send him onward with nothing behind it', () => {
  // nlSaveLeadCore resolves null when the save did not happen. Opening a
  // prefilled job form off a lead that was never written is how you get a job
  // pointing at nothing, and he would have no reason to suspect it.
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /return null;/);
  for (const fn of ['nlGoJob', 'nlGoEstimate', 'nlGoSiteVisit', 'nlGoCallback']) {
    const src = extractFunction(HTML, 'function ' + fn + '() {');
    assert.match(src, /if \(!res\) return;/, fn + ' must stop when the save failed');
  }
});

test('the form reads the lead id from where the server actually puts it', () => {
  // This is the bug that made "Schedule a job" look like it deleted the form.
  // api/track1.js's leads POST returns { ok, resource, clientId, pipeline },
  // and the form was reading r.leadId / r.lead.id -- neither of which the
  // server has ever sent. So leadId was ALWAYS null in production, both
  // destinations that need one bailed, and they bailed AFTER the form had
  // closed. Pinned against the server source so the two cannot drift apart
  // again without a test failing.
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /r\.pipeline && \(r\.pipeline\.id/, 'the id comes from r.pipeline.id');
  assert.match(core, /clientId: r\.clientId/, 'and the client id is returned top-level');

  // And the server really does answer in that shape.
  const i = TRACK1.indexOf("ok: true, resource: 'leads'");
  assert.ok(i > -1, 'the leads POST response should still be findable');
  const reply = TRACK1.slice(i, i + 200);
  assert.match(reply, /clientId, pipeline/);
  assert.ok(!/leadId/.test(reply), 'if the server ever starts sending leadId, this test should be revisited');
});

test('a lead with no id does not silently open an unlinked job or estimate', () => {
  for (const fn of ['nlGoJob', 'nlGoEstimate']) {
    const src = extractFunction(HTML, 'function ' + fn + '() {');
    assert.match(src, /if \(!res\.leadId\)/, fn + ' needs the lead id to link back');
    assert.match(src, /open it from the pipeline/, fn + ' should say what to do instead');
  }
});

test('the job handoff reuses the link that marks the lead won', () => {
  // NJOB_SOURCE_LEAD is what njobLinkSourceLead reads on save to set stage=won
  // and record job_ref. Prefilling the form without it produces a job that is
  // never tied to the lead it came from.
  const src = extractFunction(HTML, 'function nlGoJob() {');
  assert.match(src, /NJOB_SOURCE_LEAD = \{ leadId: res\.leadId/);
  assert.match(src, /openForm\('job'\)/);
  assert.ok(src.indexOf('NJOB_SOURCE_LEAD') < src.indexOf("openForm('job')"),
    'the link has to be set before the form opens, or the save races it');
});

// ---- what the destinations need, asked for at the moment of pressing -------

test('the WHEN row is gone from the form and asked for instead', () => {
  // It used to sit on the form permanently, visible only when site_visit was
  // the ticked step -- so it was dead weight for the other four destinations
  // and part of the draft for all of them.
  assert.ok(!HTML.includes('id="nl-visitwhen"'));
  assert.ok(!HTML.includes('id="nl-visit-date"'));
  assert.match(HTML, /function nlAskSheet\(opts\) \{/);
});

test('the date and time are no longer part of the lead draft', () => {
  const line = HTML.match(/var NL_TEXT_FIELDS = \[[^\]]*\]/)[0];
  assert.ok(!line.includes('nl-visit-date'), 'a field that is not on the form cannot be restored onto it');
  assert.ok(line.includes('nl-approx'), 'but the new one must be, or the draft loses it');
});

test('backing out of the question changes nothing', () => {
  // The sheet is shown BEFORE the save on the two destinations that need input.
  // Asking after the save would mean cancelling still left a saved lead, with a
  // half-done destination and no sign of it.
  for (const fn of ['nlGoSiteVisit', 'nlGoCallback', 'nlGoNotAFit']) {
    const src = extractFunction(HTML, 'function ' + fn + (fn === 'nlGoNotAFit' ? '(keep) {' : '() {'));
    assert.ok(src.indexOf('nlAskSheet(') < src.indexOf('nlSaveLeadCore('),
      fn + ' must ask first and save second');
  }
});

test('the sheet refuses to go anywhere without what it needs', () => {
  const fn = extractFunction(HTML, 'function nlAskSheet(opts) {');
  assert.match(fn, /r\.required && !String\(vals\[r\.id\]\)\.trim\(\)/);
  assert.match(fn, /is needed before this can go anywhere/);
  // And a required row that is empty must not call onSubmit at all.
  assert.ok(fn.indexOf('if (missing)') < fn.indexOf('o.onSubmit(vals)'));
});

test('a site visit cannot be booked without a date', () => {
  const src = extractFunction(HTML, 'function nlGoSiteVisit() {');
  assert.match(src, /id: 'nl-ask-date', label: 'DATE', type: 'date', required: true/);
});

// ---- the call back ---------------------------------------------------------

test('a call back lands on the calendar with a time and a reason', () => {
  const src = extractFunction(HTML, 'function nlGoCallback() {');
  assert.match(src, /id: 'nl-ask-date', label: 'DATE', type: 'date', required: true/);
  // The reason is required too. "Call them back" with no why is a reminder
  // whoever picks it up cannot act on -- they ring the client and ask what the
  // client wanted, which is the call the client already made.
  assert.match(src, /id: 'nl-ask-why', label: 'WHAT IS THE CALL ABOUT\?', type: 'text', required: true/);
  const book = extractFunction(HTML, 'function nlBookCallback(leadId, who, phone, d, hr, reason) {');
  assert.match(book, /kind: 'lead'/, "'lead' is the board's Lead follow-up type");
  assert.match(book, /create_appointment/);
  // The reason has to be readable on the calendar itself -- whoever picks the
  // call up needs to know what it is about without opening anything.
  assert.match(book, /title: 'Call back '/);
  assert.match(book, /why \? ' — ' \+ why/);
  assert.match(book, /source_lead_id: leadId/);
});

test('a booking that fails says so instead of riding on the lead-saved toast', () => {
  for (const decl of [
    'function nlBookSiteVisit(leadId, who, addr, d, hr) {',
    'function nlBookCallback(leadId, who, phone, d, hr, reason) {'
  ]) {
    const src = extractFunction(HTML, decl);
    assert.match(src, /Lead saved, but the/, 'the two outcomes are reported separately');
    assert.match(src, /\.catch\(/);
  }
});

// ---- not a good fit --------------------------------------------------------

test('not a fit closes the lead out rather than parking it as live', () => {
  const src = extractFunction(HTML, 'function nlGoNotAFit(keep) {');
  assert.match(src, /stage: 'lost'/);
  assert.match(src, /lostReason: reason/);
});

test('the reasons match the ones the pipeline board already offers', () => {
  const list = HTML.match(/var NL_LOST_REASONS = \[[\s\S]*?\];/)[0];
  for (const r of ['price', 'timing', 'went_with_competitor', 'ghosted', 'out_of_scope']) {
    assert.ok(list.includes("'" + r + "'"), r + ' is one of the board\'s reasons');
  }
  // Same five, so a lead closed here and a lead dragged to Rejected report
  // identically. A sixth list would split the count in half.
  assert.ok(list.includes("'other'"), 'and one escape hatch for a reason not on the list');
});

test('"something else" with nothing typed is refused', () => {
  // Recording "other" and no text is worse than the fixed list it exists to
  // escape -- it is a loss with no reason at all.
  const src = extractFunction(HTML, 'function nlGoNotAFit(keep) {');
  assert.match(src, /reason === 'other' && !note/);
  assert.match(src, /Pick a reason, or type what it was/);
  assert.ok(src.indexOf("reason === 'other' && !note") < src.indexOf('nlSaveLeadCore('),
    'it must refuse before saving');
  // And asking again must not throw away what he already picked. Reopening
  // blank puts the reason back to "pick one" and refuses a second time, which
  // reads as the button being broken rather than as a question.
  assert.match(src, /return nlGoNotAFit\(\{ reason: reason, note: note \}\)/);
  assert.match(src, /value: k\.reason \|\| ''/);
  assert.match(src, /value: k\.note \|\| ''/);
});

// ---- the API has to accept a lead that is born closed ----------------------

test('creating a lead accepts a stage instead of hardcoding new', () => {
  // This was the silent half. The form could send stage:'lost' all it liked --
  // POST wrote stage:'new' unconditionally, so "Not a good fit" produced a
  // live lead and the reason went nowhere.
  assert.ok(!TRACK1.includes("      stage: 'new',\n"), 'stage is no longer hardcoded on create');
  assert.match(TRACK1, /stage: wantStage \|\| 'new'/);
  assert.match(TRACK1, /lost_reason: String\(b\.lostReason \|\| ''\)\.trim\(\) \|\| null/);
});

test('an unknown stage is rejected on create, same as on update', () => {
  const i = TRACK1.indexOf('const wantStage');
  const window_ = TRACK1.slice(i, i + 700);
  assert.match(window_, /LEAD_STAGES\.indexOf\(wantStage\) === -1/);
  assert.match(window_, /stage must be one of/);
});

test('a lead cannot be created as lost with no reason', () => {
  const i = TRACK1.indexOf('const wantStage');
  const window_ = TRACK1.slice(i, i + 700);
  assert.match(window_, /wantStage === 'lost' && !String\(b\.lostReason/);
  assert.match(window_, /lostReason is required/);
});

test('a lead created past new records when it was contacted', () => {
  // The form's own SLA note says "the clock starts when you save". A lead
  // created at a later stage was contacted to get there -- that is the call
  // that produced it -- so first_contacted_at cannot stay null.
  const i = TRACK1.indexOf('const wantStage');
  assert.match(TRACK1.slice(i, i + 1400), /first_contacted_at: \(wantStage && wantStage !== 'new'\) \? nowIso : null/);
});

// ---- the plain save still works --------------------------------------------

test('Save on its own still parks a lead with no destination picked', () => {
  // Answering the phone and not yet knowing what happens next is a real state.
  // Making a destination mandatory would make him invent one.
  const src = extractFunction(HTML, 'function saveLead() {');
  assert.match(src, /nlSaveLeadCore\(null\)/);
  assert.match(src, /Lead saved to the real pipeline/);
  assert.match(HTML, /onclick="saveLead\(\)"/);
});

test('a lead with no name is still refused, once, in one place', () => {
  // 2026-08-26: the bare name-only check moved into nlValidateRequired,
  // which also gates phone/email, service address, and "in their words" --
  // still one gate for all six entry points, just a fuller one now.
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /if \(!nlValidateRequired\(f\)\) return Promise\.resolve\(null\);/);
  assert.strictEqual(HTML.split('function nlValidateRequired(').length - 1, 1);
  const gate = extractFunction(HTML, 'function nlValidateRequired(f) {');
  assert.match(gate, /!f\.firstName\.trim\(\) && !f\.lastName\.trim\(\)/);
});

test('a saved lead clears its draft and refreshes the board exactly once', () => {
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /nlDiscardDraftAfterSave\(\)/);
  assert.match(core, /loadLeadsLive\(\)/);
  assert.strictEqual((core.match(/nlDiscardDraftAfterSave\(\)/g) || []).length, 1);
});
