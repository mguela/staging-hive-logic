// middleware.js — THE global /api/* auth choke point (2026-08-01, Item 3).
//
// Vercel Edge Middleware runs before every matched request reaches its
// serverless function. This is the ONE place company data is gated: no
// per-endpoint patching, no ccccceliance on the frontend hiding a URL. The
// decision logic lives in api/_lib/guard.js (unit-tested); this file just
// wires it to the incoming request.
//
// A request to /api/* is allowed only if it is on the public allowlist, or
// carries a valid Supabase session, or is a known cron path with the valid
// CRON_SECRET. Everything else gets 401. See guard.js for the full rationale.

import {
  isPublicApiPath,
  decideAccess,
  verifyUserBearer,
  checkCronSecret,
} from "./api/_lib/guard.js";

export const config = {
  // Gate the whole API surface. Non-/api assets (the static frontend) are not
  // matched and are served normally.
  matcher: "/api/:path*",
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Fast path: genuinely public / self-authenticating routes skip the
  // Supabase round-trip entirely.
  if (isPublicApiPath(pathname)) return undefined;

  // Self-test QA report (temporary dev tool): GET is gated by its own READ_KEY
  // and is read server-side (no Supabase session), so let GET through. POST
  // (the in-app crawler) still requires a valid session below.
  if (pathname === "/api/selftest-report" && request.method === "GET")
    return undefined;

  const authHeader = request.headers.get("authorization") || "";
  const hasValidCronSecret = checkCronSecret(authHeader);
  // Only verify a Supabase session when it could matter (avoid a needless
  // network call when a valid cron secret already settles it).
  const verify = hasValidCronSecret
    ? false
    : await verifyUserBearer(authHeader);
  // If the edge runtime lacks Supabase config, don't 401 the whole API; defer
  // to the Node handlers' own requireApiAuth/requireUser (full env there).
  if (verify === "ENV_UNAVAILABLE") return undefined;
  const hasValidUser = Boolean(verify);

  const decision = decideAccess({
    pathname,
    searchParams: url.searchParams,
    hasValidUser,
    hasValidCronSecret,
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
    method: request.method,
  });

  if (decision.allow) return undefined; // continue to the function

  return new Response(
    JSON.stringify({ ok: false, error: "Authentication required." }),
    {
      status: decision.status || 401,
      headers: { "content-type": "application/json" },
    },
  );
}
