#!/usr/bin/env node
// scripts/stamp-page-build.mjs
//
// Recompute the page build id and write it into both places that hold it:
// the HL_PAGE_BUILD literal in public/index.html and PAGE_BUILD in
// api/_lib/page-build.js.
//
// Run this after ANY edit to public/index.html OR to any same-origin script or
// stylesheet the page loads -- public/app-*.js, public/reina-*.js, the .css
// files, public/hiveconnect/* and public/views/*, and so on. The list is read
// out of the source (declared tags, then absolute path literals inside those
// scripts, followed transitively), so it is never out of date.
// test/page-build-marker.test.mjs fails CI if you forget, which
// is deliberate -- a marker that can silently go stale is worse than no marker,
// because it would report "current" while lying, and this whole mechanism
// exists because we believed exactly that kind of unfounded claim once already
// (see api/_lib/page-build.js).
//
//   node scripts/stamp-page-build.mjs           # write the new id
//   node scripts/stamp-page-build.mjs --check   # exit 1 if it would change
//   node scripts/stamp-page-build.mjs --list    # print what is being hashed
//
// Exit codes: 0 = already correct / written, 1 = drift found in --check mode.

import fs from 'node:fs';
// api/_lib/page-build.js is imported LATER, on purpose -- see the conflict
// handling below. It is one of the two files that can carry a conflict, and a
// static import of a file containing `<<<<<<<` is a SyntaxError thrown before
// any of this runs, so the tool that exists to fix the conflict would die on
// it. Found by testing exactly that case rather than assuming.

const HTML = 'public/index.html';
const LIB = 'api/_lib/page-build.js';
const LIB_MARKER = /export const PAGE_BUILD = '([0-9a-f]{16})';/;

const checkOnly = process.argv.includes('--check');
const listOnly = process.argv.includes('--list');

// --- Merge conflicts on the id itself --------------------------------------
//
// The id is a DERIVED value kept in SOURCE, on one line, in two files. Any two
// branches that touch public/index.html both re-stamp it, so they both rewrite
// that line, so they conflict -- every time, by construction. That happened
// five times in one evening on 2026-08-18, and each one cost more than the
// conflict itself: GitHub dispatches NO checks at all for a PR it cannot merge,
// so the pull request shows an empty check list, which is indistinguishable
// from "the gate has not started yet". Twice I waited on a run that was never
// going to come.
//
// Resolving it by hand is pure ceremony -- BOTH sides are wrong the moment the
// branches combine, because the correct id is the hash of the merged files,
// which neither side has seen. So this does it: strip the markers, then stamp
// the real answer over whatever was left.
//
// STRICTLY LIMITED, and this is the important part. It only touches hunks whose
// two sides are both nothing but a build-id line. A conflict anywhere else in
// a 27,000-line HTML file is a real conflict about real content, and quietly
// picking a side would be the kind of silent wrong answer this whole marker
// exists to prevent. Anything else, it refuses and says where to look.
const CONFLICT = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;
const BUILD_ID_LINE = /^\s*(var HL_PAGE_BUILD = '[0-9a-f]*';|export const PAGE_BUILD = '[0-9a-f]*';)\s*$/;

function isJustABuildId(side) {
  const lines = side.split('\n').filter((l) => l.trim() !== '');
  return lines.length === 1 && BUILD_ID_LINE.test(lines[0]);
}

/** Returns the text with build-id conflicts resolved, or throws naming the rest. */
function resolveBuildIdConflicts(text, file) {
  if (!text.includes('<<<<<<<')) return text;
  const foreign = [];
  const out = text.replace(CONFLICT, (whole, ours, theirs) => {
    if (isJustABuildId(ours) && isJustABuildId(theirs)) return ours;
    foreign.push(whole.split('\n')[0]);
    return whole;
  });
  if (foreign.length) {
    throw new Error(
      `${file}: ${foreign.length} conflict(s) that are not the build id -- resolve those by hand first.\n`
      + `  ${foreign.join('\n  ')}`);
  }
  return out;
}

let html = fs.readFileSync(HTML, 'utf8');
let lib = fs.readFileSync(LIB, 'utf8');

const hadConflict = html.includes('<<<<<<<') || lib.includes('<<<<<<<');
if (hadConflict) {
  try {
    html = resolveBuildIdConflicts(html, HTML);
    lib = resolveBuildIdConflicts(lib, LIB);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (checkOnly) {
    console.error('page build: unresolved merge conflict on the id. Run: node scripts/stamp-page-build.mjs');
    process.exit(1);
  }
  fs.writeFileSync(HTML, html, 'utf8');
  fs.writeFileSync(LIB, lib, 'utf8');
  console.log('page build: merge conflict on the id resolved (both sides were stale); re-stamping.');
}

// Safe to load now: whatever conflicts existed in it are gone.
const { computePageBuild, loadPageAssets, PAGE_BUILD_MARKER } = await import('../api/_lib/page-build.js');

if (!PAGE_BUILD_MARKER.test(html)) {
  console.error(`${HTML}: no HL_PAGE_BUILD marker found -- it must not be removed.`);
  process.exit(1);
}
if (!LIB_MARKER.test(lib)) {
  console.error(`${LIB}: no PAGE_BUILD literal found -- it must not be removed.`);
  process.exit(1);
}

// Throws, loudly, if the page references a script or stylesheet that is not
// there -- better than stamping an id that quietly covers less than it claims.
const assets = loadPageAssets(html);

if (listOnly) {
  console.log(`${HTML} + ${assets.length} same-origin assets:`);
  for (const a of assets) console.log(`  ${a.via.padEnd(8)}  public/${a.path}`);
  process.exit(0);
}

const expected = computePageBuild(html, assets);
const inHtml = html.match(PAGE_BUILD_MARKER)[1];
const inLib = lib.match(LIB_MARKER)[1];

if (inHtml === expected && inLib === expected) {
  console.log(`page build ${expected} -- already stamped (${HTML} + ${assets.length} assets).`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`page build drift: expected ${expected}, found ${inHtml} in ${HTML} and ${inLib} in ${LIB}.`);
  console.error(`Hashed: ${HTML} + ${assets.length} same-origin assets (see --list).`);
  console.error('Run: node scripts/stamp-page-build.mjs');
  process.exit(1);
}

fs.writeFileSync(HTML, html.replace(PAGE_BUILD_MARKER, `var HL_PAGE_BUILD = '${expected}';`), 'utf8');
fs.writeFileSync(LIB, lib.replace(LIB_MARKER, `export const PAGE_BUILD = '${expected}';`), 'utf8');
console.log(`page build stamped: ${inHtml} -> ${expected} (${HTML} + ${assets.length} assets).`);
