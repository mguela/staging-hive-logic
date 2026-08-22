// Durable Change Orders store contract. Uses mocked PostgREST responses only.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.BOOKKEEPING_CO_STORE = 'durable';

function mockFetchSequence(responses) {
  let call = 0;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
      text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
    };
  };
  return calls;
}

test('durable numbering uses the atomic per-company/per-job RPC', async () => {
  const calls = mockFetchSequence([{ body: [{ co_number: 'CO-231-04', sequence_no: 4 }] }]);
  const store = await import(`../api/bookkeeping/change-orders/_store.js?co-rpc=${Date.now()}`);
  const result = await store.allocateCoNumber({ companyId: 'company-1', jobId: '231', companyCode: 'CO' });

  assert.equal(result.coNumber, 'CO-231-04');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/allocate_co_number$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_company_id: 'company-1',
    p_job_id: '231',
    p_company_code: 'CO',
  });
});

test('durable insert stores indexed fields plus the full engine document', async () => {
  const changeOrder = {
    id: 'co-1', companyId: 'company-1', coNumber: 'CO-231-01', jobId: '231',
    kind: 'estimate', lifecycleStatus: 'draft', autoApproved: false,
  };
  const calls = mockFetchSequence([{ body: [{ id: 'row-1', version: 1, data: changeOrder }] }]);
  const store = await import(`../api/bookkeeping/change-orders/_store.js?co-insert=${Date.now()}`);
  const saved = await store.insertChangeOrder(changeOrder);

  assert.equal(saved.id, 'co-1');
  assert.equal(saved.__storeVersion, 1);
  const body = JSON.parse(calls[0].options.body)[0];
  assert.equal(body.company_id, 'company-1');
  assert.equal(body.job_id, '231');
  assert.equal(body.lifecycle_status, 'draft');
  assert.deepEqual(body.data, changeOrder);
});

test('durable update retries a compare-and-swap conflict against fresh state', async () => {
  const v2 = { id: 'co-1', companyId: 'company-1', coNumber: 'CO-231-01', jobId: '231', kind: 'estimate', lifecycleStatus: 'draft' };
  const v3 = { ...v2, lifecycleStatus: 'sent' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row-1', version: 2, data: v2 }] },
    { body: [] },
    { body: [{ id: 'row-1', version: 3, data: v3 }] },
    { body: [{ id: 'row-1', version: 4, data: { ...v3, lifecycleStatus: 'approved' } }] },
  ]);
  const store = await import(`../api/bookkeeping/change-orders/_store.js?co-cas=${Date.now()}`);
  const saved = await store.updateChangeOrder('company-1', 'co-1', (co) => ({ ...co, lifecycleStatus: 'approved' }));

  assert.equal(saved.lifecycleStatus, 'approved');
  assert.match(calls[1].url, /version=eq\.2/);
  assert.match(calls[3].url, /version=eq\.3/);
});

test('production refuses memory-backed Change Orders', async () => {
  process.env.VERCEL_ENV = 'production';
  delete process.env.BOOKKEEPING_CO_STORE;
  try {
    await assert.rejects(
      () => import(`../api/bookkeeping/change-orders/_store.js?co-prod-memory=${Date.now()}`),
      /FAIL_CLOSED.*production/s,
    );
  } finally {
    delete process.env.VERCEL_ENV;
    process.env.BOOKKEEPING_CO_STORE = 'durable';
  }
});

test('production durable mode still requires explicit migration confirmation', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.BOOKKEEPING_CO_STORE = 'durable';
  delete process.env.BOOKKEEPING_CO_MIGRATION_CONFIRMED;
  try {
    await assert.rejects(
      () => import(`../api/bookkeeping/change-orders/_store.js?co-prod-confirm=${Date.now()}`),
      /FAIL_CLOSED.*BOOKKEEPING_CO_MIGRATION_CONFIRMED/s,
    );
  } finally {
    delete process.env.VERCEL_ENV;
  }
});
