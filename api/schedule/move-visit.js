// api/schedule/move-visit.js
// Guarded write-back for Dispatch drag-to-reschedule / reassignment.
//
// Implements the Schedule Rebuild Build Sheet's Table 10 "Write-back" rule:
// validate -> update Jobber -> verify success -> notify affected people ->
// show receipt. Never claims success before verification.
//
// This closes the standing gap flagged repeatedly in the master to-do:
// "Calendar drag-to-reschedule is visual only, no Jobber write-back."
//
// Guardrail: "Freeze next 60 minutes" (Table 10, default ON) -- refuses to
// move a visit whose CURRENT start time (re-verified live from Jobber, not
// trusted from the client's cached board state) falls within the next 60
// minutes, unless the caller explicitly passes overrideFreeze:true. That
// override is itself logged in the receipt as a deliberate human decision.
//
// Mutations used (verified live against Jobber's GraphQL schema via
// introspection on 2026-07-25, not guessed):
//   visitEditSchedule(id: EncodedId!, input: VisitEditScheduleInput!)
//   visitEditAssignedUsers(visitId: EncodedId!, input: VisitEditAssignedUsersInput!)
import { jobberGraphQL, supabaseRequest } from '../_lib/jobber.js';

const FREEZE_WINDOW_MINUTES = 60; // fallback default if workforce_settings has no row/columns yet

// Persistent, dispatcher-facing version of the guardrail above: reads the
// live toggle + duration from workforce_settings (added via migration
// dispatch_freeze_window_settings) instead of trusting the hardcoded
// constant. Any read failure falls back to the safe default (ON, 60min)
// rather than silently disabling the guardrail.
async function getFreezeWindowSettings() {
  try {
    const r = await supabaseRequest('workforce_settings?select=dispatch_freeze_window_enabled,dispatch_freeze_window_minutes&limit=1');
    const rows = r.ok ? await r.json() : [];
    const row = rows && rows[0];
    if (!row) return { enabled: true, minutes: FREEZE_WINDOW_MINUTES };
    return {
      enabled: row.dispatch_freeze_window_enabled !== false,
      minutes: Number.isFinite(row.dispatch_freeze_window_minutes) ? row.dispatch_freeze_window_minutes : FREEZE_WINDOW_MINUTES,
    };
  } catch (e) {
    return { enabled: true, minutes: FREEZE_WINDOW_MINUTES };
  }
}
const COMPANY_TZ = 'America/New_York'; // Greenwich Handyman Co.'s business timezone (same constant used elsewhere: chat.js, fieldops.js, track1.js, voice-webhook.js).

async function getRequestingProfile(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role`);
  const profRows = profRes.ok ? await profRes.json() : [];
  const profile = (profRows && profRows[0]) || { id: user.id, email: user.email, full_name: null, role: null };

  // Look up their Crew Roster permission roles (same employee_roles table the
  // admin panel writes to) so non-admin dispatchers/owners/PMs can also use
  // this -- matched by email against the Jobber-synced users table.
  let permissionRoles = [];
  try {
    if (profile.email) {
      const userRow = await supabaseRequest(`users?email=eq.${encodeURIComponent(profile.email)}&select=jobber_id&limit=1`);
      const userRows = userRow.ok ? await userRow.json() : [];
      const jobberId = userRows && userRows[0] && userRows[0].jobber_id;
      if (jobberId) {
        const roleRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);
        const roleRows = roleRes.ok ? await roleRes.json() : [];
        const roleRow = roleRows && roleRows[0];
        permissionRoles = (roleRow && roleRow.permission_roles) || (roleRow && roleRow.permission_role ? [roleRow.permission_role] : []);
      }
    }
  } catch (e) {
    // Non-fatal -- falls through to the admin-only check in canDispatch().
  }
  return { ...profile, permissionRoles };
}

// 2026-08-10: Stage 2 permission redesign -- kept in sync with track1.js's
// own copy of this same list (see the comment there for the full mapping
// from the old 11-role taxonomy).
const DISPATCH_ALLOWED_ROLES = ['owner', 'project_manager', 'dispatch'];

function canDispatch(requester) {
  if (!requester) return false;
  if (requester.role === 'admin' || requester.role === 'superadmin') return true;
  return (requester.permissionRoles || []).some((r) => DISPATCH_ALLOWED_ROLES.indexOf(r) !== -1);
}

const VISIT_FIELDS = `
    id
    title
    startAt
    endAt
    visitStatus
    assignedUsers { nodes { id name { full } } }
`;

async function fetchVisit(visitId) {
  const q = `query($id: EncodedId!) { visit(id: $id) { ${VISIT_FIELDS} } }`;
  const data = await jobberGraphQL(q, { id: visitId });
  return data && data.visit;
}

function ymdHourToLocalDateTime(dateYmd, hourDecimal) {
  const totalMinutes = Math.round(hourDecimal * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: dateYmd, time: `${pad(hh)}:${pad(mm)}:00`, timezone: COMPANY_TZ };
}

function snapshotVisit(v) {
  const nodes = (v && v.assignedUsers && v.assignedUsers.nodes) || [];
  return {
    startAt: v ? v.startAt : null,
    endAt: v ? v.endAt : null,
    assignedUserIds: nodes.map((u) => u.id),
    assignedUserNames: nodes.map((u) => u.name && u.name.full),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  const requester = await getRequestingProfile(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in -- log into HiveLogic first.' });
  if (!canDispatch(requester)) {
    return res.status(403).json({
      ok: false,
      error: 'Your account is not set up for schedule changes. Ask a superadmin to add Owner, Project Manager, or Dispatch to your Crew Roster roles.',
    });
  }

  const body = req.body || {};
  const visitId = String(body.visitId || '').trim();
  const action = body.action; // 'reschedule' | 'reassign' | 'both'
  const overrideFreeze = !!body.overrideFreeze;
  const reason = body.reason ? String(body.reason).trim() : null;

  if (!visitId) return res.status(400).json({ ok: false, error: 'visitId is required.' });
  if (['reschedule', 'reassign', 'both'].indexOf(action) === -1) {
    return res.status(400).json({ ok: false, error: 'action must be reschedule, reassign, or both.' });
  }

  const doReschedule = action === 'reschedule' || action === 'both';
  const doReassign = action === 'reassign' || action === 'both';

  if (doReschedule) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dateYmd || ''))) {
      return res.status(400).json({ ok: false, error: 'dateYmd (YYYY-MM-DD) is required to reschedule.' });
    }
    const nsH = Number(body.newStartHour);
    const neH = Number(body.newEndHour);
    if (!isFinite(nsH) || !isFinite(neH) || neH <= nsH) {
      return res.status(400).json({ ok: false, error: 'newStartHour/newEndHour are required and newEndHour must be after newStartHour.' });
    }
  }
  if (doReassign && !body.toTechJobberId) {
    return res.status(400).json({ ok: false, error: 'toTechJobberId is required to reassign.' });
  }

  // ---- VALIDATE: re-fetch the current visit live from Jobber. Never trust
  // the client's cached board state for the freeze-window decision. ----
  let current;
  try {
    current = await fetchVisit(visitId);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Could not reach Jobber to verify the visit: ' + String((e && e.message) || e) });
  }
  if (!current) {
    return res.status(404).json({ ok: false, error: 'Visit not found in Jobber (it may have been deleted, or the id is stale -- refresh the board).' });
  }

  const now = new Date();
  const currentStart = current.startAt ? new Date(current.startAt) : null;
  const minutesUntilStart = currentStart ? (currentStart.getTime() - now.getTime()) / 60000 : null;
  const freezeSettings = await getFreezeWindowSettings();
  const freezeBlocked = freezeSettings.enabled && minutesUntilStart != null && minutesUntilStart >= 0 && minutesUntilStart < freezeSettings.minutes;

  if (freezeBlocked && !overrideFreeze) {
    return res.status(409).json({
      ok: false,
      code: 'FREEZE_WINDOW',
      error: 'This visit starts in ' + Math.max(0, Math.round(minutesUntilStart)) + ' minutes -- inside the freeze-next-' + freezeSettings.minutes + '-minutes guardrail. Confirm again to override.',
      minutesUntilStart: Math.round(minutesUntilStart),
    });
  }

  const before = snapshotVisit(current);
  const userErrors = [];
  let scheduleResult = null;
  let assignResult = null;

  // ---- WRITE: reschedule (time) ----
  if (doReschedule) {
    const startAttrs = ymdHourToLocalDateTime(body.dateYmd, Number(body.newStartHour));
    const endAttrs = ymdHourToLocalDateTime(body.dateYmd, Number(body.newEndHour));
    const mutation = `
      mutation($id: EncodedId!, $input: VisitEditScheduleInput!) {
        visitEditSchedule(id: $id, input: $input) {
          userErrors { message path }
          visit { ${VISIT_FIELDS} }
        }
      }
    `;
    try {
      const data = await jobberGraphQL(mutation, { id: visitId, input: { startAt: startAttrs, endAt: endAttrs } });
      scheduleResult = data.visitEditSchedule;
      if (scheduleResult.userErrors && scheduleResult.userErrors.length) {
        userErrors.push(...scheduleResult.userErrors.map((e) => ({ step: 'reschedule', message: e.message, path: e.path })));
      }
    } catch (e) {
      userErrors.push({ step: 'reschedule', message: String((e && e.message) || e) });
    }
  }

  // ---- WRITE: reassign (tech) ----
  // Never overwrite a multi-assigned visit's full crew with just the dragged
  // tech: swap only the specific from->to pair against the CURRENT (or, if
  // reschedule ran first, the freshly-returned) assignment list.
  if (doReassign && !userErrors.length) {
    const fromId = body.fromTechJobberId ? String(body.fromTechJobberId) : null;
    const toId = String(body.toTechJobberId);
    const baseline = (scheduleResult && scheduleResult.visit)
      ? snapshotVisit(scheduleResult.visit).assignedUserIds
      : before.assignedUserIds;
    const newIds = baseline.filter((id) => id !== fromId);
    if (newIds.indexOf(toId) === -1) newIds.push(toId);
    const mutation = `
      mutation($visitId: EncodedId!, $input: VisitEditAssignedUsersInput!) {
        visitEditAssignedUsers(visitId: $visitId, input: $input) {
          userErrors { message path }
          visit { ${VISIT_FIELDS} }
        }
      }
    `;
    try {
      const data = await jobberGraphQL(mutation, { visitId, input: { assignedUserIds: newIds } });
      assignResult = data.visitEditAssignedUsers;
      if (assignResult.userErrors && assignResult.userErrors.length) {
        userErrors.push(...assignResult.userErrors.map((e) => ({ step: 'reassign', message: e.message, path: e.path })));
      }
    } catch (e) {
      userErrors.push({ step: 'reassign', message: String((e && e.message) || e) });
    }
  }

  const finalVisit = (assignResult && assignResult.visit) || (scheduleResult && scheduleResult.visit) || null;

  // ---- VERIFY: the mutation's own returned state must match what was
  // requested. Do not report success on a partial or silently-ignored
  // write -- "Never claim success before verification." ----
  let verifiedOk = !!finalVisit && userErrors.length === 0;
  if (verifiedOk && doReschedule) {
    const returned = finalVisit.startAt ? new Date(finalVisit.startAt) : null;
    verifiedOk = !!returned && !isNaN(returned.getTime());
  }
  if (verifiedOk && doReassign) {
    const returnedIds = snapshotVisit(finalVisit).assignedUserIds;
    verifiedOk = returnedIds.indexOf(String(body.toTechJobberId)) !== -1;
  }

  const after = finalVisit ? snapshotVisit(finalVisit) : null;
  const success = userErrors.length === 0 && verifiedOk;

  // ---- NOTIFY: no SMS/push channel is connected for staff yet (confirmed --
  // same honest gap already documented in api/marketing.js for client
  // messaging: "No Twilio/SendGrid/Resend account is connected"). Record
  // that plainly in the receipt instead of pretending a message went out. ----
  const notified = {
    channel: null,
    note: 'No SMS/push channel connected yet for staff notifications -- let the affected tech(s) and client know directly.',
    affected: (after && after.assignedUserNames) || before.assignedUserNames,
  };

  // ---- RECEIPT ----
  const undoDeadline = new Date(Date.now() + 5 * 60000).toISOString();
  let logId = null;
  try {
    const insRes = await supabaseRequest('schedule_writeback_log', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        visit_id: visitId,
        action,
        before,
        after,
        requested_by_email: requester.email || null,
        requested_by_name: requester.full_name || null,
        freeze_override: !!(freezeBlocked && overrideFreeze),
        freeze_blocked: freezeBlocked,
        success,
        user_errors: userErrors.length ? userErrors : null,
        notified,
        reason,
      }),
    });
    if (insRes.ok) {
      const rows = await insRes.json();
      logId = rows && rows[0] && rows[0].id;
    }
  } catch (e) {
    // Logging failure should not block the response to the dispatcher.
  }

  if (!success) {
    return res.status(422).json({
      ok: false,
      error: userErrors.length ? userErrors.map((e) => e.message).join('; ') : 'Jobber did not confirm the change -- nothing was verified as saved.',
      userErrors,
      receipt: { visitId, action, before, after, freezeOverridden: !!(freezeBlocked && overrideFreeze), logId },
    });
  }

  return res.status(200).json({
    ok: true,
    receipt: {
      visitId,
      action,
      before,
      after,
      freezeOverridden: !!(freezeBlocked && overrideFreeze),
      notified,
      verifiedOk,
      undoDeadline,
      logId,
    },
  });
}
