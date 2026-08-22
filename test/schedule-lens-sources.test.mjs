// The lens bar must distinguish "nothing today" from "nothing feeds this".
//
// The materials/money/compliance layers shipped as empty objects when the board
// was ported from the lab. Toggling them showed nothing, which on a dispatch
// board reads as "no materials are late" -- a reassuring answer nobody computed.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const data = fs.readFileSync(new URL('../public/schedule-board/data.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/schedule-board/app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/track1.js', import.meta.url), 'utf8');

test('the board asks for real materials data', () => {
  assert.match(data, /resource=materials_overview/);
});

test('materials_overview returns the key the board can actually join on', () => {
  // Board cards carry a job NUMBER; the endpoint is keyed by jobber_id. Without
  // jobNo in the payload the lens can never match a visit.
  const region = api.slice(api.indexOf('async function handleMaterialsOverview'));
  assert.match(region.slice(0, 3000), /jobNo:/);
});

test('jobRef is imported where it is used', () => {
  // It is only called inside a handler, so a missing import is a runtime
  // ReferenceError that parses perfectly and fails on the first real request.
  if (/\bjobRef\(/.test(api)) assert.match(api, /import \{[^}]*jobRef[^}]*\} from '\.\/_lib\/project-numbers\.js'/);
});

test('the materials lens is built from the response, not left empty', () => {
  assert.match(data, /materials\[m\.jobNo\]/);
  assert.equal(/LENS = \{ materials:\{\}/.test(data), false, 'materials must no longer be hardcoded empty');
});

test('layers with no source are declared, not silently zero', () => {
  assert.match(data, /HL_LENS_SOURCES/);
  assert.match(data, /money: 'not-wired'/);
  assert.match(data, /compliance: 'not-wired'/);
});

test('the bar renders an unwired layer differently from an empty one', () => {
  assert.match(app, /not-wired/);
  assert.match(app, /No data source is connected/);
});

test('compliance is not faked', () => {
  // The plan gates this on a real permits/inspections source. Inventing one
  // would put fabricated deadlines on a dispatch board.
  assert.match(data, /compliance stays \[\] on purpose/);
});
