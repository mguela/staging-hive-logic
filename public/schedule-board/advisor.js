// public/schedule-board/advisor.js
// Explainable dispatch flags. Advisory only -- it never moves anything.
//
// The board already answers "is THIS job ready?" (readinessOf: weather,
// materials, confirmation). Nothing answered "does this crew's DAY make
// sense?", which is where the expensive mistakes live: two jobs forty minutes
// apart with fifteen minutes between them, a day that quietly runs into
// overtime, a job sitting on the wrong side of the county from the rest of the
// route.
//
// DESIGN LAW, from the schedule plan: advisory-first. Every flag carries
// concrete reasons -- real distances, real minutes, real times -- so a
// dispatcher can judge it without trusting a score. Nothing here mutates a
// visit, and the board works identically with the whole file removed.
//
// Deliberately NOT a score. "Route quality 72%" is unactionable and invites
// trust it has not earned. Each flag is a specific sentence about two specific
// jobs, or it does not appear.
(function (root) {
  'use strict';

  var MILES_PER_DEG = 69.0;

  /** Great-circle miles. Cheap and plenty accurate at county scale. */
  function milesBetween(a, b) {
    if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
    var dLat = (b.lat - a.lat) * MILES_PER_DEG;
    var midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * MILES_PER_DEG * Math.cos(midLat);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  /**
   * Minutes of driving, from miles. Rural/suburban average, stated plainly so
   * nobody mistakes it for a traffic-aware routing estimate -- it is not one,
   * and the flag text says "about".
   */
  function driveMinutes(miles) {
    if (miles == null) return null;
    return Math.round((miles / 32) * 60);
  }

  function fmtTime(dec) {
    var h = Math.floor(dec), m = Math.round((dec - h) * 60);
    var ampm = h >= 12 ? 'PM' : 'AM', hh = h % 12 === 0 ? 12 : h % 12;
    return hh + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ampm;
  }

  /**
   * Flags for one crew member's one day.
   *
   * `visits` are that person's visits for that date, each { id, s, e, lat, lng,
   * client, jobNo }. `opts` supplies the thresholds the company already
   * configures (travelBuffer, overtimeH) so this never invents its own policy.
   */
  function flagsForDay(visits, opts) {
    var o = opts || {};
    var buffer = o.travelBuffer == null ? 15 : o.travelBuffer;
    var overtimeH = o.overtimeH == null ? 8 : o.overtimeH;
    var farMiles = o.farMiles == null ? 25 : o.farMiles;
    var flags = [];
    if (!visits || !visits.length) return flags;

    var day = visits.slice().sort(function (a, b) { return a.s - b.s; });

    for (var i = 1; i < day.length; i++) {
      var prev = day[i - 1], cur = day[i];
      var miles = milesBetween(prev, cur);
      if (miles == null) continue;               // no coordinates = no claim
      var drive = driveMinutes(miles);
      var gapMin = Math.round((cur.s - prev.e) * 60);

      // TRAVEL GAP: the schedule does not allow for the drive it implies.
      if (drive > gapMin) {
        flags.push({
          type: 'travel_gap',
          severity: gapMin < 0 ? 'high' : 'medium',
          visitId: cur.id,
          title: 'Not enough time to get there',
          reasons: [
            Math.round(miles * 10) / 10 + ' miles from ' + (prev.client || 'the previous job'),
            'about ' + drive + ' min drive, ' + gapMin + ' min in the schedule',
            'ends ' + fmtTime(prev.e) + ', next starts ' + fmtTime(cur.s),
          ],
          shortfallMin: drive - gapMin,
        });
      } else if (gapMin - drive > buffer * 4) {
        // IDLE GAP: paid time with nothing in it, beyond the configured buffer.
        flags.push({
          type: 'idle_gap',
          severity: 'low',
          visitId: cur.id,
          title: 'Long idle stretch',
          reasons: [
            (gapMin - drive) + ' min free after the drive',
            'free from ' + fmtTime(prev.e) + ' to ' + fmtTime(cur.s),
          ],
          idleMin: gapMin - drive,
        });
      }

      // GEO MISMATCH: a leg far outside the day's normal spread.
      if (miles >= farMiles) {
        flags.push({
          type: 'geo_mismatch',
          severity: 'medium',
          visitId: cur.id,
          title: 'Long way from the rest of the day',
          reasons: [
            Math.round(miles) + ' miles from ' + (prev.client || 'the previous job'),
            'about ' + drive + ' min each way',
          ],
          miles: Math.round(miles),
        });
      }
    }

    // OVERTIME: first start to last end, against the company's own threshold.
    var span = day[day.length - 1].e - day[0].s;
    if (span > overtimeH) {
      flags.push({
        type: 'overtime',
        severity: span > overtimeH + 2 ? 'high' : 'medium',
        visitId: day[day.length - 1].id,
        title: 'Day runs into overtime',
        reasons: [
          Math.round(span * 10) / 10 + ' h from first start to last end',
          'threshold is ' + overtimeH + ' h',
          fmtTime(day[0].s) + ' to ' + fmtTime(day[day.length - 1].e),
        ],
        overBy: Math.round((span - overtimeH) * 10) / 10,
      });
    }

    return flags;
  }

  root.HLAdvisor = {
    milesBetween: milesBetween,
    driveMinutes: driveMinutes,
    flagsForDay: flagsForDay,
  };
})(typeof window !== 'undefined' ? window : globalThis);
