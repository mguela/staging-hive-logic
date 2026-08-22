// Serves the real public/ tree with stubbed backing APIs, so the shipped
// schedule board can be driven in a browser with no backend and no network.
//
// It serves the actual files that deploy — not a copy, not a rebuild — so a
// test failure here is a failure of the thing users get.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures, MONITOR_ROSTER, PULSE } from './fixtures.mjs';
import { EXPECTED_AGENT_VERSION } from '../../api/_lib/agent-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function apiResponse(url, fx) {
  const q = new URL(url, 'http://x').searchParams;
  switch (q.get('resource')) {
    case 'employee_roster': return { ok: true, roster: fx.roster };
    case 'schedule_range': return { ok: true, visits: fx.visits, count: fx.visits.length };
    case 'tech_live_status': return { ok: true, techs: [] };
    case 'crew_schedule': return { ok: true, vehicles: fx.vehicles, vehicleAssignments: fx.vehicleAssignments };
    // The Command Center asks for the signed-in user's saved layouts on boot.
    // An empty list is the "new user" case: it falls back to the default
    // template, which is the layout these tests measure.
    case 'cc_layouts': return { ok: true, layouts: [] };
    // The Monitor roster, so the agent-version badge can be read off a real
    // render rather than off the source. expectedAgentVersion is what the
    // "update pending" badge is measured against, and the page must take it
    // from here rather than from a literal of its own.
    case 'monitor_review': return {
      ok: true, screenshotIntervalMinutes: 5, blurScreenshots: false,
      expectedAgentVersion: EXPECTED_AGENT_VERSION, roster: MONITOR_ROSTER,
    };
    case 'dailybrief': return PULSE.dailybrief;
    case 'quotes': return PULSE.quotes;
    case 'watching_unscheduled': return PULSE.watchingUnscheduled;
    default: return { ok: true };
  }
}

/**
 * Start the harness server. Port 0 lets the OS pick, so parallel runs and
 * leftover processes from a killed run cannot collide.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startServer({ port = 0, fixtures = buildFixtures() } = {}) {
  const server = http.createServer((req, res) => {
    const [pathname] = req.url.split('?');
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (pathname.startsWith('/api/track1')) return json(apiResponse(req.url, fixtures));
    // The Pulse gauges read these three directly rather than through track1.
    if (pathname.startsWith('/api/qbo')) {
      const kind = new URL(req.url, 'http://x').searchParams.get('kind');
      return json(kind === 'bills_due_range' ? PULSE.bills : PULSE.qboSummary);
    }
    if (pathname.startsWith('/api/snapshot')) return json(PULSE.snapshot);
    if (pathname.startsWith('/api/jobs')) return json(PULSE.jobs);
    if (pathname.startsWith('/api/schedule/hl')) {
      return json({
        ok: true,
        appointments: fixtures.subAppointments || [],
        subs: fixtures.subs || [],
        clock: [], overrides: [], outbox: [], messaging: { enabled: false },
      });
    }
    if (pathname.startsWith('/api/')) return json({ ok: true });

    const file = path.join(PUBLIC_ROOT, pathname === '/' ? 'index.html' : pathname);
    // path.join collapses ../ — re-check containment before reading anything
    if (!file.startsWith(PUBLIC_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address();
      resolve({
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
