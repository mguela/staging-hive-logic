import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

// Same extraction helpers the other public/index.html frontend tests use:
// pull the real function text out of the shipped file and run it in a vm,
// so these assertions can never drift from what the browser actually gets.
function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  if (declSnippet[declSnippet.length - 1] !== '{') throw new Error('declSnippet must end with the opening brace: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

const FN_SRC = [
  'function etYMD(iso){',
  'function calDayLabel(ymd){',
  'function schedIngestVisits(visits, startYmd, endYmd){',
  'function schedMapPeriod(){',
  'function schedMapVisitsForPeriod(){',
  'function schedStateSnapshot(){',
  'function schedMedianPoint(pts){',
  'function schedMapFit(userInitiated){',
].map((decl) => extractFunction(source, decl)).join('\n');

// These scope guards check what the block DOES, so comments (which name the
// Command Center symbols precisely to say they are not touched) are stripped.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The Schedule map block, comments removed. The slice has to start at the
// banner comment's own opening /* -- starting mid-comment would leave its
// (deliberately explicit) mentions of the CC symbols in the stripped text.
function scheduleMapBlock() {
  const marker = source.indexOf('SCHEDULE TAB -- view-state persistence');
  const start = source.lastIndexOf('/*', marker);
  // The legacy inline board is no longer mounted at DOMContentLoaded; the real
  // Schedule view is /schedule-board/. Keep this source audit bounded by the
  // next feature banner instead of relying on the intentionally removed boot.
  const end = source.indexOf('/* ===== Pipeline drag-and-drop ===== */', marker);
  assert.ok(marker > -1 && start > -1 && end > start, 'Schedule map block not found');
  const block = stripComments(source.slice(start, end));
  assert.ok(!block.includes('SCHEDULE TAB --'), 'comment stripping did not take');
  return block;
}

function makeSandbox(overrides = {}) {
  const ctx = {
    console,
    Intl,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    CAL: { view: 'day', person: 'all', personal: true, date: '2026-08-14' },
    REAL_WEEK_START_YMD: '2026-08-09',
    REAL_WEEK_END_YMD: '2026-08-15',
    REAL_MONTH_START_YMD: '2026-08-01',
    REAL_MONTH_END_YMD: '2026-08-31',
    REAL_MONTH_LABEL: 'August 2026',
    SCHED_STATE_BOOT: null,
    SCHEDMAP: { mode: 'jobs', map: null, lib: null, visits: {}, jobPts: [], office: null, jobMarkers: [], vehMarkers: {} },
    schedMapFoot() {},
    ...overrides,
  };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  return ctx;
}

// Every visit here is shaped like a real resource=schedule_range row
// (api/track1.js handleScheduleRange): startAt/lat/lng/city/assignedTechs.
// Times are UTC; the schedule board works in America/New_York, so 14:00Z is the
// same ET day and 03:00Z is the PREVIOUS ET day -- that boundary is the whole
// point of etYMD and is what the period filter has to respect.
const visit = (id, startAtUtc, lat = 41.03, lng = -73.62) => ({
  visitId: id,
  jobberId: 'job-' + id,
  title: 'Electric rough-in',
  clientName: 'Client ' + id,
  startAt: startAtUtc,
  endAt: startAtUtc,
  status: 'scheduled',
  lat,
  lng,
  city: 'Greenwich',
  assignedTechs: [{ name: 'Marco', jobberId: 'u1' }],
});

test('schedIngestVisits stamps the ET day and keys rows uniquely', () => {
  const ctx = makeSandbox();
  ctx.schedIngestVisits([visit('a', '2026-08-14T14:00:00Z'), visit('b', '2026-08-14T18:30:00Z')], '2026-08-14', '2026-08-14');
  const keys = Object.keys(ctx.SCHEDMAP.visits);
  assert.equal(keys.length, 2);
  keys.forEach((k) => assert.equal(ctx.SCHEDMAP.visits[k].__ymd, '2026-08-14'));
});

test('schedIngestVisits replaces the fetched window but keeps rows outside it', () => {
  const ctx = makeSandbox();
  // week/month load first
  ctx.schedIngestVisits(
    [visit('mon', '2026-08-10T14:00:00Z'), visit('fri', '2026-08-14T14:00:00Z')],
    '2026-08-09',
    '2026-08-15'
  );
  assert.equal(Object.keys(ctx.SCHEDMAP.visits).length, 2);

  // then a single-day fetch for Friday returns only ONE visit -- the other
  // Friday visit was deleted in Jobber and must disappear, while Monday
  // (outside the fetched window) must survive.
  ctx.schedIngestVisits([visit('fri2', '2026-08-14T15:00:00Z')], '2026-08-14', '2026-08-14');
  const days = Object.values(ctx.SCHEDMAP.visits).map((v) => v.visitId).sort();
  assert.deepEqual(days, ['fri2', 'mon']);
});

test('schedIngestVisits ignores rows the API returned outside the asked-for window', () => {
  const ctx = makeSandbox();
  ctx.schedIngestVisits([visit('stray', '2026-09-02T14:00:00Z')], '2026-08-14', '2026-08-14');
  assert.equal(Object.keys(ctx.SCHEDMAP.visits).length, 0);
});

test('Day view draws only CAL.date -- not today, whatever day is being viewed', () => {
  const ctx = makeSandbox();
  ctx.schedIngestVisits(
    [visit('mon', '2026-08-10T14:00:00Z'), visit('tue', '2026-08-11T14:00:00Z'), visit('fri', '2026-08-14T14:00:00Z')],
    '2026-08-09',
    '2026-08-15'
  );
  ctx.CAL.view = 'day';
  ctx.CAL.date = '2026-08-11';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId), ['tue']);

  // navigating the day nav changes what the map draws, with no refetch
  ctx.CAL.date = '2026-08-10';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId), ['mon']);
});

test('Week view draws the whole visible week and excludes days outside it', () => {
  const ctx = makeSandbox();
  ctx.schedIngestVisits(
    [visit('inWeek', '2026-08-10T14:00:00Z'), visit('alsoIn', '2026-08-15T14:00:00Z')],
    '2026-08-09',
    '2026-08-15'
  );
  ctx.schedIngestVisits([visit('nextWeek', '2026-08-17T14:00:00Z')], '2026-08-16', '2026-08-22');
  ctx.CAL.view = 'week';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId).sort(), ['alsoIn', 'inWeek']);
});

test('Month view draws the month; the office lens falls back to the week range', () => {
  const ctx = makeSandbox();
  ctx.schedIngestVisits([visit('aug', '2026-08-20T14:00:00Z')], '2026-08-01', '2026-08-31');
  ctx.CAL.view = 'month';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId), ['aug']);
  ctx.CAL.view = 'office';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId), []); // 8/20 is outside the 8/9-8/15 week
});

test('a late-evening ET visit is filed under the ET day, not the UTC day', () => {
  const ctx = makeSandbox();
  // 2026-08-15T02:30:00Z is 10:30pm ET on 2026-08-14
  ctx.schedIngestVisits([visit('lateNight', '2026-08-15T02:30:00Z')], '2026-08-09', '2026-08-15');
  ctx.CAL.view = 'day';
  ctx.CAL.date = '2026-08-14';
  assert.deepEqual(ctx.schedMapVisitsForPeriod().map((v) => v.visitId), ['lateNight']);
});

test('schedStateSnapshot stores durable view state and no transient state', () => {
  const ctx = makeSandbox({
    SCHEDMAP: {
      mode: 'all',
      lens: 'money',
      visits: {},
      map: {
        getCenter: () => ({ lng: -73.6412345678, lat: 41.1443219876 }),
        getZoom: () => 12.3456,
        getBearing: () => 42.55,
        getPitch: () => 37.44,
      },
    },
  });
  ctx.CAL.view = 'week';
  ctx.CAL.person = 'danny';
  ctx.CAL.personal = false;
  ctx.window = { CALF: true };
  const st = ctx.schedStateSnapshot();

  assert.equal(st.calView, 'week');
  assert.equal(st.calPerson, 'danny');
  assert.equal(st.calPersonal, false);
  assert.equal(st.lens, 'money');
  assert.equal(st.mapMode, 'all');
  assert.deepEqual(st.mapCenter, [-73.641235, 41.144322]);
  assert.equal(st.mapZoom, 12.35);
  assert.equal(st.mapBearing, 42.5); // (42.55).toFixed(1) === '42.5' -- binary float, not a rounding bug
  assert.equal(st.mapPitch, 37.4);

  // The day being viewed and anything modal-shaped are deliberately absent --
  // coming back tomorrow must not park the board on a stale date.
  assert.ok(!('calDate' in st));
  assert.ok(!('openJob' in st));
  assert.ok(!('modal' in st));
  assert.ok(JSON.stringify(st).length < 400, 'state blob stays small');
});

test('schedStateSnapshot keeps the booted camera when the map has not been built yet', () => {
  const ctx = makeSandbox({
    SCHED_STATE_BOOT: { mapCenter: [-73.6, 41.1], mapZoom: 13, mapBearing: 90, mapPitch: 45, lens: 'people' },
    SCHEDMAP: { mode: 'jobs', map: null, visits: {} },
  });
  ctx.window = {};
  const st = ctx.schedStateSnapshot();
  assert.deepEqual(st.mapCenter, [-73.6, 41.1]);
  assert.equal(st.mapZoom, 13);
  assert.equal(st.mapBearing, 90);
  assert.equal(st.mapPitch, 45);
});

// The bug Command Center actually hit: one bad-geocoded job hundreds of miles
// away dragged fitBounds' zoom out until the real service area was unreadable.
test('schedMapFit excludes far-outside-the-service-area pins from the bounds', () => {
  const extended = [];
  const fitCalls = [];
  const ctx = makeSandbox({
    SCHEDMAP: {
      mode: 'jobs',
      office: { lat: 41.1443, lng: -73.6421 },
      jobPts: [
        [-73.62, 41.03],
        [-73.58, 41.05],
        [-118.24, 34.05], // bad geocode: Los Angeles
      ],
      map: {
        fitBounds: (b, opts) => fitCalls.push([b, opts]),
        easeTo: (o) => fitCalls.push(['easeTo', o]),
      },
      lib: {
        LngLatBounds: class {
          constructor(a) { this.pts = [a]; }
          extend(pt) { this.pts.push(pt); extended.push(pt); }
        },
      },
    },
  });
  ctx.schedMapFit(false);

  assert.equal(fitCalls.length, 1);
  const bounds = fitCalls[0][0];
  const lngs = bounds.pts.map((p) => p[0]);
  assert.ok(!lngs.includes(-118.24), 'the Los Angeles outlier must not be in the bounds');
  assert.ok(lngs.includes(-73.62) && lngs.includes(-73.58), 'real service-area pins stay in the bounds');
  assert.ok(lngs.includes(-73.6421), 'the office anchors the bounds');
  assert.equal(fitCalls[0][1].maxZoom, 14);
  assert.match(ctx.SCHEDMAP.outlierNote, /1 pin outside the service area/);
});

test('schedMapFit with no pins centers on the office instead of fitting nothing', () => {
  const calls = [];
  const ctx = makeSandbox({
    SCHEDMAP: {
      mode: 'jobs',
      office: { lat: 41.1443, lng: -73.6421 },
      jobPts: [],
      map: { fitBounds: () => calls.push('fit'), easeTo: (o) => calls.push(o) },
      lib: { LngLatBounds: class { constructor(a){ this.pts=[a]; } extend(){} } },
    },
  });
  ctx.schedMapFit(false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].center, [-73.6421, 41.1443]);
  assert.equal(calls[0].zoom, 11);
});

test('the Schedule map block never touches Command Center map globals', () => {
  const block = scheduleMapBlock();
  ['_ccLeafletMap', '_ccJobsLayer', '_ccTechsLayer', '_ccMapViewMode', 'ccBundleFetch'].forEach((sym) => {
    assert.ok(!block.includes(sym), 'Schedule map block must not reference ' + sym);
  });
  // and it must not fall back onto Leaflet
  assert.ok(!/\bL\.(map|marker|layerGroup|tileLayer)\b/.test(block), 'Schedule map must be MapLibre-only');
});

test('the Schedule map reuses schedule_range rather than adding a second job fetch', () => {
  const block = scheduleMapBlock();
  assert.ok(!block.includes('resource=schedule_range'), 'the map must filter already-loaded rows, not refetch them');
  // The only fetch it is allowed to make is the 60s live-vehicle poll. The
  // office lookup ('maplocations') went with schedMapOffice() when the old
  // inline board's unreachable functions were deleted on 2026-08-17.
  const fetches = block.match(/fetch\('\/api\/track1\?resource=([a-z_]+)'/g) || [];
  assert.deepEqual(
    fetches.map((f) => f.split('resource=')[1].replace("'", '')).sort(),
    ['crew_schedule']
  );
});

// --- Regressions from the first preview round (2026-08-15) ---
// Chris reported: the map came up with no controls, and the view/layout was
// not being kept. Both traced to the same class of fragility -- essential
// setup hanging off things that can silently not happen.

test('the library loader tries unpkg first and pairs each script with its own stylesheet', () => {
  const block = scheduleMapBlock();
  const unpkgAt = block.indexOf('unpkg.com/maplibre-gl');
  const cdnjsAt = block.indexOf('cdnjs.cloudflare.com/ajax/libs/maplibre-gl');
  assert.ok(unpkgAt > -1 && cdnjsAt > -1, 'both CDNs should be listed');
  assert.ok(unpkgAt < cdnjsAt, 'unpkg (real npm dist paths) must be tried first');
  // .min.css was the wrong filename -- npm ships maplibre-gl.css
  assert.ok(!block.includes('maplibre-gl.min.css'), 'maplibre-gl.min.css is not a real dist filename');
});

test('an empty period says so on the map instead of just looking broken', () => {
  const fn = extractFunction(source, 'function schedMapRenderJobs(){');
  assert.ok(fn.includes("getElementById('sched-map-empty')"));
  assert.ok(fn.includes('Nothing scheduled'), 'zero visits in the period must be stated plainly');
  assert.ok(fn.includes('none have a geocoded address yet'), 'visits-but-no-coords is a distinct message');
});
