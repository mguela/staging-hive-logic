import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/app-command-center-pulse.js', 'utf8');

function part() { return { textContent: '', innerHTML: '', style: {} }; }
function tile() {
  const parts = new Map([
    ['.pg-val', part()], ['.pg-meter > i', part()], ['.pg-pct', part()],
    ['.pg-st b', part()], ['.pg-stt', part()], ['.pg-sub', part()],
  ]);
  return {
    className: '', id: '', innerHTML: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector(sel) { return parts.get(sel); },
    parts,
  };
}

test('OWED TO YOU renders the wrapped /api/snapshot AR aggregate', async () => {
  const elements = new Map();
  const fin = { appendChild(el) { elements.set(el.id, el); } };
  elements.set('pg-fin', fin);
  let domReady;
  const payloads = {
    '/api/track1?resource=dailybrief': { ok: true, cashRunway: { runwayWeeks: 8 }, cash: { bankBalance: 50000 }, pastDueInvoices: { sum: 250, count: 2 } },
    '/api/qbo?resource=financials&kind=summary': { pnl_ytd: { gross_profit: 40, total_income: 100 } },
    '/api/snapshot': { ok: true, snapshot: { ar: { outstanding: 1000, overdueCount: 2 } } },
    '/api/track1?resource=quotes&limit=2000': { ok: true, quotes: [] },
    '/api/track1?resource=watching_unscheduled': { ok: true, count: 0 },
    '/api/jobs?limit=500': { ok: true, totalCount: 10 },
  };
  const sandbox = {
    document: {
      readyState: 'loading',
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return tile(); },
      addEventListener(type, fn) { if (type === 'DOMContentLoaded') domReady = fn; },
    },
    window: { addEventListener() {} },
    fetch(url) {
      const body = url.startsWith('/api/qbo?resource=financials&kind=bills_due_range')
        ? { bills: [], total_balance: 0 }
        : payloads[url];
      return Promise.resolve({ json: () => Promise.resolve(body) });
    },
    console, Date, Math, Number, isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'public/app-command-center-pulse.js' });
  domReady();
  sandbox.window.pgReload();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const owed = elements.get('pg-owed');
  assert.equal(owed.parts.get('.pg-val').textContent, '$1K');
  assert.equal(owed.parts.get('.pg-pct').textContent, '25% PAST DUE');
  assert.match(owed.parts.get('.pg-sub').innerHTML, /\$250 past due/);
});
