// test/takeoffs-reina-read.test.mjs
//
// Covers the "reina_read" action on api/takeoffs.js -- the route behind
// HiveGrid's "REINA READS SHEET" (mode: current_sheet) and "READ ALL SHEETS"
// (mode: all_sheets) buttons. Fully mocked: global.fetch only ever answers
// Supabase's /auth/v1/user check, and no ANTHROPIC_API_KEY is set in this
// test run (same convention as test/reina-plan-read.test.mjs), so every read
// exercises the honest stub path. This file proves routing, validation, and
// auth -- not model output quality.
//
// Run: node --test test/takeoffs-reina-read.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-key';

function res() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function authedReq(body) {
  return { method: 'POST', headers: { authorization: 'Bearer good-token' }, query: {}, body };
}

const PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-sheet-pixels').toString('base64');

function stubAuthFetch() {
  return async (url) => {
    if (String(url).includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'user-1', email: 'tester@hivelogic.test' }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

test('reina_read: an anonymous request is rejected 401 before any AI or DB work happens', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('no fetch should happen for an anonymous request'); };
  try {
    const mod = await import('../api/takeoffs.js');
    const req = { method: 'POST', headers: {}, query: {}, body: { action: 'reina_read', mode: 'current_sheet', sheets: [{ index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL }] } };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.ok, false);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: rejects a request with no sheets', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({ action: 'reina_read', mode: 'current_sheet', sheets: [] }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /sheets is required/);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: current_sheet mode refuses more than one sheet -- it must never process the whole plan', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({
      action: 'reina_read',
      mode: 'current_sheet',
      sheets: [
        { index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL },
        { index: 1, name: 'E-1.0', dataUrl: PNG_DATA_URL },
      ],
    }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /exactly one sheet/);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: rejects a sheet without a valid base64 image data_url', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({
      action: 'reina_read',
      mode: 'current_sheet',
      sheets: [{ index: 0, name: 'A-1.0', dataUrl: 'not-a-data-url' }],
    }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /valid base64 image/);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: current_sheet mode reads exactly the one sheet given', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({
      action: 'reina_read',
      mode: 'current_sheet',
      quote_id: 'q-1',
      sheets: [{ index: 2, name: 'E-1.0', dataUrl: PNG_DATA_URL }],
    }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, 'current_sheet');
    assert.equal(r.body.quoteId, 'q-1');
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.results[0].index, 2);
    assert.equal(r.body.results[0].name, 'E-1.0');
    assert.equal(r.body.results[0].ok, true);
    // No ANTHROPIC_API_KEY in this test env -- the honest stub path, not a fabricated read.
    assert.equal(r.body.results[0].analysis.needsAiConnection, true);
    assert.equal(r.body.configured, false);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: all_sheets mode reads every sheet given, retaining sheet identity and order', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    const sheets = [
      { index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL },
      { index: 1, name: 'E-1.0', dataUrl: PNG_DATA_URL },
      { index: 2, name: 'P-1.0', dataUrl: PNG_DATA_URL },
    ];
    await mod.default(authedReq({ action: 'reina_read', mode: 'all_sheets', sheets }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.mode, 'all_sheets');
    assert.equal(r.body.results.length, 3);
    r.body.results.forEach((result, i) => {
      assert.equal(result.index, sheets[i].index);
      assert.equal(result.name, sheets[i].name);
      assert.equal(result.ok, true);
    });
  } finally {
    global.fetch = original;
  }
});

// --- the cross-sheet "overview" synthesis ------------------------------------
// No ANTHROPIC_API_KEY in this test env, so every per-sheet read comes back
// as the honest needsAiConnection stub -- which means there is nothing real
// to synthesize across, and the route must skip the synthesis call entirely
// rather than running it over a pile of "not configured" placeholders.

test('reina_read: all_sheets mode with only stub (unconfigured) reads never attempts a synthesis pass', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    const sheets = [
      { index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL },
      { index: 1, name: 'E-1.0', dataUrl: PNG_DATA_URL },
    ];
    await mod.default(authedReq({ action: 'reina_read', mode: 'all_sheets', sheets }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.overview, null, 'stub reads carry nothing real to synthesize -- overview must stay null, not a fabricated summary');
    assert.equal(r.body.overviewError, null);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: current_sheet mode never runs the multi-sheet synthesis pass', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({
      action: 'reina_read',
      mode: 'current_sheet',
      sheets: [{ index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL }],
    }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.overview, null);
  } finally {
    global.fetch = original;
  }
});

test('reina_read: a bad mode value falls back to current_sheet rather than silently processing everything', async () => {
  const original = global.fetch;
  global.fetch = stubAuthFetch();
  try {
    const mod = await import('../api/takeoffs.js');
    const r = res();
    await mod.default(authedReq({
      action: 'reina_read',
      mode: 'not_a_real_mode',
      sheets: [{ index: 0, name: 'A-1.0', dataUrl: PNG_DATA_URL }],
    }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.mode, 'current_sheet');
  } finally {
    global.fetch = original;
  }
});
