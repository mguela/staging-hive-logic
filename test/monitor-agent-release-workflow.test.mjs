// test/monitor-agent-release-workflow.test.mjs
//
// A release process only one machine can perform is a release process that
// does not happen.
//
// 1.2.4 -- the consent dialog that WARNS people before they decline, and the
// version reporting that shows a rollout actually happening -- sat unreleased
// while the server had already begun clocking people out for declining. Not
// because anything was hard: because shipping meant "build it by hand on
// Windows, then copy three files into a different repository", and every
// attempt landed in the wrong folder or the wrong repo. Three rounds, nothing
// published, and no error anywhere to explain it.
//
// So the build moved to a Windows runner in CI. These tests defend the parts
// that would fail quietly if they rotted: building the wrong version, letting
// electron-builder publish itself somewhere nobody looks, and -- the one that
// bit us -- a run that reports success while publishing nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WF = '.github/workflows/monitor-agent-release.yml';
const yml = fs.readFileSync(WF, 'utf8');

test('the installer is built on Windows, because that is what it is', () => {
  assert.match(yml, /runs-on: windows-latest/,
    'an .exe cannot be cross-built from the ubuntu runners the other workflows use');
});

test('a version bump alone is enough to ship', () => {
  // The whole point: no machine, no toolchain, no remembered steps.
  assert.match(yml, /paths:\s*\n\s*- 'hivelogic-monitor-agent\/\*\*'/);
  assert.match(yml, /workflow_dispatch:/, 'and it must be runnable by hand when something needs re-doing');
});

test('electron-builder is stopped from publishing on its own', () => {
  // It self-publishes when it detects CI, using the publish block in
  // package.json -- which would race this workflow and upload to a release
  // this one has not verified.
  assert.match(yml, /npm run build:win -- --publish never/);
});

test('the build is checked to be the version that was asked for', () => {
  assert.match(yml, /WANT="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.match(yml, /if \[ "\$WANT" != "\$GOT" \]; then/,
    'shipping a build that silently is not the version you bumped is the failure this whole area keeps producing');
});

test('a missing token warns loudly instead of failing silently', () => {
  // GITHUB_TOKEN cannot reach another repository, so publishing needs a PAT.
  // Without one the build must still hand you something usable and say what
  // is missing -- not exit 0 having done nothing, which is exactly how the
  // old release workflow wasted three attempts.
  assert.match(yml, /if \[ -z "\$\{TOKEN:-\}" \]; then/);
  assert.match(yml, /::warning::MONITOR_RELEASE_TOKEN is not set/);
  assert.match(yml, /Add a fine-grained PAT with Contents: Read and write/,
    'the remedy has to be in the message, not in someone\'s memory');
});

test('the installer is kept even when publishing cannot happen', () => {
  const upload = yml.indexOf('upload-artifact');
  const publish = yml.indexOf('Publish to csk5369/hivelogic-monitor');
  assert.ok(upload > 0 && publish > 0, 'both steps must exist');
  assert.ok(upload < publish,
    'upload must come FIRST, so a failed push still leaves an installer you can use by hand');
  assert.match(yml, /if-no-files-found: error/, 'an empty upload must not pass for a successful one');
});

test('an unchanged build does not create an empty commit', () => {
  assert.match(yml, /if git diff --cached --quiet; then/);
  assert.match(yml, /already identical to this build/);
});

test('the one-time setup is written where whoever hits it will be looking', () => {
  assert.match(yml, /MONITOR_RELEASE_TOKEN/);
  assert.match(yml, /GITHUB_TOKEN cannot be used/,
    'the reason a PAT is needed at all must be stated, or someone will try to remove it');
});

test('the agent version and the server constant still agree', () => {
  // Belt and braces with agent-version-reporting.test.mjs: this workflow ships
  // whatever package.json says, and the server decides who is stale from
  // EXPECTED_AGENT_VERSION. If those drift, the release is fine and the health
  // check lies about it.
  const pkg = JSON.parse(fs.readFileSync('hivelogic-monitor-agent/package.json', 'utf8'));
  const lib = fs.readFileSync('api/_lib/agent-version.js', 'utf8');
  assert.match(lib, new RegExp(`EXPECTED_AGENT_VERSION = '${pkg.version.replace(/\./g, '\\.')}'`));
});

// --- The fallback that makes the token optional ----------------------------
//
// The cross-repo PAT is one manual step, and one manual step is exactly what
// stalled 1.2.4 for a day. So when the secret is absent the installer is
// committed to an orphan branch of THIS repo instead, which GITHUB_TOKEN can
// write and which anything that can clone can then forward to the public repo.
// An artifact could not serve that purpose: it expires, and fetching one needs
// a browser or an API token.

test('a missing token stages the build somewhere reachable, not just an artifact', () => {
  assert.match(yml, /Stage the installer on the agent-dist branch/);
  assert.match(yml, /if: needs\.build\.outputs\.has_release_token != 'true'/,
    'it must run only when the direct path is unavailable, never alongside it');
  assert.match(yml, /HEAD:refs\/heads\/agent-dist/);
});

test('the staging branch is an orphan, so the installer stays out of main', () => {
  const step = yml.slice(yml.indexOf('Stage the installer on the agent-dist branch'));
  assert.match(step, /git init -q/, 'a fresh repo, not a branch off main -- 80MB must not enter the shared history');
  assert.match(step, /--force/, 'it is a drop box for the latest build, not a history');
});

test('both publish paths agree on which files matter', () => {
  for (const f of ['HiveLogic-Monitor-Setup.exe', 'latest.yml']) {
    const occurrences = yml.split(f).length - 1;
    assert.ok(occurrences >= 3, `${f} must appear in the build check, the staging path and the publish path`);
  }
});

test('no step condition uses the secrets context, which Actions cannot parse', () => {
  // GitHub allows `secrets` in env and with, and REFUSES THE WHOLE WORKFLOW if
  // it appears in a step-level `if:` -- "Unrecognized named-value: 'secrets'".
  // The first version of this file did exactly that, so nothing could run at
  // all, including the paths that had nothing to do with the secret. The
  // earlier test asserted the literal string and happily passed on a workflow
  // GitHub would not accept.
  const stepIfs = [...yml.matchAll(/^\s*if:\s*(.+)$/gm)].map((m) => m[1]);
  for (const cond of stepIfs) {
    assert.doesNotMatch(cond, /secrets\./, `step condition uses the secrets context: ${cond}`);
  }
  assert.match(yml, /HAS_RELEASE_TOKEN: \$\{\{ secrets\.MONITOR_RELEASE_TOKEN != '' \}\}/,
    'resolve it once in job-level env, where the context is allowed');
});

test('the staging fallback is granted the write it needs', () => {
  // The run that finally parsed built the installer, uploaded it, and then
  // died pushing agent-dist: "Write access to repository not granted." The
  // workflow declared contents: read. Eight minutes of Windows build time
  // spent to discover a one-word permission -- and the failure lands at the
  // very last step, where it costs the most to find out.
  const buildStart = yml.indexOf('\n  build:');
  const stageStart = yml.indexOf('\n  stage_fallback:');
  const build = yml.slice(buildStart, stageStart);
  const stage = yml.slice(stageStart);
  assert.match(yml, /permissions:\s*\n\s*contents: read/,
    'the default and dependency-bearing build must stay read-only');
  assert.doesNotMatch(build, /contents: write/,
    'npm and the Windows build must never inherit repository write access');
  assert.match(stage, /permissions:\s*\n\s*contents: write/,
    'only the isolated agent-dist push job needs repository write access');
  assert.match(build, /persist-credentials: false/,
    'the read-only checkout token should not persist into package scripts');
  assert.match(stage, /uses: actions\/download-artifact@v4/,
    'the writer must consume the verified artifact instead of rebuilding it');
  assert.match(build, /has_release_token: \$\{\{ steps\.release_token\.outputs\.present \}\}/,
    'the write job condition must consume a non-secret boolean output');
});
