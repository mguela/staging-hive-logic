// Subcontractors on the board, as a layer.
//
// The requirement, in Chris's words: in-house techs, then a space, then subs,
// with a hard delineation between them. And it must be a toggle, because a
// dispatcher looking at their own crews does not want another company's work
// in the way.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/schedule-board/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../public/schedule-board/data.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/schedule-board/index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/schedule/hl.js', import.meta.url), 'utf8');

test('Subs is a layer, and it is off by default', () => {
  assert.match(app, /subs:\{ic:'🤝', l:'Subs'\}/);
  assert.match(app, /lenses: \{[^}]*subs:false/);
});

test('sub rows disappear entirely when the layer is off', () => {
  // Not greyed, not collapsed -- gone. That is what keeps the board uncluttered.
  assert.match(app, /if\(!state\.lenses\.subs && state\.filter!=='subs'\) list=list\.filter\(\(t\)=>!t\.external\)/);
});

test('the Subs filter still shows subs even with the layer off', () => {
  // Otherwise picking "Subs" empties the board the user just asked for.
  assert.match(app, /state\.filter!=='subs'/);
});

test('in-house rows always come before sub rows', () => {
  assert.match(app, /const mine = list\.filter\(\(t\)=>!t\.external\), theirs = list\.filter\(\(t\)=>t\.external\)/);
  assert.match(app, /return mine\.concat\(theirs\)/);
  assert.equal(/return theirs\.concat\(mine\)/.test(app), false);
});

test('there is a labelled break, not just a line', () => {
  assert.match(app, /firstExternal.*subsplit/s);
  assert.match(app, /Subcontractors/);
  assert.match(css, /\.subsplit\{/);
});

test('sub work is visually distinct from your own', () => {
  // A sub row that looks like a crew row is worse than no sub row.
  assert.match(css, /\.row\.extrow/);
});

test('only subs with actual work get a row', () => {
  // Otherwise the board grows a permanent empty lane per sub, which is the
  // congestion the layer exists to avoid.
  assert.match(data, /subsWithWork/);
  assert.match(data, /if\(a\.sub_id\) subsWithWork/);
});

test('sub appointments are placed on the sub row', () => {
  assert.match(data, /t:rowId/);
  assert.match(data, /'sub_' \+ String\(a\.sub_id\)/);
});

test('the endpoint returns sub names, and only names', () => {
  assert.match(api, /subs\?select=id,name/);
  assert.equal(/subs\?select=\*/.test(api), false, 'the board needs a row label, not a vendor record');
});
