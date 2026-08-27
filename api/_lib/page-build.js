// api/_lib/page-build.js
//
// Which version of the app a given browser is actually running.
//
// WHY THIS EXISTS. On 2026-08-16 an idle-timeout fix was merged, deployed, and
// tested against production for an hour -- and the test was worthless, because
// Chris's browser was still running the page from before the merge. Nothing
// available at the time could tell us that. The server was new (its new
// PostgREST query was visibly running), and I read that as proof the page was
// new too. It is not: an OLD page calling monitor_my_status triggers the NEW
// server's queries identically. The two halves deploy together and age apart,
// and a long-lived tab can run last week's JavaScript against today's API
// indefinitely.
//
// That is not a one-off. Every client-side fix in this repo has the same hole:
// "it's merged and deployed" says nothing about what is executing in the tab
// where the bug was reported. So the page now states which build it is, the
// poll reports it, and staleness becomes a query instead of an inference.
//
// HOW THE BUILD ID IS DERIVED. public/index.html is a single static file with
// no build step, so there is no bundler to stamp a hash. Instead the id IS a
// hash of the file's own content, written into it as a literal, with a test
// (test/page-build-marker.test.mjs) that recomputes it and fails if it drifts.
// Editing the page without updating the marker breaks CI -- which is the point:
// a marker that can silently go stale would be worse than none at all, because
// it would report "current" while lying.
//
// The marker line is excluded from its own hash (a value cannot contain its own
// digest), by blanking the value before hashing. Everything else in the file
// counts, so any real edit moves the id.
//
// THE PAGE IS NOT ONLY index.html. It also ships ~36 more same-origin files --
// app-bookkeeping.js, reina-pilot-host.js, hiveconnect/app.js, bookkeeping.css
// and the rest -- and a tab can be holding a stale copy of any of them for
// exactly the same reason it can hold a stale index.html. Hashing only
// index.html would report those tabs "current" while lying, which is the
// specific failure above. So the id folds in a digest of everything the page
// loads, found three ways, all DERIVED FROM THE SOURCE rather than from a list
// someone has to remember to update:
//
//   1. DECLARED -- every same-origin <script src> and stylesheet <link> in
//      index.html. Add a module and it is covered the moment its tag exists.
//
//   2. RUNTIME -- every absolute same-origin .js/.css/.html path that appears
//      as a string literal in the page or in a covered script, followed
//      transitively. This is how HiveConnect gets covered: hiveconnect-mount.js
//      fetches /hiveconnect/index.html and loadScript()s ten /hiveconnect/*.js
//      files (app.js alone is 309KB) into this same document. It is also how
//      reina-pilot-host.js's three voice modules and app-reina-council.js's
//      injected view are covered. A hardcoded list would have missed all of
//      them; worse, hiveconnect-mount.js carries two long comments about a
//      hand-maintained list silently drifting and breaking features twice.
//
//   3. IFRAMES -- the same-origin sub-apps the page EMBEDS, whether declared
//      (<iframe src="/vi-app/">) or assigned at runtime (openMarketingCC() does
//      iframe.setAttribute('src', '/marketing-command-center/?embedded=1')).
//      Those are whole separate documents living inside this one, so their own
//      tags ARE followed, resolved against their own directory. Marketing is
//      122KB of page nothing in index.html declares.
//
// Cross-origin CDN URLs are excluded from all three: we cannot hash what we do
// not serve, and those URLs are already version-pinned.
//
// Note what this does and does not do. It makes staleness DETECTABLE; it does
// not bust any cache. A stale tab is told it is stale and offered a hard
// reload -- same as before, just now correct about more of the page.
//
// WHERE THIS STILL STOPS, so nobody reads more into it than it says:
//
//   - Runtime discovery reads absolute literals ('/hiveconnect/app.js'). A
//     path built by concatenation would be missed. There are none today and
//     a test says so, but the technique cannot see one if it appears.
//   - Fetched HTML is hashed for its markup (it gets injected), but its own
//     tags are NOT followed. Whether those execute is up to the injector --
//     hiveconnect-mount.js strips every <script> out of the markup and loads
//     the same files itself, so following them would double-count and would
//     also pull in hiveconnect/styles.css, which the mounted path never loads.
//     A test cross-checks the mount's list against the standalone page's, which
//     is the drift those two comments are about. An IFRAMED page is the opposite
//     case and is followed -- the browser parses it and runs its tags itself.
//   - Pages a person NAVIGATES to are deliberately not covered:
//     window.open('/agents/') and <a href="/field/"> load a fresh document, so
//     they cannot be stale the way this file means. An earlier draft of the
//     iframe rule swept them in, which would have made an edit to the
//     standalone field app mark every Command Center tab out of date.

import crypto from 'node:crypto';
import fs from 'node:fs';

// The build the server expects clients to be running. Mirrors the
// HL_PAGE_BUILD literal in public/index.html; the test above keeps them equal
// to each other AND to the actual file hash.
export const PAGE_BUILD = 'e1fc9883dd537124';

// Matches the marker in either file, capturing the value so it can be blanked.
export const PAGE_BUILD_MARKER = /var HL_PAGE_BUILD = '([0-9a-f]{16})';/;

// Git checks this repository out with LF on Linux while Windows worktrees may
// expose CRLF. Line endings are transport metadata, not a different browser
// build, so canonicalize them before hashing. Without this, a build stamped on
// Windows fails the Linux completion gate even when every shipped byte of
// executable content is otherwise identical.
function canonicalText(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

// Matches any <script>, <link> or <iframe> tag so its src/href can be read out.
// The page is 2.2MB and most of it is JavaScript, so this also matches tag text
// sitting inside JS strings (report templates, printable views). That is
// harmless: every such occurrence today is a cross-origin CDN URL, which
// sameOriginRef rejects.
const ASSET_TAG = /<(script|link|iframe)\b([^>]*)>/gi;

function tagAttr(name, attrs) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// A reference we serve ourselves, reduced to a path under public/ -- or null for
// anything we cannot hash.
//
// Query strings are stripped: `voice-input.js?v=2` and `voice-input.js` are one
// file on disk, and the manual ?v= cache-busters in the page are a separate
// mechanism from this one.
//
// A directory ('/vi-app/', '/marketing-command-center/?embedded=1') means that
// directory's index.html, which is what the server serves for it.
//
// `baseDir` is the directory of the document the reference was found in, so a
// relative ref resolves the way the browser resolves it. schedule-board's
// './data.js' is data.js IN schedule-board, not at the site root.
function sameOriginRef(ref, baseDir = '') {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;   // https:, data:, blob:, about:
  if (raw.startsWith('//')) return null;                // protocol-relative
  let path = raw.split(/[?#]/)[0];
  if (!path) return null;
  if (!path.startsWith('/')) {
    path = `${baseDir ? `${baseDir}/` : ''}${path.replace(/^\.\//, '')}`;
  }
  path = path.replace(/^\/+/, '');
  if (!path) return null;
  if (path.includes('..')) return null;                 // never climb out of public/
  if (path.endsWith('/')) path += 'index.html';         // a directory is its index
  return path;
}

// The directory part of a path under public/, for resolving that document's own
// relative references.
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function scanTags(html, baseDir, want) {
  const refs = new Set();
  for (const m of String(html).matchAll(ASSET_TAG)) {
    const [, rawTag, attrs] = m;
    const path = sameOriginRef(want(rawTag.toLowerCase(), attrs), baseDir);
    if (path) refs.add(path);
  }
  return [...refs].sort();
}

// Every same-origin script and stylesheet a document loads, sorted and deduped.
// Sorted so the id does not depend on scan order -- reordering the tags is a
// change to the document, which its own hash already catches.
export function pageAssetRefs(html, baseDir = '') {
  return scanTags(html, baseDir, (tag, attrs) => {
    if (tag === 'script') return tagAttr('src', attrs);
    if (tag === 'link' && /(^|\s)stylesheet(\s|$)/i.test(tagAttr('rel', attrs) || '')) {
      return tagAttr('href', attrs);
    }
    return null;
  });
}

// Same-origin pages this document embeds. Kept separate from the assets above
// because an iframe is a whole DOCUMENT, not a file pulled into this one, and
// that difference decides whether its own tags get followed.
export function pageFrameRefs(html, baseDir = '') {
  return scanTags(html, baseDir, (tag, attrs) => {
    if (tag !== 'iframe') return null;
    // Auth-gated sub-apps intentionally start at about:blank and publish their
    // real same-origin document in data-src until a verified session exists.
    // That deferred document is still the page the iframe will execute, so it
    // must participate in the build fingerprint just like an eager src.
    return tagAttr('data-src', attrs) || tagAttr('src', attrs);
  });
}

// An absolute same-origin asset path written as a string literal in JavaScript
// -- loadScript('/hiveconnect/app.js'), fetch('/views/reina-council.html'),
// link.href = '/hiveconnect/styles-scoped.css'. Restricted to .js/.css/.html so
// that API routes and ordinary strings are not mistaken for shipped files, and
// to absolute paths because a relative one resolves against the DOCUMENT, not
// the script, and would be guesswork.
const RUNTIME_ASSET_REF = /['"`](\/[A-Za-z0-9_@./-]+\.(?:js|css|html))['"`]/g;

// Assets a script pulls in at runtime, as opposed to ones the page declares.
export function runtimeAssetRefs(source) {
  const refs = new Set();
  for (const m of String(source).matchAll(RUNTIME_ASSET_REF)) {
    const path = sameOriginRef(m[1]);
    if (path) refs.add(path);
  }
  return [...refs].sort();
}

// A frame source assigned at runtime -- `f.src = '/subportal-admin/'` or
// `iframe.setAttribute('src', '/marketing-command-center/?embedded=1')`. This is
// how the embedded sub-apps are opened; nothing declares those pages anywhere.
//
// Deliberately NOT "any same-origin directory in a string literal". That also
// swept up window.open('/agents/','_blank') and <a href="/field/"> -- pages a
// person NAVIGATES to. A navigation loads a fresh document, so those pages
// cannot be stale in the sense this file means, and hashing them would mean
// editing the standalone field app marks every Command Center tab out of date.
const RUNTIME_FRAME_REF =
  /(?:\.src\s*=\s*|setAttribute\(\s*['"]src['"]\s*,\s*)['"`](\/[A-Za-z0-9_@./-]*(?:\/|\.html))(?:\?[^'"`]*)?['"`]/g;

// Same-origin pages a script embeds at runtime.
//
// Restricted to results that are a directory (served as its index.html) or an
// .html file, so the same `.src =` pattern used for <script> and <img> elements
// does not land here -- script sources are already covered as assets.
export function runtimePageRefs(source) {
  const refs = new Set();
  for (const m of String(source).matchAll(RUNTIME_FRAME_REF)) {
    const path = sameOriginRef(m[1]);
    if (path) refs.add(path);
  }
  return [...refs].sort();
}

// Read everything the page loads off disk, following runtime references
// transitively. Used by the stamping script and its test, never at request time
// -- api/track1.js and api/health-cron.js import only the PAGE_BUILD constant,
// so no serverless invocation touches the filesystem.
//
// A DECLARED asset that cannot be read throws. Skipping it would leave a shipped
// file silently uncovered, which is the whole hole this closes; and a
// <script src> pointing at a file that is not there is a broken page anyway.
//
// A RUNTIME reference that does not resolve is skipped instead, because a string
// literal is a guess, not a declaration -- it may be a path for another service,
// an example in a comment, or a route. Skipping is safe here because the surface
// that matters has its own guard: the test that cross-checks hiveconnect-mount.js
// against hiveconnect/index.html would catch a typo'd or dropped module.
export function loadPageAssets(html, root = 'public', self = 'index.html') {
  const assets = [];
  // The root document is never one of its own assets. It is hashed separately,
  // with its build marker blanked; as an asset the marker would NOT be blanked,
  // so every stamp would change the input to the next stamp and the id would
  // never settle. index.html happens to mention "/index.html" in a comment,
  // which is exactly how this was found -- so exclude it by construction rather
  // than trusting that no such string ever appears.
  const seen = new Set([self]);
  // index.html declares its tags AND carries ~25k lines of inline JavaScript, so
  // it is scanned both ways. Missing the second half would leave the embedded
  // sub-apps uncovered: openMarketingCC() sets the iframe src from a string
  // literal inside the page itself, not from any external module.
  const queue = [
    ...pageAssetRefs(html).map((path) => ({ path, via: 'declared' })),
    ...pageFrameRefs(html).map((path) => ({ path, via: 'iframe' })),
    // Frame refs before asset refs: '/schedule-board/index.html' matches both
    // patterns, and whichever is queued first wins the classification. It has to
    // be seen as a DOCUMENT, or its own <script src> tags never get followed.
    ...runtimePageRefs(html).map((path) => ({ path, via: 'iframe' })),
    ...runtimeAssetRefs(html).map((path) => ({ path, via: 'runtime' })),
  ];

  while (queue.length) {
    const { path, via } = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);

    const file = `${root}/${path}`;
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (via === 'declared') {
        throw new Error(
          `${file} is referenced by the page but could not be read (${e.code || e.message}). ` +
          'Every same-origin script/stylesheet must exist so it can be hashed into the build id.'
        );
      }
      continue;
    }

    assets.push({ path, source, via });
    const push = (p, v) => { if (!seen.has(p)) queue.push({ path: p, via: v }); };

    if (path.endsWith('.js')) {
      for (const ref of runtimePageRefs(source)) push(ref, 'iframe');   // documents first, see above
      for (const ref of runtimeAssetRefs(source)) push(ref, 'runtime');
    }

    // An IFRAMED page is a real document: the browser parses it and runs its
    // <script src> tags itself, so they are followed, resolved against that
    // page's own directory. Injected markup (via 'runtime') is NOT followed --
    // whether its tags execute is up to whatever injected it, and
    // hiveconnect-mount.js strips them all out. That is the whole distinction
    // between the two, and it is why they are tracked separately.
    if (via === 'iframe' && path.endsWith('.html')) {
      const base = dirOf(path);
      for (const ref of pageAssetRefs(source, base)) push(ref, 'runtime');
      for (const ref of pageFrameRefs(source, base)) push(ref, 'iframe');
    }
  }

  return assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The id for a given page source plus the assets it ships. Deterministic, and
// independent of whatever the file currently claims its id is.
//
// `assets` is required, not defaulted. A caller that forgot it would otherwise
// compute a well-formed id covering only index.html -- a wrong answer that looks
// exactly like a right one, which is the failure mode this module exists to
// prevent. Pass [] if you genuinely mean "html alone".
export function computePageBuild(html, assets) {
  if (!Array.isArray(assets)) {
    throw new TypeError('computePageBuild(html, assets): pass the page assets (loadPageAssets(html)), or [] for the page alone');
  }
  const normalized = canonicalText(html).replace(PAGE_BUILD_MARKER, "var HL_PAGE_BUILD = '';");
  const digest = crypto.createHash('sha256').update(normalized);
  for (const { path, source } of [...assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // The path is hashed alongside the content so that renaming a module, or two
    // modules trading contents, still moves the id.
    digest.update('\0').update(String(path)).update('\0');
    digest.update(crypto.createHash('sha256').update(canonicalText(source)).digest());
  }
  return digest.digest('hex').slice(0, 16);
}

// A client's reported build is only meaningful if it looks like one of ours --
// anything else is a malformed or forged value and must not be recorded as if
// it were a real deployment.
export function isWellFormedBuild(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

// Is this client running something other than the current page?
//
// A client that reports nothing is NOT called stale: it predates this whole
// mechanism, so we genuinely do not know, and saying "stale" would be the same
// unfounded claim this file exists to prevent. It is reported as 'unknown'
// instead, which is the honest answer and still visible in the health check.
export function pageBuildState(reported) {
  if (!isWellFormedBuild(reported)) return 'unknown';
  return reported === PAGE_BUILD ? 'current' : 'stale';
}

// How often a client's reported build is written back to its profile row. The
// poll runs every 30s per signed-in tab; recording every one of those would be
// a write per user per 30 seconds forever, for a value that changes about
// twice a day. A change is always recorded immediately -- the interval only
// throttles re-recording the SAME answer, so "who is on old code right now"
// stays answerable to within this window.
export const PAGE_BUILD_RECORD_INTERVAL_MS = 5 * 60 * 1000;

export function shouldRecordPageBuild(storedBuild, storedSeenAt, reportedBuild, nowMs = Date.now()) {
  if (!isWellFormedBuild(reportedBuild)) return false;
  if (storedBuild !== reportedBuild) return true;
  if (!storedSeenAt) return true;
  const seen = new Date(storedSeenAt).getTime();
  if (!Number.isFinite(seen)) return true;
  return (nowMs - seen) >= PAGE_BUILD_RECORD_INTERVAL_MS;
}
