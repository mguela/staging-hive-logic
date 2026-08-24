// api/web-lead.js - Vercel serverless function
//
// Chris, 2026-08-23: "build the web lead intake"
//
// The gap this closes: until now nothing captured a lead from the website.
// There was no endpoint, no form, no table and no webhook -- the 'Website' and
// 'Google' options in "How did they find us?" were hand-picked from a dropdown
// by whoever typed the lead in afterwards. An enquiry from the website reached
// HiveLogic only if a person retyped it.
//
// PUBLIC BY NECESSITY, like api/schedule/confirm.js: the person filling in the
// form has no HiveLogic account and never will. That makes this one of the two
// most exposed surfaces in the app, so it is scoped as tightly as it can be:
//
//   - POST only. GET does nothing: link scanners and prefetchers hit URLs, and
//     a GET that created a lead would mean every crawler files one.
//   - Rate limited per IP, failing CLOSED, reusing the same limiter that
//     protects the portal recovery and appointment-confirm endpoints. No
//     store, or a broken store, means no submissions -- not unlimited ones.
//   - A honeypot field that a person never sees and a bot fills in. A filled
//     honeypot gets the same 200 as a real submission and writes nothing:
//     telling the bot it was caught just teaches it to stop filling that field.
//   - Every field length-capped before it reaches the database.
//   - lead_source is validated against a fixed set. It feeds the marketing
//     report; letting the public write it freely means anyone can invent a
//     channel and skew where the money looks like it is coming from.
//   - CORS is closed unless WEB_LEAD_ALLOWED_ORIGINS names the site. Unset
//     means same-origin only, which is the safe default rather than the
//     convenient one.
//
// THE RESPONSE IS ALWAYS THE SAME. It never says whether the person was
// already a client, whether their email matched, or whether anything was
// written. An endpoint that answers "we know that email" differently from "we
// don't" is a customer-list enumerator that anyone can query.
//
// NOTHING A STRANGER TYPES BECOMES AN IDENTITY (2026-08-23, security review).
// This is the rule that shapes the writes below, and the first draft broke it
// three ways. Three separate places in HiveLogic treat a `clients` row as proof
// of who somebody is:
//
//   clients.phone_e164  -> who is calling (voice-webhook lookupClientAndJob,
//                          and the screen pop's handleCallerGet)
//   clients.email       -> who gets a Client Portal sign-in link
//   lead_pipeline.client_id -> whose record this piece of work belongs to
//
// A web form is an unverified stranger. No confirmation email, no SMS code, no
// token -- they merely ASSERT an email and a phone. So:
//
//   - A submission NEVER attaches to an existing client. It always creates its
//     own row. Otherwise anyone who knows a customer's email could file a lead
//     on that customer's record carrying their own callback number, and the
//     office would ring a stranger believing it was a ten-year client.
//   - The created row carries a NAME AND NOTHING ELSE. No email, no phone_e164.
//     Writing those would let anyone name themselves "Con Edison -- Emergency"
//     against a number they chose and have the screen pop confirm it, and would
//     let a duplicate email row shadow a real customer at portal sign-in
//     (clientportal.js takes matches[0], unordered).
//   - The phone and email live on the LEAD, which is a note for the office to
//     act on, not a credential anything authenticates against.
//
// Compare api/schedule/confirm.js, the other public surface: it resolves its
// record from a 256-bit token, so the caller PROVES which record they are
// touching. This one cannot prove anything, so it is given nothing to touch.
//
// Alerting is deliberately NOT rebuilt here: the client row is created with
// is_lead=true, and track1's check_new_leads cron already claims and SMSes
// every newly seen is_lead client every 15 minutes. One alerting path, already
// idempotent, rather than a second one that drifts from it.

import { supabaseRequest } from './_lib/jobber.js';
import { checkRateLimit } from './_lib/portal-auth.js';
import { normalizeToE164 } from './_lib/voice.js';

// Long enough for anyone describing a real job, short enough that the body
// cannot be used as free storage.
const CAPS = { name: 120, email: 200, phone: 40, address: 300, unit: 30, need: 4000, sourceDetail: 120 };

// What the public may claim as a source. Anything else becomes 'Website',
// which is true of every submission that reaches this endpoint.
const ALLOWED_SOURCES = new Set(['Website', 'Google', 'Referral', 'Facebook', 'Instagram', 'Angi', 'Thumbtack', 'Yelp', 'Nextdoor']);

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}

function cap(v, n) {
  const s = String(v == null ? '' : v).trim();
  return s.length > n ? s.slice(0, n) : s;
}

// Angle brackets removed at the door. Every place these fields are RENDERED
// escapes them properly -- but clients.name has an anonymous writer for the
// first time because of this endpoint, and one unescaped sink anywhere in a
// 30,000-line page is a session token in the admin origin. A customer
// describing their job has no use for < or >, so nothing real is lost by
// refusing to store them.
function noTags(v, n) {
  return cap(v, n).replace(/[<>]/g, '');
}

// Deliberately permissive. This decides whether to attempt a match on the
// email, not whether to accept the enquiry -- a real customer with an address
// this rejects must still reach the office.
function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function joinAddress(addr, unit) {
  const a = String(addr || '').trim();
  let u = String(unit || '').trim();
  if (!u) return a;
  if (!a) return u;
  if (/^[0-9]+[a-z]?$/i.test(u)) u = 'Apt ' + u;
  const comma = a.indexOf(',');
  if (comma === -1) return a + ' ' + u;
  return a.slice(0, comma) + ' ' + u + a.slice(comma);
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function applyCors(req, res) {
  const raw = process.env.WEB_LEAD_ALLOWED_ORIGINS || '';
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin || !allowed.length) return;
  // Exact origin match only. A prefix or substring check here is how
  // "ghgrp.net" comes to also mean "ghgrp.net.evil.com".
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

// The one thing every caller is told, whatever happened behind it.
function accepted(res) {
  return res.status(200).json({ ok: true, message: 'Thanks — we have got it and will be in touch.' });
}

// Does this look like somebody we already know? The answer is a NOTE FOR THE
// OFFICE, never an attachment: it is written into the lead's notes for a person
// to weigh up, and never into lead_pipeline.client_id.
//
// That split is the whole point. The signal is genuinely useful -- most website
// enquiries from repeat customers are exactly that -- but acting on it
// automatically would mean an unverified stranger picks whose record their
// message lands on. Staff merge; the form does not.
async function looksLikeExistingClient(e164, email) {
  try {
    if (e164) {
      const r = await supabaseRequest(
        `clients?phone_e164=eq.${encodeURIComponent(e164)}&is_archived=eq.false&select=name&limit=1`
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows[0]) return { how: 'phone number', name: rows[0].name || null };
      }
    }
    if (email) {
      const r = await supabaseRequest(
        `clients?email=eq.${encodeURIComponent(email)}&is_archived=eq.false&select=name&limit=1`
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows[0]) return { how: 'email address', name: rows[0].name || null };
      }
    }
  } catch { /* the hint is a convenience; its absence costs nothing */ }
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'POST only.' });
  }

  const b = req.body || {};

  // The honeypot. `company_website` is hidden from people by the form's CSS and
  // has no label; a bot filling every input reaches it. Answered exactly like a
  // real submission so the bot learns nothing, and written nowhere.
  if (cap(b.company_website, 200)) return accepted(res);

  const name = noTags(b.name, CAPS.name);
  const emailRaw = cap(b.email, CAPS.email).toLowerCase();
  const phoneRaw = cap(b.phone, CAPS.phone);
  // Kept as its own field on the form -- "Apt 2B" in the street box is what
  // stops an address matching anything -- and joined here, after the street
  // rather than on the end, because service_address is one column and it is
  // what the tech is handed.
  const address = joinAddress(noTags(b.address, CAPS.address), noTags(b.unit, CAPS.unit));
  const need = noTags(b.need || b.message, CAPS.need);

  // A name, and one way to answer them. Without a way back this is not a lead,
  // it is a note nobody can act on.
  const email = looksLikeEmail(emailRaw) ? emailRaw : '';
  // normalizeToE164 is permissive by design -- it is a formatter, not a
  // validator, and hands back '+' for "+" and '+1' for "1". Both are truthy,
  // so treating its output as "they gave us a number" let a submission through
  // with no way to reach anyone. A usable number is the test, not a non-empty
  // string: 10 digits for North America, more for an international one.
  const phoneDigits = String(phoneRaw).replace(/\D/g, '');
  const e164 = phoneDigits.length >= 10 ? normalizeToE164(phoneRaw) : null;
  if (!name || (!email && !e164)) {
    return res.status(400).json({ ok: false, error: 'Please give us your name and either a phone number or an email address.' });
  }

  // Fails closed: if the limiter cannot be consulted, the submission does not
  // happen. An unthrottled public write endpoint is worse than a form that is
  // briefly down, and the caller sees the same generic wording either way.
  const rl = await checkRateLimit({
    bucket: 'web_lead',
    identifier: clientIp(req),
    limit: 5,
    windowMs: 15 * 60 * 1000,
    deps: { supabaseRequest },
  });
  if (!rl.allowed) {
    return res.status(429).json({ ok: false, error: 'Too many submissions from this connection just now. Please try again shortly, or call us.' });
  }

  const source = ALLOWED_SOURCES.has(String(b.source || '').trim()) ? String(b.source).trim() : 'Website';
  const nowIso = new Date().toISOString();

  try {
    const hint = await looksLikeExistingClient(e164, email);
    const { first, last } = splitName(name);

    // Always a NEW row, never an existing one, and carrying a name only. See
    // the header: clients.email and clients.phone_e164 are identity, and an
    // unverified stranger does not get to write identity. The office can add
    // both to the record the moment it has confirmed who this is.
    const jobberId = 'web-' + nowIso.replace(/\D/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    const cRes = await supabaseRequest('clients', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        jobber_id: jobberId,
        first_name: first || null,
        last_name: last || null,
        name: name,
        is_company: false,
        // What makes the existing check_new_leads cron pick this up and text
        // Chris within 15 minutes, with no second alerting path to maintain.
        is_lead: true,
        is_archived: false,
        source: source,
        jobber_created_at: nowIso,
        jobber_updated_at: nowIso,
      }),
    });
    if (!cRes.ok) throw new Error('client insert failed: ' + (await cRes.text()).slice(0, 200));
    const created = await cRes.json();
    const clientId = (created[0] || {}).jobber_id || jobberId;

    // Everything the office needs to answer them, on the lead card -- which is
    // a note to act on, not a credential anything authenticates against.
    const noteLines = [];
    if (email) noteLines.push('Email: ' + email);
    if (hint) {
      // Deliberately WITHOUT the matched client's name. Printing it would
      // confirm a name the submitter may only have guessed, and would make the
      // note read as corroboration -- turning a prompt to check into a prompt
      // to merge, which is exactly what attaching automatically would have
      // done. Staff can find the record themselves in two keystrokes.
      noteLines.push(
        'Their ' + hint.how + ' matches an existing client — search for them and check who this is before merging. Nothing has been linked automatically.'
      );
    }
    noteLines.push('Came in through the website form. Contact details are as typed and have not been verified.');

    const pRes = await supabaseRequest('lead_pipeline', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        client_id: clientId,
        // What they actually wrote, in their words, kept as both the headline
        // and the detail -- the same rule the in-app form follows. The Jobber
        // request sync loses this field entirely, which is why every
        // auto-created lead card to date has been a name and nothing else.
        title: need || ('Website enquiry from ' + name),
        need: need || null,
        stage: 'new',
        lead_source: source,
        // e164 when it is a usable number, otherwise whatever they typed --
        // a phone that failed the 10-digit check is still a clue for whoever
        // picks this up, and dropping it silently helps nobody.
        phone: e164 || phoneRaw || null,
        service_address: address || null,
        notes: noteLines.join('\n'),
        created_at: nowIso,
        updated_at: nowIso,
      }),
    });
    if (!pRes.ok) throw new Error('lead insert failed: ' + (await pRes.text()).slice(0, 200));

    return accepted(res);
  } catch (err) {
    // Logged for us, generic for them. The error text can name tables and
    // columns, and this endpoint answers to anyone.
    console.error('api/web-lead failed:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong on our end. Please call us instead.' });
  }
}
