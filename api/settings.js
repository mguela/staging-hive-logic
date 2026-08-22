// api/settings.js — Vercel serverless function.
//
// The Company Setup sections that have no other backing table: business hours,
// payment terms, the numbering law, and the automation toggles. Backed by
// sql/086_company_settings.sql (one row per company per section, value JSONB).
//
// This endpoint deliberately does NOT serve the company profile, rate cards,
// divisions, roles or overhead. Those are already live and owned elsewhere —
// api/company.js, api/cost-model.js, api/registries.js — and mirroring them
// here would create a second source of truth. Company Setup reads those
// endpoints directly.
//
// PRE-MIGRATION BEHAVIOUR: until sql/086 is applied, every read returns
// ok:true with the built-in defaults and table_missing:true, and every write
// returns HTTP 503 with a plain-English message. Nothing 500s, and nothing
// reports a save that did not happen.
//
//   GET  /api/settings                  -> all sections
//   GET  /api/settings?section=hours    -> one section
//   POST /api/settings                  -> upsert one section (admin/owner only)
//        body: { section: 'hours', value: { ... } }

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { companyForUser } from './_lib/tenant.js';

// The shape of each section, and the values a company gets before anyone has
// saved anything. These defaults are what the page shows on a fresh install —
// they are honest starting values, not a pretend saved state, and the page
// labels them "default" until a real row exists.
export const SECTION_DEFAULTS = {
  hours: {
    // 0 = Sunday … 6 = Saturday. `open`/`close` are "HH:MM" 24h local time.
    days: {
      0: { open: null, close: null, closed: true },
      1: { open: '07:30', close: '17:00', closed: false },
      2: { open: '07:30', close: '17:00', closed: false },
      3: { open: '07:30', close: '17:00', closed: false },
      4: { open: '07:30', close: '17:00', closed: false },
      5: { open: '07:30', close: '17:00', closed: false },
      6: { open: null, close: null, closed: true },
    },
    saturday_by_approval: true,
    notes: '',
  },
  payment_terms: {
    // Default project payment schedule, as percentages that must total 100.
    schedule: [
      { label: 'Deposit', pct: 35 },
      { label: 'Midpoint', pct: 35 },
      { label: 'Completion', pct: 30 },
    ],
    deposit_before_materials: true,
    ach_preferred_over_cents: 500000, // $5,000.00, stored in cents
    net_days: 0,
  },
  numbering: {
    job: 'JOB #{n}',
    change_order: 'CO-{job}-{seq}',
    purchase_order: 'PO-{job}-{seq}',
    invoice: 'INV-{job}-{seq}',
    service_ticket: 'SVC-{n}',
  },
  // Every automation ships OFF. These stopped being decorative the moment they
  // gained runners (api/automations.js), so a fresh install must not inherit a
  // switched-on rule that messages customers before anyone chose to.
  automations: {
    missed_call_textback: { enabled: false, within_seconds: 15 },
    deposit_releases_pos: { enabled: false },
    invoice_overdue_nudge: { enabled: false, first_nudge_days: 3, escalate_days: 10 },
    dormant_client_reengage: { enabled: false, months_dormant: 12 },
  },
};

export const SECTIONS = Object.keys(SECTION_DEFAULTS);

// PostgREST's "relation does not exist" signals, i.e. sql/086 not applied yet.
// PGRST205 is the schema-cache miss; 42P01 is Postgres' own undefined_table.
function isMissingTable(status, text) {
    if (status !== 404 && status !== 400) return false;
    return /PGRST205|42P01|does not exist|Could not find the table/i.test(text || '');
}

// Shallow-merge a stored section over its defaults so a section saved before a
// new key existed still returns that key instead of undefined.
function withDefaults(section, stored) {
  const base = SECTION_DEFAULTS[section];
  if (!stored || typeof stored !== 'object') return { ...base };
  return { ...base, ...stored };
}

// ---- validation -----------------------------------------------------------
// Rejects payloads that would render a broken page or a nonsensical rule. Kept
// deliberately light: this stores company preferences, not money movements.
function validate(section, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'value must be a JSON object.';
  }
  if (section === 'payment_terms') {
    const sched = value.schedule;
    if (sched !== undefined) {
      if (!Array.isArray(sched) || sched.length === 0) return 'Payment schedule must be a non-empty list.';
      let total = 0;
      for (const row of sched) {
        if (!row || typeof row !== 'object') return 'Each payment stage must be an object.';
        if (!String(row.label || '').trim()) return 'Every payment stage needs a label.';
        const pct = Number(row.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'Each stage percentage must be between 0 and 100.';
        total += pct;
      }
      // Rounded to 2dp so 33.33/33.33/33.34 is accepted.
      if (Math.round(total * 100) / 100 !== 100) {
        return `Payment stages must total 100% — they currently total ${Math.round(total * 100) / 100}%.`;
      }
    }
    if (value.ach_preferred_over_cents !== undefined) {
      const c = Number(value.ach_preferred_over_cents);
      if (!Number.isInteger(c) || c < 0) return 'ACH threshold must be a whole number of cents.';
    }
  }
  if (section === 'hours') {
    const days = value.days;
    if (days !== undefined) {
      if (!days || typeof days !== 'object' || Array.isArray(days)) return 'hours.days must be an object keyed 0-6.';
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      for (const k of Object.keys(days)) {
        if (!/^[0-6]$/.test(k)) return `hours.days has an invalid day key "${k}" — use 0 (Sunday) to 6 (Saturday).`;
        const d = days[k] || {};
        if (d.closed) continue;
        if (!HHMM.test(String(d.open || '')) || !HHMM.test(String(d.close || ''))) {
          return `Opening and closing times must look like 07:30 (day ${k}).`;
        }
        if (String(d.close) <= String(d.open)) return `Closing time must be after opening time (day ${k}).`;
      }
    }
  }
  if (section === 'numbering') {
    for (const k of Object.keys(SECTION_DEFAULTS.numbering)) {
      if (value[k] === undefined) continue;
      const pat = String(value[k] || '').trim();
      if (!pat) return `The ${k.replace(/_/g, ' ')} pattern cannot be blank.`;
      if (pat.length > 40) return `The ${k.replace(/_/g, ' ')} pattern is too long (max 40 characters).`;
      // Every pattern must place at least one number, or numbering stops being unique.
      if (!/\{(n|seq)\}/.test(pat)) {
        return `The ${k.replace(/_/g, ' ')} pattern must contain {n} or {seq} so each record gets its own number.`;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const resolved = await companyForUser(auth.user);
  if (!resolved) return res.status(404).json({ ok: false, error: 'No company for this account.' });
  const company = resolved.company;
  const role = resolved.role;

  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      const wanted = String((req.query && req.query.section) || '').trim();
      if (wanted && !SECTIONS.includes(wanted)) {
        return res.status(400).json({ ok: false, error: `Unknown section "${wanted}".` });
      }

      const r = await supabaseRequest(
        `company_settings?company_id=eq.${encodeURIComponent(company.id)}&select=section,value,updated_at,updated_by`,
      );

      if (!r.ok) {
        const text = await r.text();
        // Migration not applied yet — serve defaults so the page renders and
        // says so, rather than showing an error the user cannot act on.
        if (isMissingTable(r.status, text)) {
          const sections = {};
          for (const s of (wanted ? [wanted] : SECTIONS)) sections[s] = { ...SECTION_DEFAULTS[s] };
          return res.status(200).json({
            ok: true, table_missing: true, saved_sections: [], sections,
            note: 'Company settings storage is not set up yet (sql/086 pending). Showing defaults; saving is disabled.',
          });
        }
        throw new Error('settings read failed: ' + text);
      }

      const rows = await r.json();
      const byId = {};
      for (const row of rows) byId[row.section] = row;

      const sections = {};
      const meta = {};
      for (const s of (wanted ? [wanted] : SECTIONS)) {
        sections[s] = withDefaults(s, byId[s] && byId[s].value);
        meta[s] = byId[s]
          ? { saved: true, updated_at: byId[s].updated_at, updated_by: byId[s].updated_by }
          : { saved: false, updated_at: null, updated_by: null };
      }

      return res.status(200).json({
        ok: true,
        table_missing: false,
        saved_sections: rows.map((x) => x.section),
        sections,
        meta,
        can_edit: ['owner', 'admin'].includes(role),
      });
    }

    if (method === 'POST' || method === 'PUT') {
      // Writes are admin/owner only. RLS in sql/086 enforces the same rule at
      // the database, so this holding is not the only thing standing there.
      if (!['owner', 'admin'].includes(role)) {
        return res.status(403).json({ ok: false, error: 'Only an owner or admin can change company settings.' });
      }

      const body = req.body || {};
      const section = String(body.section || '').trim();
      if (!SECTIONS.includes(section)) {
        return res.status(400).json({ ok: false, error: `section must be one of: ${SECTIONS.join(', ')}.` });
      }

      const problem = validate(section, body.value);
      if (problem) return res.status(400).json({ ok: false, error: problem });

      // Merge over defaults so a partial save never drops keys the page did
      // not send, and store the whole section as one object.
      const value = withDefaults(section, body.value);

      const up = await supabaseRequest(
        'company_settings?on_conflict=company_id,section',
        {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            company_id: company.id,
            section,
            value,
            updated_by: (auth.user && auth.user.id) || null,
            updated_at: new Date().toISOString(),
          }),
        },
      );

      if (!up.ok) {
        const text = await up.text();
        if (isMissingTable(up.status, text)) {
          return res.status(503).json({
            ok: false, table_missing: true,
            error: 'Company settings storage is not set up yet — sql/086_company_settings.sql has not been applied. Nothing was saved.',
          });
        }
        throw new Error('settings write failed: ' + text);
      }

      const saved = (await up.json())[0] || null;
      return res.status(200).json({ ok: true, section, value: saved ? saved.value : value, updated_at: saved ? saved.updated_at : null });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (e) {
    console.error('[api/settings]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
