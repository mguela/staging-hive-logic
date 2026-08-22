// scripts/pr-health.mjs
//
// Decide whether an open pull request is actually being tested.
//
// WHY THIS EXISTS
//
// On 2026-08-18, four open PRs in this repo were sitting with a single green
// check -- "Vercel Preview Comments" -- and no test run at all. The PR page
// reads as healthy. It is not: a conflicted PR has no merge ref, so GitHub
// cannot build the merge commit that `on: pull_request` workflows run against,
// and the test jobs never start. Nothing says so. The only signal is an
// absence, and absences do not show up on a dashboard.
//
// #198 sat that way for four days holding a migration that would have stripped
// six of nine permission roles. #414 and #303 sat that way holding work that
// had already shipped by another route, so the backlog looked busier than it
// was. And #453 -- opened an hour after all of that was diagnosed -- did it
// again, because main moved while it was being written.
//
// THE CHECK IS "UNTESTED", NOT "CONFLICTED"
//
// Conflict is a CAUSE. The harm is the absence of a test run, and it has other
// causes: a workflow that failed to trigger, a run cancelled by concurrency and
// never retried, a fork PR whose workflows need approval. Detecting the harm
// directly catches all of them; detecting only conflicts catches one.
//
// WHAT IS DELIBERATELY NOT FLAGGED
//
//   * mergeable_state 'unknown' -- GitHub computes mergeability lazily, and a
//     PR read too soon reports 'unknown' whether or not it conflicts. Calling
//     that a conflict would cry wolf on every freshly-pushed PR. Unknown means
//     unknown; the next run will know.
//   * a PR younger than the grace window -- checks take minutes to register,
//     and a PR opened ninety seconds ago has no runs yet for a good reason.
//   * a FAILING required check -- that is a red X on the PR. It is visible,
//     someone can act on it, and it is not this guard's problem. This guard
//     exists for the state that looks like nothing is wrong.
//
// The decision logic lives here as pure functions so it can be tested without
// a network or the Actions runtime; .github/workflows/pr-health-guard.yml is
// the thin caller.

/** Required checks, matched by exact name against the runs on a head commit. */
export const REQUIRED_CHECKS = Object.freeze([
  'Full regression (required for DONE)',
  'Schedule board UI (real browser)',
]);

export const DEFAULT_OPTIONS = Object.freeze({
  // A PR needs time to register its runs before absence means anything.
  graceMinutes: 60,
  // A conflict is worth reporting sooner than a whole day -- CI is blocked the
  // entire time -- but not so soon that it fires while someone is mid-rebase.
  conflictGraceHours: 6,
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Names of required checks that have no run on this commit, completed or not. */
export function missingRequiredChecks(checkRuns, required = REQUIRED_CHECKS) {
  const seen = new Set(
    (Array.isArray(checkRuns) ? checkRuns : [])
      .map((run) => run && run.name)
      .filter((name) => typeof name === 'string'),
  );
  return required.filter((name) => !seen.has(name));
}

/**
 * Classify one open PR.
 *
 * @param {object} pr
 * @param {string} pr.mergeableState  GitHub's mergeable_state ('dirty', 'clean', 'unknown', ...)
 * @param {Array}  pr.checkRuns       check runs on the PR's head commit
 * @param {string} pr.updatedAt       ISO timestamp of the PR's last update
 * @param {number} now                current epoch ms
 * @returns {{status:'ok'|'conflicted'|'untested'|'indeterminate', reason:string, missing:string[]}}
 */
export function classifyPr(pr, now = Date.now(), options = {}) {
  const { graceMinutes, conflictGraceHours } = { ...DEFAULT_OPTIONS, ...options };
  const missing = missingRequiredChecks(pr && pr.checkRuns);
  const updated = pr && pr.updatedAt ? new Date(pr.updatedAt).getTime() : NaN;
  const ageMs = Number.isFinite(updated) ? now - updated : null;

  if (ageMs === null) {
    // No usable timestamp: refuse to guess rather than flag on a bad clock.
    return { status: 'indeterminate', reason: 'no usable updated_at timestamp', missing };
  }

  if (pr.mergeableState === 'dirty') {
    if (ageMs < conflictGraceHours * HOUR) {
      return {
        status: 'ok',
        reason: `conflicted, but within the ${conflictGraceHours}h grace window`,
        missing,
      };
    }
    return {
      status: 'conflicted',
      reason: 'merge conflict with the base branch, so no merge ref exists and '
        + '`on: pull_request` workflows cannot run at all',
      missing,
    };
  }

  // 'unknown' is GitHub still computing. Not evidence of anything.
  if (pr.mergeableState === 'unknown' && missing.length === 0) {
    return { status: 'ok', reason: 'mergeability not yet computed; required checks present', missing };
  }

  if (missing.length > 0) {
    if (ageMs < graceMinutes * MINUTE) {
      return { status: 'ok', reason: `missing checks, but within the ${graceMinutes}m grace window`, missing };
    }
    return {
      status: 'untested',
      reason: `no run on the head commit for: ${missing.join(', ')}`,
      missing,
    };
  }

  return { status: 'ok', reason: 'required checks are present on the head commit', missing };
}

/** The PRs a run should report on, in the order they should be reported. */
export function selectFlagged(prs, now = Date.now(), options = {}) {
  return (Array.isArray(prs) ? prs : [])
    .map((pr) => ({ pr, verdict: classifyPr(pr, now, options) }))
    .filter(({ verdict }) => verdict.status === 'conflicted' || verdict.status === 'untested');
}

/** Marker that lets a later run find and update its own comment. */
export const COMMENT_MARKER = '<!-- hl-pr-health-guard -->';

export function renderComment(pr, verdict) {
  const heading = verdict.status === 'conflicted'
    ? '### ⚠ This PR is conflicted, so **CI is not running on it**'
    : '### ⚠ This PR has **no test run** on its head commit';

  // A conflicted PR splits into two genuinely different situations, and saying
  // the wrong one costs the guard its credibility. #482 was the first PR this
  // guard ever commented on, and it got this wrong: both required checks HAD
  // run -- green, on the real head commit, from before main moved underneath it
  // -- while the comment said "the test jobs never start" and "any green check
  // you see here is not a test result". A monitor that overstates what it
  // measured is the exact failure class this repo keeps getting bitten by, and
  // the cure for a guard that cries wolf is being muted.
  const conflictedBody = verdict.missing.length === 0
    ? 'A conflicted PR has no merge ref, so GitHub cannot build the merge commit that '
      + '`on: pull_request` workflows run against. **No further check can run here until the '
      + 'conflict is resolved.**\n\nThe required checks did already run on this head commit — '
      + 'but against a merge '
      + 'with an *older* base, so they say nothing about how this branch behaves on top of '
      + 'the base branch as it stands now.\n\nMerge the base branch in (or rebase) and the '
      + 'checks will re-run on the next push.'
    : 'A conflicted PR has no merge ref, so GitHub cannot build the merge commit that '
      + '`on: pull_request` workflows run against. The test jobs never start — and nothing '
      + 'says so. Any green check you see here (a preview deployment, for instance) is not a '
      + 'test result.\n\nMerge the base branch in (or rebase) and the checks will start on the '
      + 'next push.';

  const body = verdict.status === 'conflicted'
    ? conflictedBody
    : 'The required checks have not run on this commit, so nothing here has been verified. '
      + 'This is not the same as a failing check — a red X is visible and actionable; this '
      + 'looks like nothing is wrong.\n\nCommon causes: the run was cancelled by concurrency '
      + 'and never retried, or the workflow did not trigger. Pushing an empty commit is enough '
      + 'to re-trigger it.';

  const missing = verdict.missing.length
    ? `\n\n**Required checks with no run:**\n${verdict.missing.map((m) => `- \`${m}\``).join('\n')}`
    : '';

  return `${COMMENT_MARKER}\n${heading}\n\n${body}${missing}\n\n`
    + '<sub>Posted by the PR health guard, which looks for PRs that are not being tested rather '
    + 'than PRs that are failing. It updates this comment in place rather than adding new ones.</sub>';
}

export function renderResolvedComment() {
  return `${COMMENT_MARKER}\n### ✅ Resolved — the required checks are running on this PR again\n\n`
    + '<sub>Posted by the PR health guard.</sub>';
}
