// api/_lib/self-origin.js
// Where "call my own API" points.
//
// 2026-08-15. Two files call this app's own HTTP API -- api/health-cron.js
// (liveness probes) and api/test-workflow.js (the CI runner). Both hardcoded
// the production origin, which produced a quiet but nasty pair of bugs on any
// non-production deployment:
//
//   * A preview deployment's CI run exercised PRODUCTION, not the preview
//     build it was deployed to verify. Every PR's checks were measuring main.
//   * That runner performs WRITES (create_job, job_workflow_set,
//     materials_cart_add, create_invoice). Pointed at the production origin,
//     those writes were executed by PRODUCTION's functions under PRODUCTION's
//     env -- so a preview test run put its fixtures in the production data.
//   * A preview deployment's health cron reported production's health as if
//     it were its own.
//
// Resolving the CURRENT deployment's origin fixes all three.

const PRODUCTION_ORIGIN = 'https://hivelogic-live.vercel.app';

function normalizeOrigin(value) {
  return 'https://' + String(value).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// The origin a self-directed request should target.
//
// Production keeps the stable custom domain rather than the per-deployment
// hashed URL, so production behaviour is byte-for-byte what it was. Preview
// and development resolve to THIS deployment, which is the whole point.
// HIVELOGIC_SELF_ORIGIN is an explicit override for local runs and for
// pointing a checkout at one specific deployment on purpose.
export function selfOrigin(env = process.env) {
  if (env.HIVELOGIC_SELF_ORIGIN) return normalizeOrigin(env.HIVELOGIC_SELF_ORIGIN);
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
    // VERCEL_BRANCH_URL is the stable per-branch alias; VERCEL_URL is the
    // per-deployment one. Either reaches this build; prefer the stable alias.
    const host = env.VERCEL_BRANCH_URL || env.VERCEL_URL;
    if (host) return normalizeOrigin(host);
  }
  return PRODUCTION_ORIGIN;
}

// True when this process is running on a deployment that is not production.
export function isNonProductionDeployment(env = process.env) {
  return Boolean(env.VERCEL_ENV && env.VERCEL_ENV !== 'production');
}

// Preview deployments sit behind Vercel Deployment Protection: every request to
// a preview URL is redirected to Vercel's SSO, including /api/health, which has
// no auth of its own. So even once a self-call points at the right origin
// (selfOrigin above), it still cannot reach itself on a preview.
//
// Vercel's documented answer is Protection Bypass for Automation: the project
// holds a secret, and a request presenting it as this header is admitted.
// Vercel's edge evaluates it BEFORE any of our code runs, so there is nothing
// for us to verify on the receiving side, and it grants no application access
// whatsoever -- our own auth still applies underneath it, unchanged. This is
// only about our OUTBOUND self-calls reaching their own deployment.
//
// Returns {} when no secret is configured, which is exactly today's behaviour,
// so production -- which is not protected -- is unaffected either way.
export function protectionBypassHeaders(env = process.env) {
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return {};
  return {
    'x-vercel-protection-bypass': secret,
    // Keep it request-scoped; do not persist a cookie onto anything.
    'x-vercel-set-bypass-cookie': 'false',
  };
}

// Merge the above into a fetch init without disturbing anything the caller set.
// Caller-supplied headers win on collision.
export function selfFetchInit(init = {}, env = process.env) {
  const extra = protectionBypassHeaders(env);
  if (!Object.keys(extra).length) return init;
  return { ...init, headers: { ...extra, ...(init.headers || {}) } };
}
