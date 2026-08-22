#!/usr/bin/env node
// scripts/check-branch-merged.mjs
//
// Canonical "is this branch merged?" check. Use this instead of asking GitHub
// whether a PR exists for the branch name.
//
// Why this exists (2026-08-15): a branch review reported the 5 Hive Marketing
// commits on feature/hive-marketing-native as unmerged when they had in fact
// already landed on main. Root cause: the check was a name-keyed PR lookup --
//
//     gh pr list --head feature/hive-marketing-native --state merged   ->  []
//
// -- which returned empty because the PR had been opened from a *different*
// head branch. The work was synced onto chore/hive-marketing-native-sync and
// merged as PR #207; feature/hive-marketing-native itself was never updated or
// deleted, so it kept looking open forever. A name-keyed lookup also misses
// squash merges, rebase merges, renamed branches, and merges made from forks.
//
// Commit containment is the only test that is correct in all of those cases:
// if the branch tip is reachable from origin/main, the work is on main, no
// matter how it got there.
//
// Two rules this script enforces so the same class of bug cannot recur:
//   1. It fetches before checking, so it never reads a stale origin/main.
//   2. It refuses to compare against a LOCAL branch ref by default. On this
//      machine the primary clone's local `main` sat 11 days behind origin at
//      the time of writing; comparing against it reported 57 commits ahead for
//      a branch that was fully merged.
//
// Usage:
//   node scripts/check-branch-merged.mjs <branch> [--base origin/main]
//                                                 [--no-fetch] [--allow-local-base]
//
// Exit codes: 0 = merged, 1 = not merged, 2 = usage/lookup error.

import { execFileSync } from 'node:child_process';

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    console.error(`git ${args.join(' ')} failed:\n${detail}`);
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const baseIdx = argv.indexOf('--base');
const base = baseIdx !== -1 ? argv[baseIdx + 1] : 'origin/main';
const branch = positional.filter((a) => a !== base)[0];

if (!branch) {
  console.error('usage: node scripts/check-branch-merged.mjs <branch> [--base origin/main] [--no-fetch] [--allow-local-base]');
  process.exit(2);
}

// Guard: comparing against a local ref is how you get wildly inflated
// "unmerged" lists from a clone whose main has not been pulled in days.
if (!base.startsWith('origin/') && !flags.has('--allow-local-base')) {
  console.error(
    `Refusing to compare against '${base}': it is not an origin/* ref.\n` +
    `Local branch refs go stale and produce false "unmerged" results.\n` +
    `Use --base origin/<name>, or pass --allow-local-base if you really mean it.`
  );
  process.exit(2);
}

if (!flags.has('--no-fetch')) {
  git(['fetch', 'origin', '--quiet', '--prune']);
}

// Resolve the branch tip. Accept a bare name, an origin/ name, or a full ref.
let tip = null;
let resolvedAs = null;
for (const candidate of [branch, `origin/${branch}`, `refs/heads/${branch}`]) {
  const sha = git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFail: true });
  if (sha) {
    tip = sha;
    resolvedAs = candidate;
    break;
  }
}

if (!tip) {
  console.error(`Could not resolve branch '${branch}' locally or on origin.`);
  console.error('If the branch was deleted after merging, that itself usually means it landed.');
  process.exit(2);
}

const baseSha = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true });
if (!baseSha) {
  console.error(`Could not resolve base '${base}'.`);
  process.exit(2);
}

const merged = git(['merge-base', '--is-ancestor', tip, base], { allowFail: true }) !== null;

console.log(`branch : ${branch}  (resolved via ${resolvedAs}, ${tip.slice(0, 7)})`);
console.log(`base   : ${base}  (${baseSha.slice(0, 7)})`);

if (merged) {
  console.log(`result : MERGED -- every commit on ${branch} is reachable from ${base}.`);
  console.log('         Safe to delete the branch; no commits would be lost.');
  process.exit(0);
}

const ahead = git(['rev-list', '--count', `${base}..${tip}`]);
console.log(`result : NOT MERGED -- ${ahead} commit(s) on ${branch} are absent from ${base}.`);
console.log('');
console.log('unmerged commits:');
const log = git(['log', '--oneline', '--no-decorate', `${base}..${tip}`]);
console.log(log ? log.split('\n').map((l) => `  ${l}`).join('\n') : '  (none)');
process.exit(1);
