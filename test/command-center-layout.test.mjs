import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// The Pulse widget's CSS and markup stayed in the page; its JavaScript moved to
// its own module on 2026-08-17 (docs/COMMAND-CENTER-EXTRACTION-SCOPE.md). Both
// halves are still asserted, each against the file it actually lives in.
const pulseJs = readFileSync(new URL('../public/app-command-center-pulse.js', import.meta.url), 'utf8');

test('Command Center content cannot stretch the dashboard row', () => {
  assert.match(
    html,
    /#snapshot\s*>\s*\.grid\{[^}]*align-items:start[^}]*\}/,
    'the Command Center grid must size from stable card shells, not the tallest live feed',
  );
  assert.match(
    html,
    /#snapshot \.fin\.pg-grid\{[^}]*flex:0 0 auto[^}]*align-content:start[^}]*\}/,
    'the Pulse gauge grid must not absorb height from another column',
  );
  assert.doesNotMatch(
    html,
    /#snapshot \.rcol \.card\.cchar\.notch\{flex:0 0 auto\}/,
    'right-column cards must not size themselves to unbounded content',
  );
  assert.match(
    html,
    /#snapshot \.rcol > \.card\.cchar\.notch\{[^}]*height:clamp\(240px,28vh,340px\)[^}]*overflow:visible[^}]*\}/,
    'right-column card shells need a stable height while preserving their notched titles',
  );
});

test('three-column desktop Command Center columns share one bottom edge', () => {
  assert.match(
    html,
    /@media \(min-width:1000px\)\{\s*#snapshot \.col-mid,\s*#snapshot #daily-brief-card\{align-self:stretch\}\s*#snapshot #daily-brief-card\{height:auto;contain:size\}\s*\}/,
    "the Map/Pulse and Today's Decisions columns must share the primary row height",
  );
  assert.match(
    html,
    /@media \(min-width:1400px\)\{\s*#snapshot > \.grid\{align-items:stretch\}\s*#snapshot \.rcol\{align-self:stretch;contain:size\}\s*#snapshot \.rcol > \.card\.cchar\.notch\{flex:1 1 0;height:auto\}\s*\}/,
    'the right-hand column must share the three-column desktop row height and divide it evenly',
  );
});

test('every dynamic Command Center feed scrolls inside its fixed shell', () => {
  assert.match(
    html,
    /#snapshot \.cc-box-scroll\{[^}]*min-height:0[^}]*overflow-y:auto[^}]*overflow-x:hidden[^}]*scrollbar-gutter:stable[^}]*\}/,
  );

  const expectedScrollFrames = [
    ['brief-body', "Today's Decisions details"],
    ['watching-body', 'Watching items'],
    ['todo-body', 'Team To-Do items'],
    ['notif-feed', 'Notifications'],
    ['recentPhotosGrid', 'Recent Job Photos'],
  ];
  for (const [id, label] of expectedScrollFrames) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      html,
      new RegExp(`<div(?=[^>]*\\bid="${id}")(?=[^>]*\\bclass="[^"]*cc-box-scroll[^"]*")(?=[^>]*\\brole="region")(?=[^>]*\\baria-label="${escapedLabel}")[^>]*>`),
      `${id} should be a named internal scroll region`,
    );
  }
  assert.match(
    html,
    /class="sched-scroll cc-box-scroll"[^>]*role="region"[^>]*aria-label="Today's Schedule items"/,
    'the schedule keeps its header fixed and scrolls only its rows',
  );

  // 2026-08-10: the fixed 3-column .grid/.rcol layout was replaced by one
  // GridStack container (#cc-main-gridstack) so every panel can be dragged/
  // resized independently -- see the "cc-watching"/"cc-todo"/"cc-notif"
  // grid-stack-item markup in the col-mid/rcol area of public/index.html.
  // Each panel is now its own grid-stack-item rather than a shared .rcol, so
  // this checks title-before-scroll-frame ordering within each item instead.
  const gridStart = html.indexOf('id="cc-main-gridstack"');
  assert.ok(gridStart >= 0, 'the Command Center GridStack container should remain discoverable');
  for (const [gsId, cardId, bodyId] of [
    ['cc-watching', 'watching-panel', 'watching-body'],
    // Renamed from 'reina-todo-panel' on 2026-08-16: the card no longer reads
    // reina_todo at all -- it shows real HiveConnect tasks + live operational
    // detections. Layout/position/label are unchanged.
    ['cc-todo', 'team-todo-panel', 'todo-body'],
    ['cc-notif', 'cc-notifications-panel', 'notif-feed'],
  ]) {
    const itemAt = html.indexOf(`gs-id="${gsId}"`, gridStart);
    const cardAt = html.indexOf(`id="${cardId}"`, itemAt);
    const titleAt = html.indexOf('class="cchar-t"', cardAt);
    const bodyAt = html.indexOf(`id="${bodyId}"`, cardAt);
    assert.ok(itemAt >= 0 && cardAt > itemAt && titleAt > cardAt && bodyAt > titleAt, `${cardId} must keep its title outside its scroll frame`);
  }
});

test('Command Center breakpoints keep gauges compact without horizontal overflow', () => {
  assert.doesNotMatch(html, /#snapshot \.fin\{grid-template-columns:1fr\}/);
  assert.match(
    html,
    /@media \(min-width:1000px\) and \(max-width:1399px\)\{[\s\S]*?#snapshot > \.grid\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.15fr\)\}[\s\S]*?#snapshot \.rcol\{[\s\S]*?grid-column:1\/-1[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
  );
  assert.match(
    html,
    /@media \(max-width:999px\)\{[\s\S]*?#snapshot > \.grid\{grid-template-columns:minmax\(0,1fr\)\}[\s\S]*?#snapshot \.fin\.pg-grid\{grid-template-columns:repeat\(auto-fit,minmax\(min\(180px,100%\),1fr\)\)\}/,
  );
  assert.match(html, /\.main\{[^}]*width:100%[^}]*min-width:0[^}]*\}/);
  assert.match(html, /@media\(max-width:1150px\)\{\s*\.topbar\{flex-wrap:wrap\}/);
  assert.match(
    html,
    /@media\(min-width:1151px\) and \(max-width:1399px\)\{\s*body\.cc-open \.topbar\{flex-wrap:wrap\}\s*body\.cc-open \.topbar \.ask\{min-width:0;flex:1 1 220px\}/,
    'the wider header wrap must be limited to the Command Center',
  );
  assert.match(html, /document\.body\.classList\.toggle\('cc-open', v==='cc'\)/);
});

test('Pulse gauges are boxless and resize with the widget instead of a fixed height', () => {
  // 2026-08-13 (Chris's ask, via jomell): the 6 gauges used to sit in individually
  // bordered/shadowed cards at a fixed 278px height, which read as separate boxes
  // and overflowed/scrolled instead of resizing with the widget. Replaced with a
  // borderless tile + a #pg-fin grid that fills 100% of the widget's real height.
  assert.doesNotMatch(
    html,
    /\.pg-tile\{[^}]*border:1\.5px solid var\(--line\)/,
    'gauge tiles must not have their own card border',
  );
  assert.doesNotMatch(
    html,
    /\.pg-tile\{[^}]*height:278px/,
    'gauge tiles must not be pinned to a fixed height',
  );
  assert.match(
    html,
    /#pg-fin\{[^}]*height:100%[^}]*min-height:0[^}]*\}/,
    '#pg-fin must fill the Pulse widget\'s actual (resizable) height',
  );
  assert.match(
    html,
    /#cc-main-gridstack \.grid-stack-item\[gs-id="cc-pulse"\] \.grid-stack-item-content\{container-type:inline-size;container-name:pgpulse\}/,
    'the Pulse widget must establish a size container so gauges can reflow off its own resized width',
  );
  assert.match(
    html,
    /@container pgpulse \(max-width:380px\)\{ #pg-fin\{grid-template-columns:1fr\} \}/,
    'narrow Pulse widget must drop to a single gauge column',
  );
  assert.match(
    html,
    /@container pgpulse \(min-width:640px\)\{ #pg-fin\{grid-template-columns:repeat\(3,1fr\)\} \}/,
    'wide Pulse widget must expand to three gauge columns',
  );
  // The dial has no in-flow content (svg + .pg-center are both position:absolute),
  // so CSS aspect-ratio alone can't size it -- pgSizeDials() sets an explicit
  // pixel size instead, recomputed via a ResizeObserver on #pg-fin.
  assert.match(pulseJs, /function pgSizeDials\(\)\{/);
  assert.match(pulseJs, /new ResizeObserver\(function\(\)\{ pgSizeDials\(\); \}\)/);
  // ...and the page must still load the module, or the two assertions above are
  // checking a file nothing runs.
  assert.match(html, /<script src="\/app-command-center-pulse\.js"><\/script>/);
});

test('secondary Command Center boxes have bounded overflow behavior', () => {
  assert.match(
    html,
    /#snapshot #daily-brief-card\{[^}]*height:clamp\(640px,90vh,960px\)[^}]*min-height:0[^}]*\}/,
  );
  assert.match(
    html,
    /#snapshot #rlv-jobhealth-strip\{[^}]*height:68px[^}]*flex-wrap:nowrap !important[^}]*overflow-x:auto[^}]*overflow-y:hidden[^}]*\}/,
  );
  assert.match(html, /#snapshot #rlv-jobhealth-strip > \*\{flex:0 0 auto;white-space:nowrap\}/);
  assert.match(
    html,
    /id="rlv-jobhealth-strip"[^>]*tabindex="0"[^>]*role="button"[^>]*aria-label="Job Health alerts; open reports"[^>]*onkeydown=/,
  );
  assert.match(html, /#snapshot \.sched-scroll\.cc-box-scroll\{overflow:auto\}/);
  assert.match(
    html,
    /#snapshot \.sched,#snapshot \.photos\{[^}]*height:clamp\(240px,34vh,320px\)[^}]*display:flex[^}]*flex-direction:column[^}]*overflow:visible[^}]*\}/,
  );
});
