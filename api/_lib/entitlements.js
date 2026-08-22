// api/_lib/entitlements.js — plan tiers & feature entitlements (Phase 3).
//
// PURE, REPORT-ONLY logic. Nothing here charges money or enforces a block yet —
// it answers "what does this company's plan include?" so surfaces can *show*
// upgrade prompts and, later, gate features. Enforcement is a deliberate, separate
// step; until then every real request keeps working exactly as today.
//
// Safety by design:
//   * The founding company (plan='primary') and any unknown/unlisted plan
//     resolve to UNLIMITED (fail-open) — a plan we don't recognize must never
//     silently disable a live customer's features.
//   * Feature keys are the app's real modules.
//
// TUNABLE: the tier→feature map and seat caps below are product/pricing
// decisions. Adjust freely — the mechanism doesn't change.

// Every gate-able module in the app.
export const FEATURES = [
  'cost_model', 'registries', 'team', 'schedule', 'clients', 'invoicing',
  'fleet', 'payroll', 'reina', 'marketing',
];

// Plan tiers. `features: '*'` or `seats: null` = unlimited.
export const PLAN_TIERS = {
  trial: {
    label: 'Trial', seats: 10,
    // Trials get everything so evaluation isn't crippled.
    features: '*',
  },
  starter: {
    label: 'Starter', seats: 5,
    features: ['cost_model', 'registries', 'team', 'schedule', 'clients', 'invoicing'],
  },
  pro: {
    label: 'Pro', seats: 25,
    features: ['cost_model', 'registries', 'team', 'schedule', 'clients', 'invoicing', 'fleet', 'payroll', 'marketing'],
  },
  elite: {
    label: 'Elite', seats: null,
    features: '*',
  },
  // Internal / founding company — unlimited, never billed.
  primary: { label: 'Founding', seats: null, features: '*', internal: true },
};

// Resolve a company's tier config. Unknown/blank plans fail OPEN (unlimited),
// so an unrecognized plan can never disable a live customer.
export function tierFor(company) {
  const plan = String((company && company.plan) || '').toLowerCase();
  if (PLAN_TIERS[plan]) return { key: plan, ...PLAN_TIERS[plan] };
  return { key: plan || 'unknown', label: 'Unlimited', seats: null, features: '*', unrecognized: true };
}

// Does this company's plan include a feature? Unknown feature → false; unlimited
// tier → true.
export function planAllows(company, feature) {
  const t = tierFor(company);
  if (t.features === '*') return true;
  return Array.isArray(t.features) && t.features.includes(feature);
}

// Seat cap for the plan (purchased `seats` override wins). null = unlimited.
export function seatLimit(company) {
  if (company && company.seats != null) return Number(company.seats);
  return tierFor(company).seats;
}

// Is a headcount within the seat cap? Unlimited → always true.
export function withinSeatLimit(company, headcount) {
  const cap = seatLimit(company);
  if (cap == null) return true;
  return Number(headcount || 0) <= cap;
}

// A full, JSON-friendly entitlements snapshot for a company row — what an API
// returns so the UI can show plan state and (later) gate. Report-only.
export function entitlementsFor(company) {
  const t = tierFor(company);
  const features = {};
  for (const f of FEATURES) features[f] = t.features === '*' ? true : (Array.isArray(t.features) && t.features.includes(f));
  const trialEndsAt = (company && company.trial_ends_at) || null;
  return {
    plan: t.key,
    plan_label: t.label,
    plan_status: (company && company.plan_status) || 'active',
    internal: !!t.internal,
    unlimited_features: t.features === '*',
    seats: seatLimit(company),
    trialing: (company && company.plan_status) === 'trialing',
    trial_ends_at: trialEndsAt,
    features,
    // Enforcement is intentionally OFF for now — surfaces may *show* this, but
    // no request is blocked until we flip enforcement on deliberately.
    enforced: false,
  };
}
