// api/selftest-report.js — receives the deep-crawler's report from the browser
// (POST, no auth needed — it's just QA data) and lets Reina read the latest one
// (GET, key-gated). The crawler saves AFTER EACH SCREEN keyed by runId (upsert),
// so a mid-crawl crash/navigation still leaves the latest partial to read.
import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { findingsFromSelftest, observeFindings } from './_lib/status-hub.js';

const READ_KEY = 'a7f3c9e21b8d4f60a5e7c3b9d1f8a2e4c6b0';

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  if (typeof req.body === 'string' && req.body.length) { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  if (req.method === 'GET' || req.method === 'HEAD' || req.readableEnded || req.complete) return (req.body && typeof req.body === 'object') ? req.body : {};
  return await new Promise((resolve) => {
    let data = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const to = setTimeout(() => finish({}), 3000);
    req.on('data', (c) => { data += c; });
    req.on('end', () => { clearTimeout(to); try { finish(data ? JSON.parse(data) : {}); } catch (e) { finish({}); } });
    req.on('error', () => { clearTimeout(to); finish({}); });
  });
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const gate = await requireApiAuth(req);
    if (!gate.ok) return res.status(401).json({ ok: false, error: 'Sign in to submit a self-test report.' });
    const b = await readJsonBody(req);
    const row = {
      run_id: b.runId || ('run-' + Date.now()),
      tally: b.tally || null,
      shield: b.shield || null,
      results: Array.isArray(b.results) ? b.results : null,
      meta: { url: b.url || null, generatedAt: b.generatedAt || null, checks: Array.isArray(b.results) ? b.results.length : 0, partial: !!b.partial, viewsDone: b.viewsDone || null }
    };
    // Upsert on run_id so each screen's save overwrites the same row.
    const r = await supabaseRequest('selftest_reports?on_conflict=run_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row)
    });
    if (!r.ok) return res.status(500).json({ ok: false, error: 'save failed: ' + (await r.text()).slice(0, 300) });
    const saved = (await r.json())[0] || {};
    let findings = [];
    try { findings = await observeFindings(findingsFromSelftest(row.results)); }
    catch (e) { return res.status(500).json({ ok: false, error: 'report saved but status hub update failed: ' + String(e.message || e).slice(0, 300) }); }
    return res.status(200).json({ ok: true, id: saved.id, runId: row.run_id, checks: row.meta.checks, findings: findings.length });
  }
  if (req.method === 'GET') {
    if ((req.query || {}).key !== READ_KEY) return res.status(401).json({ ok: false, error: 'locked' });
    const onlyProblems = (req.query || {}).problems === '1';
    const r = await supabaseRequest('selftest_reports?select=*&order=created_at.desc&limit=1');
    if (!r.ok) return res.status(500).json({ ok: false, error: (await r.text()).slice(0, 300) });
    const rows = await r.json();
    const latest = rows[0] || null;
    if (latest && onlyProblems && Array.isArray(latest.results)) {
      const PROB = ['THREW', 'FAILED_FETCH', 'FAKE_SUCCESS', 'NO_OUTCOME', 'SLOW_BLOCKING', 'UNREADABLE_ACTIVE'];
      latest.results = latest.results.filter((x) => PROB.indexOf(x.verdict) >= 0);
    }
    return res.status(200).json({ ok: true, latest });
  }
  return res.status(405).json({ ok: false, error: 'GET or POST only' });
}
