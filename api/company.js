// api/company.js — Vercel serverless function.
// Company settings: the company profile, its divisions/locations, and the
// status of each integration (Jobber, QuickBooks, Gusto). Auth-gated by the
// edge middleware + requireApiAuth here. Read + light edits; the money numbers
// live on the Cost Model page and the certs/vehicles on Registries — this is
// the profile + divisions + integrations hub.

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { companyForUser } from './_lib/tenant.js';
import { entitlementsFor } from './_lib/entitlements.js';
import { geocodeAddress } from './_lib/geocode.js';
import { defaultCamera, isUsable } from './_lib/service-area.js';

// A URL-safe slug from a company name.
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}
// First free slug: base, then base-2, base-3, … (companies.slug is unique).
async function uniqueSlug(base) {
  let slug = base;
  for (let n = 2; n < 60; n += 1) {
    const r = await supabaseRequest(`companies?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    if (r.ok && (await r.json()).length === 0) return slug;
    slug = `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// Best-effort read of one tenant table for the data export — an unreadable
// table becomes an { error } marker instead of failing the whole export.
async function exportTable(path) {
  try {
    const r = await supabaseRequest(path);
    if (r.ok) return await r.json();
    return { error: `read failed (${r.status})` };
  } catch (e) { return { error: e.message }; }
}

export default async function handler(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  // The tenant is derived from the signed-in user, not a hardcoded slug.
  const resolved = await companyForUser(auth.user);
  const ghCompany = () => (resolved ? resolved.company : null);

  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();
  const body = req.body || {};

  try {
    // Self-serve: a signed-in user with no company creates one and becomes its
    // owner. Idempotent — if they already belong to a company, it's returned.
    if (resource === 'provision' && method === 'POST') {
      if (!auth.user || !auth.user.id) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      if (resolved) return res.status(200).json({ ok: true, company: resolved.company, already: true });

      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'Company name is required.' });

      const slug = await uniqueSlug(slugify(name));
      const trialEndsAt = new Date(Date.now() + 14 * 86400 * 1000).toISOString(); // 14-day trial
      const row = {
        name, slug, plan: 'trial', status: 'active',
        plan_status: 'trialing', trial_ends_at: trialEndsAt,
        dba: body.dba ? String(body.dba).trim() : null,
        primary_trade: body.primary_trade || null,
        region: body.region || null,
        timezone: body.timezone || 'America/New_York',
      };
      const ins = await supabaseRequest('companies', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([row]),
      });
      if (!ins.ok) throw new Error('company create failed: ' + (await ins.text()));
      const company = (await ins.json())[0];

      // Owner membership — this is what makes it *their* tenant on every request.
      const mem = await supabaseRequest('company_members', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ company_id: company.id, user_id: auth.user.id, role: 'owner', status: 'active' }]),
      });
      if (!mem.ok) throw new Error('membership create failed: ' + (await mem.text()));

      // Ensure a profile row exists; never clobber an existing one.
      await supabaseRequest('profiles?on_conflict=id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify([{ id: auth.user.id, email: auth.user.email || null, role: 'admin' }]),
      }).catch(() => {});

      return res.status(201).json({ ok: true, company });
    }

    // Read-only export of the company's own data (owner/admin only). "Your data
    // is yours" — the safe half of account-close; never deletes anything.
    if (resource === 'export' && method === 'GET') {
      const company = ghCompany();
      if (!company) return res.status(404).json({ ok: false, error: 'No company for this account.' });
      if (!['owner', 'admin'].includes(resolved.role)) {
        return res.status(403).json({ ok: false, error: 'Only an owner or admin can export company data.' });
      }
      const cid = company.id;
      const [divisions, roster, cost_lines, cost_assumptions, company_rates, insurance_policies, registry_overhead] = await Promise.all([
        exportTable(`org_units?company_id=eq.${cid}&order=sort_order.asc`),
        exportTable(`employee_pay?company_id=eq.${cid}`),
        exportTable(`cost_lines?company_id=eq.${cid}`),
        exportTable(`cost_assumptions?company_id=eq.${cid}`),
        exportTable(`company_rates?company_id=eq.${cid}`),
        exportTable(`insurance_policies?company_id=eq.${cid}`),
        exportTable(`registry_overhead?company_id=eq.${cid}`),
      ]);
      return res.status(200).json({
        ok: true,
        exported_at: new Date().toISOString(),
        company,
        entitlements: entitlementsFor(company),
        data: { divisions, roster, cost_lines, cost_assumptions, company_rates, insurance_policies, registry_overhead },
      });
    }

    if (resource === 'get' && method === 'GET') {
      const company = ghCompany();
      if (!company) return res.status(404).json({ ok: false, error: 'No company for this account.' });

      const divR = await supabaseRequest(`org_units?company_id=eq.${company.id}&unit_type=eq.division&select=id,name,code,status,trade_slug,revenue_share_pct,is_primary,sort_order,service_center_label,service_center_lat,service_center_lng,service_radius_miles,service_area_updated_at&order=sort_order.asc`);
      // A missing service-area column means sql/089 has not been applied yet.
      // Fall back to the original select so the whole page does not go blank
      // over a feature that is additive.
      let divisions = divR.ok ? await divR.json() : [];
      let serviceAreasReady = divR.ok;
      if (!divR.ok) {
        const legacy = await supabaseRequest(`org_units?company_id=eq.${company.id}&unit_type=eq.division&select=id,name,code,status,trade_slug,revenue_share_pct,is_primary,sort_order&order=sort_order.asc`);
        divisions = legacy.ok ? await legacy.json() : [];
        serviceAreasReady = false;
      }

      // Integration connection status (row present = connected), scoped to this
      // company. Per-company OAuth *connection* flows are Phase 2; the column
      // and this scoping are the foundation, and correct for the sole company.
      const intR = await supabaseRequest(`integrations?company_id=eq.${company.id}&select=key`);
      const keys = intR.ok ? (await intR.json()).map((x) => x.key) : [];
      const integrations = {
        jobber: keys.includes('jobber'),
        qbo: keys.includes('qbo'),
        gusto: keys.includes('gusto'),
      };

      // Headcount summary from the active roster, scoped to this company.
      const epR = await supabaseRequest(`employee_pay?company_id=eq.${company.id}&effective_to=is.null&select=pay_class,is_field`);
      const roster = epR.ok ? await epR.json() : [];
      const headcount = {
        total: roster.length,
        w2: roster.filter((r) => r.pay_class === 'w2').length,
        contractors: roster.filter((r) => r.pay_class === '1099').length,
        field: roster.filter((r) => r.is_field).length,
      };

      return res.status(200).json({
        ok: true, company, divisions, integrations, headcount,
        entitlements: entitlementsFor(company),
        // The camera every map should open on, computed server-side so the
        // board, the Command Center and any future map agree rather than each
        // hardcoding its own centre and zoom.
        service_area: {
          ready: serviceAreasReady,
          configured: divisions.filter(isUsable).length,
          camera: serviceAreasReady ? defaultCamera(divisions) : null,
        },
      });
    }

    if (resource === 'update' && (method === 'POST' || method === 'PUT')) {
      const company = ghCompany();
      if (!company) return res.status(404).json({ ok: false, error: 'No company for this account.' });
      const patch = {};

      // name is the legal company name — never blanked to null.
      if (body.name !== undefined) {
        const nm = String(body.name).trim();
        if (!nm) return res.status(400).json({ ok: false, error: 'Legal name cannot be blank.' });
        patch.name = nm;
      }

      // Every other profile field is an optional text column; empty string clears it.
      const TEXT_FIELDS = [
        'dba', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
        'phone', 'email', 'website', 'ein', 'license_number', 'timezone',
        'primary_trade', 'region', 'industry',
      ];
      for (const f of TEXT_FIELDS) {
        if (body[f] === undefined) continue;
        const v = body[f] === null ? '' : String(body[f]).trim();
        patch[f] = v === '' ? null : v;
      }

      // Light validation — don't store obvious garbage in the two format-bearing fields.
      if (patch.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
          return res.status(400).json({ ok: false, error: 'That email address looks invalid.' });
        }
      }
      if (patch.state !== undefined && patch.state) {
        patch.state = patch.state.toUpperCase().slice(0, 24);
      }

      if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
      const upd = await supabaseRequest(`companies?id=eq.${company.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) throw new Error('company update failed: ' + (await upd.text()));
      return res.status(200).json({ ok: true, company: (await upd.json())[0] });
    }

    if (resource === 'division_update' && method === 'POST') {
      const company = ghCompany();
      if (!company) return res.status(404).json({ ok: false, error: 'No company for this account.' });
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name);
      if (body.code !== undefined) patch.code = body.code ? String(body.code) : null;
      if (body.status !== undefined) {
        if (!['operational', 'planned'].includes(body.status)) return res.status(400).json({ ok: false, error: 'status must be operational or planned.' });
        patch.status = body.status;
      }
      if (body.revenue_share_pct !== undefined) patch.revenue_share_pct = body.revenue_share_pct === null ? null : Number(body.revenue_share_pct);
      if (body.trade_slug !== undefined) patch.trade_slug = body.trade_slug || null;

      // --- service area -----------------------------------------------------
      // The radius is what the division travels; the centre is where from.
      if (body.service_radius_miles !== undefined) {
        const raw = body.service_radius_miles;
        if (raw === null || raw === '') {
          patch.service_radius_miles = null;
        } else {
          const r = Number(raw);
          // Mirrors the check constraint in sql/089, so a bad value is refused
          // with a sentence a human can act on instead of a Postgres error.
          if (!Number.isFinite(r) || r <= 0 || r > 500) {
            return res.status(400).json({ ok: false, error: 'Service radius must be a number of miles between 0 and 500.' });
          }
          patch.service_radius_miles = r;
        }
      }

      if (body.service_center_label !== undefined) {
        const label = String(body.service_center_label || '').trim();
        if (!label) {
          // Clearing the centre clears its coordinates too. Leaving a stale pin
          // behind a blank label is how a map ends up confidently wrong.
          patch.service_center_label = null;
          patch.service_center_lat = null;
          patch.service_center_lng = null;
        } else {
          patch.service_center_label = label;
          // Only pay for a geocode when the text actually changed.
          const cur = await supabaseRequest(`org_units?id=eq.${id}&company_id=eq.${company.id}&select=service_center_label,service_center_lat`);
          const existing = cur.ok ? (await cur.json())[0] : null;
          const unchanged = existing
            && existing.service_center_label === label
            && existing.service_center_lat != null;
          if (!unchanged) {
            const hit = await geocodeAddress(label);
            // A failed geocode still saves the label. The area simply reports
            // itself unusable until someone fixes the address -- which is more
            // honest than refusing the save or keeping the old coordinates.
            patch.service_center_lat = hit ? hit.lat : null;
            patch.service_center_lng = hit ? hit.lng : null;
          }
        }
      }

      if (patch.service_radius_miles !== undefined || patch.service_center_label !== undefined) {
        patch.service_area_updated_at = new Date().toISOString();
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
      // Scope the write to the caller's company so one tenant can't edit another's division.
      const upd = await supabaseRequest(`org_units?id=eq.${id}&company_id=eq.${company.id}&unit_type=eq.division`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) throw new Error('division update failed: ' + (await upd.text()));
      const row = (await upd.json())[0] || null;
      if (!row) return res.status(404).json({ ok: false, error: 'Division not found.' });
      return res.status(200).json({ ok: true, division: row });
    }

    return res.status(404).json({ ok: false, error: `Unknown resource/method: ${resource} ${method}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
