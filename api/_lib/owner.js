// api/_lib/owner.js
//
// Who owns the company, and what that means for the timeclock.
//
// Chris, 2026-08-18: "monitoring should only work when clocked in, you can't
// clock in without approving monitoring ... If it's an Owner, Rich or I, we'll
// likely never clock in and we'll never want to be monitored," and then:
// "forget us, think production ready product. the owner is classified by role
// designated in user setup and company setup."
//
// SO THIS IS NOT A NEW ROLE. employee_roles.permission_roles already carries
// 'owner' alongside design_sales, office_manager, dispatch and the rest, and it
// is already populated -- Chris Kendall and Lori Kendall both hold it, sourced
// from the same user setup Chris was describing. Adding a fourth value to
// profiles.role ('crew'/'admin'/'superadmin') would have meant editing every
// one of the ~20 gates that read `role === 'admin' || role === 'superadmin'`,
// and any one of them missed would have locked an owner out of their own app.
// The concept already existed; this file just gives it teeth.
//
// WHAT BEING AN OWNER DOES: it takes you out of the timeclock. Owners do not
// clock in, so -- because monitoring only ever runs during a clock-in -- they
// are never monitored, never prompted for consent, and can never be caught by
// the idle timeout. One rule, and the other three fall out of it rather than
// each needing to be remembered separately.
//
// Enforced server-side and not merely hidden in the UI. The End-of-Day report
// exemption was frontend-only once before (2026-08-16) and produced a clock-out
// that could neither be completed nor satisfied, because the server half had no
// idea the exemption existed.

import { getPermissionRoles } from './permission-roles.js';

export const OWNER_PERMISSION_ROLE = 'owner';

// Owners are read from the granular permission roles, so "who is an owner" has
// exactly one source and cannot drift from what user setup says. Async because
// that lookup is a join through users.email -> employee_roles; callers that
// need it per-request should already be reading the profile anyway.
export async function isOwner(profile, roles = null) {
  if (!profile) return false;
  const list = roles || await getPermissionRoles(profile);
  return Array.isArray(list) && list.includes(OWNER_PERMISSION_ROLE);
}

// Said once, here, so the clock-in refusal and the UI that hides the button
// cannot describe the same rule differently.
export const OWNER_NO_CLOCK_IN_MESSAGE =
  'Owners are not on the timeclock, so there is nothing to clock in to. Nothing is monitored or recorded for an owner account.';
