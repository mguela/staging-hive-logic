// api/_lib/permission-roles.js
//
// Shared lookup for a signed-in profile's granular job-function role(s) --
// owner/partner/office_manager/dispatch/accounting/project_manager/... on
// employee_roles.permission_roles. profiles and employee_roles don't share a
// key directly, so this goes through users.email -> jobber_id first. Same
// lookup api/track1.js's getDispatchPermissionRoles already does (kept there
// unduplicated to avoid touching a file already carrying today's other
// fixes); centralized here so new callers (subportal.js, clientportal.js)
// share one implementation instead of each reinventing it. This does NOT
// create a dependency between those two files on each other or on
// track1.js -- both depend on this shared helper the same way both already
// depend on _lib/jobber.js's supabaseRequest.
import { supabaseRequest } from './jobber.js';

export async function getPermissionRoles(profile) {
  if (!profile || !profile.email) return [];
  try {
    const userRes = await supabaseRequest(`users?email=eq.${encodeURIComponent(profile.email)}&select=jobber_id&limit=1`);
    const userRows = userRes.ok ? await userRes.json() : [];
    const jobberId = userRows && userRows[0] && userRows[0].jobber_id;
    if (!jobberId) return [];
    const roleRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);
    const roleRows = roleRes.ok ? await roleRes.json() : [];
    const roleRow = roleRows && roleRows[0];
    return (roleRow && roleRow.permission_roles) || (roleRow && roleRow.permission_role ? [roleRow.permission_role] : []);
  } catch (e) {
    return [];
  }
}

// requester.role is the coarse profiles.role login flag ('superadmin'/'admin'/
// 'crew') -- 'admin' and 'superadmin' always pass, same bypass track1.js's
// canManageDispatchSettings uses. Otherwise the requester needs at least one
// of the granular permission_roles values in allowedRoles.
export async function hasAllowedRole(requester, allowedRoles) {
  if (!requester) return false;
  if (requester.role === 'admin' || requester.role === 'superadmin') return true;
  const roles = await getPermissionRoles(requester);
  return roles.some((r) => allowedRoles.indexOf(r) !== -1);
}
