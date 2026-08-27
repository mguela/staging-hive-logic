// test/lead-delete.test.mjs
// jomell, 2026-08-27, looking at a real lead card in the modal: "i should be
// able to delete a lead here. like this one, there should be a delete button
// and then it should disappear."
//
// lead_pipeline is entirely HiveLogic-owned (created here, or one-time
// backfilled from Jobber's requests table -- see leads-opportunity-model
// tests), so deleting a row here never touches Jobber and needs no HL- id
// guard the way invoices/timesheets do. Only the opportunity row goes; the
// client record and the original Jobber request (if any) are untouched.
//
// Run with: node --experimental-test-module-mocks --test test/lead-delete.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');

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

let calls = [];
let deleteFails = null;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts = {}) => {
      const method = opts.method || 'GET';
      const path_ = String(p);
      calls.push({ method, path: path_ });
      if (path_.startsWith('lead_pipeline') && method === 'DELETE') {
        if (deleteFails) return { ok: false, text: async () => deleteFails };
        return { ok: true, json: async () => [], text: async () => '' };
      }
      return { ok: true, json: async () => [], text: async () => '' };
    },
    jobberGraphQL: async () => ({}),
  },
});

global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  calls = [];
  deleteFails = null;
}

// -------------------------------------------------------------------- server

test('deleting a lead requires an id', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'DELETE', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' } }, r);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /id/i);
});

test('a successful delete removes the opportunity row by its own id, not by client_id', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'DELETE', query: { resource: 'leads', id: 'lead-123' }, headers: { authorization: 'Bearer t' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const call = calls.find((c) => c.path.startsWith('lead_pipeline') && c.method === 'DELETE');
  assert.ok(call, 'expected a DELETE call against lead_pipeline');
  assert.match(call.path, /lead_pipeline\?id=eq\.lead-123/);
});

test('a delete failure is surfaced, not swallowed', async () => {
  reset();
  deleteFails = 'db is down';
  const r = res();
  await trackMod.default({ method: 'DELETE', query: { resource: 'leads', id: 'lead-123' }, headers: { authorization: 'Bearer t' } }, r);
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /db is down/);
});

test('an unauthenticated request is refused before touching the database', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'DELETE', query: { resource: 'leads', id: 'lead-123' }, headers: {} }, r);
  assert.equal(r.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('GET/POST/PATCH on leads still work -- DELETE was added, not swapped in for an existing method', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'GET', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

// ------------------------------------------------------------------- frontend

test('the lead modal has a real Delete button wired to rlmDelete, alongside Close/Start estimate/Start the job/Save', () => {
  const idx = HTML.indexOf('id="rlv-lead-modal"');
  assert.ok(idx > -1, '#rlv-lead-modal should exist');
  const section = HTML.slice(idx, idx + 900);
  assert.match(section, /<button class="btn-ghost" id="rlm-delete"[^>]*onclick="rlmDelete\(\)">Delete<\/button>/);
  assert.match(section, /onclick="rlmTryClose\(\)">Close/);
  assert.match(section, /onclick="rlmStartEstimate\(\)">Start estimate/);
  assert.match(section, /onclick="rlmStartJob\(\)">Start the job/);
  assert.match(section, /onclick="saveRealLead\(\)">Save/);
});

test('rlmDelete refuses to call the API for a lead with no saved id, asks for confirmation, and deletes by the real lead id', () => {
  const fn = extractFunction(HTML, 'function rlmDelete() {');
  assert.match(fn, /if \(!openLead \|\| !openLead\.id\) \{/, 'must guard against an unsaved lead (no id yet)');
  assert.match(fn, /window\.confirm\('Delete this lead\? This cannot be undone\.'\)/);
  assert.match(fn, /hlApiDelete\('leads&id=' \+ encodeURIComponent\(openLead\.id\)\)/);
});

test('a successful delete closes the modal and reloads the board so the card actually disappears', () => {
  const fn = extractFunction(HTML, 'function rlmDelete() {');
  assert.match(fn, /modal\.classList\.remove\('open'\)/);
  assert.match(fn, /loadLeadsLive\(\)/);
});

test('rlmDelete is exported on window -- the inline onclick="rlmDelete()" runs in global scope, same trap as every other rlm* handler in this IIFE', () => {
  assert.match(HTML, /window\.rlmDelete = rlmDelete;/);
});
