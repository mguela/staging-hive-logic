// api/_lib/monitor-consent.js
//
// What monitoring is allowed to do for one person, on one clock-in.
//
// Chris, 2026-08-17: "only when an employee is clocked in should it monitor. if
// an employee is clocked in they must approve monitoring or it can't clock in.
// this also needs to be set in permissions as you setup the user."
//
// WHAT WAS WRONG BEFORE. The consent dialog said:
//
//   "HiveLogic Monitor will record activity level and periodic screenshots
//    while you're clocked in... Allow monitoring for this clock-in?"
//                                       [Allow monitoring] [Not this time]
//
// "Not this time" stopped the screenshots and nothing else. Activity samples --
// activity level, idle seconds, and which application was in front -- were
// written by handleMonitorHeartbeat BEFORE it ever looked at consent, so they
// kept recording for the whole shift. Chris's 2026-08-17 06:33 session was
// declined and still logged 176 samples over three hours. The same hole sat
// under the admin off-switch: monitoring_enabled = false suppressed capture but
// not sampling, so "monitoring is off for this person" was also untrue.
//
// A consent prompt that records you anyway is worse than no prompt, because it
// buys agreement it does not honour. So recording of ANY kind now requires an
// explicit 'allowed' for this clock-in's session.
//
// THE ONE PERMISSION:
//
//   monitoring_enabled  -- is this person monitored? True by default. False
//                          means no prompt, no recording, and no idle
//                          timeout, because with nothing watching the machine
//                          there is no honest basis for one.
//
// Per-user and set when the account is created, so the answer is a deliberate
// choice for each person rather than a global assumption. There was briefly a
// second column, monitoring_required; see monitoringPolicy below for why it
// had to go.
//
// LIMIT, stated deliberately. Consent is asked by the desktop agent AFTER the
// clock-in exists -- the monitor session is created on the agent's next
// heartbeat -- so "can't clock in" is enforced as "can't STAY clocked in": the
// decline closes the session. Blocking the clock-in itself would mean nobody
// could start work while the desktop app was closed, updating, or crashed,
// which turns a monitoring outage into a payroll outage. An agent that never
// asks is a different failure and is surfaced as one (health-cron reports
// paired-but-not-running agents), not by locking people out of the timeclock.

// Written to workforce_time_sessions.close_reason so a decline is
// distinguishable from an idle timeout or a browser close in the timesheet.
export const CLOSE_REASON_DECLINED = 'monitoring_declined';

// Ways a clock-in can end that the person did not choose, and would otherwise
// have to guess at. handleWorkforceStatus reports the most recent of these back
// to the browser so the app can say what happened, rather than leaving someone
// to notice on their own that they are no longer on the clock.
//
// 'browser_closed' is absent deliberately: closing your browser is a thing you
// did, and the sweep that acts on it is already explained by the act itself.
export const CLOSE_REASONS_WORTH_EXPLAINING = [CLOSE_REASON_DECLINED, 'idle_timeout'];

// How long after the fact the app still volunteers an explanation. Long enough
// to survive making coffee, reopening a laptop, or a slow morning login; short
// enough that a decline from last Tuesday stays history instead of greeting
// someone days later.
export const CLOSE_NOTICE_WINDOW_MINUTES = 90;

// The words shown for each. Written here, beside the rule they explain, so a
// reason can never be enforced in one place and described in another.
export function closeReasonNotice(reason) {
  if (reason === CLOSE_REASON_DECLINED) {
    return {
      title: 'You were clocked out',
      body: 'Monitoring is required for your account, and it was declined on this device, so the clock-in ended. Clock back in whenever you\'re ready to allow it — nothing is recorded unless you do.',
    };
  }
  if (reason === 'idle_timeout') {
    return {
      title: 'You were clocked out',
      body: 'There was no activity on your machine for long enough to hit the idle limit, so the clock-in ended automatically. Clock back in to pick up where you left off.',
    };
  }
  return null;
}

// ONE permission, not two.
//
// There used to be a second column, monitoring_required, letting an admin say
// "monitored, but declining is fine". Chris, 2026-08-18: "monitoring should
// only work when clocked in, you can't clock in without approving monitoring
// ... every other user is monitored by default but the owner can change
// permissions and unselect monitoring if they choose to."
//
// So the two settings collapse into one question -- is this person monitored?
// -- and being monitored means agreeing is a condition of being on the clock.
// The exempt case is not "monitored but allowed to refuse"; it is "not
// monitored", which is monitoring_enabled = false.
//
// That combination -- clocked in, monitored, declined -- was not a harmless
// middle ground. It was the state Chris's own account sat in, and it is what
// broke the idle timeout: no consent meant no activity samples, no samples
// meant no machine-wide witness, and the browser fell back to watching one
// tab and clocked him out three times while he was working. A state that
// nothing downstream can cope with should not be reachable.
//
// Permissive about the column being absent (a profile row read before the
// migration, or the fallback getRequestingProfile returns when the lookup
// fails) and strict about what it means: monitored unless someone turned it
// off.
export function monitoringPolicy(profile) {
  const enabled = !profile || profile.monitoring_enabled !== false;
  // Monitored implies required. Not a stored column any more -- a value that
  // can only ever equal `enabled` is a value that can drift from it.
  return { enabled, required: enabled };
}

// The complete answer for one heartbeat: may we sample, may we screenshot, and
// does this clock-in have to end.
//
// `consent` is monitor_sessions.consent: 'pending' | 'allowed' | 'denied'.
// Pending records NOTHING -- the dialog is still on screen and the person has
// not agreed yet. Treating silence as agreement is the same broken promise in
// a smaller window.
export function monitoringDecision(profile, consent) {
  const { enabled, required } = monitoringPolicy(profile);
  const allowed = enabled && consent === 'allowed';
  return {
    enabled,
    required,
    prompt: enabled && consent === 'pending',
    recordActivity: allowed,
    captureScreenshots: allowed,
    clockOut: enabled && required && consent === 'denied',
  };
}
