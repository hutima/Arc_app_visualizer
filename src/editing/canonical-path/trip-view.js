// Derive Trip-shaped views of a Track. Two endpoint strategies:
//
// 1. Naive (default): first/last non-empty point. Used when we just need
//    a Trip summary, e.g. for bbox prefilters.
// 2. Robust (when an anchor is in scope): walk forward picking the first
//    inside-radius point whose timestamp is consistent with its neighbours.
//    This sidesteps the "underground first trkpt is 200m off-route" failure
//    mode without throwing away points that legitimately drift.

import { bboxOf, distMeters, inCircle } from "./geo.js";

const MAX_GAP_FOR_CONSISTENCY_MS = 600_000; // 10 minutes

function flattenPoints(track) {
  const out = [];
  for (const seg of track.segments) {
    for (const p of seg.points) out.push(p);
  }
  return out;
}

function firstNonEmpty(track) {
  for (const seg of track.segments) {
    if (seg.points.length) return seg.points[0];
  }
  return null;
}

function lastNonEmpty(track) {
  for (let i = track.segments.length - 1; i >= 0; i--) {
    const pts = track.segments[i].points;
    if (pts.length) return pts[pts.length - 1];
  }
  return null;
}

function parseT(p) {
  if (!p || !p.time) return null;
  const t = Date.parse(p.time);
  return Number.isFinite(t) ? t : null;
}

/**
 * Walk forward; pick the first inside-radius point whose timestamp does not
 * stand out as an outlier vs. its immediate neighbours.
 *
 * Falls back to the literal first non-empty point if nothing qualifies.
 */
export function robustStart(track, anchor) {
  if (!anchor) return firstNonEmpty(track);
  const pts = flattenPoints(track);
  let prevT = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const t = parseT(p);
    const inside = inCircle(p, anchor, anchor.radiusMeters);
    const tOk = t == null || prevT == null
      || (t - prevT >= 0 && (t - prevT) < MAX_GAP_FOR_CONSISTENCY_MS);
    if (inside && tOk) return p;
    if (t != null) prevT = t;
  }
  return firstNonEmpty(track);
}

export function robustEnd(track, anchor) {
  if (!anchor) return lastNonEmpty(track);
  const pts = flattenPoints(track);
  let nextT = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    const t = parseT(p);
    const inside = inCircle(p, anchor, anchor.radiusMeters);
    const tOk = t == null || nextT == null
      || (nextT - t >= 0 && (nextT - t) < MAX_GAP_FOR_CONSISTENCY_MS);
    if (inside && tOk) return p;
    if (t != null) nextT = t;
  }
  return lastNonEmpty(track);
}

/**
 * @param {import("../../model/types.js").Track} track
 * @param {{ startAnchor?: any, endAnchor?: any }} [opts]
 * @returns {import("../../model/types.js").Trip | null}
 */
export function tripOf(track, opts = {}) {
  const start = opts.startAnchor ? robustStart(track, opts.startAnchor) : firstNonEmpty(track);
  const end = opts.endAnchor ? robustEnd(track, opts.endAnchor) : lastNonEmpty(track);
  if (!start || !end) return null;
  return {
    trackId: track.id,
    sourceId: track.sourceId,
    type: track.type || "",
    start, end,
    bbox: bboxOf(flattenPoints(track)),
  };
}

/** All non-empty Trips for a source. */
export function tripsOfSource(source, opts) {
  const out = [];
  for (const t of source.tracks) {
    const trip = tripOf(t, opts);
    if (trip) out.push(trip);
  }
  return out;
}

export { flattenPoints, firstNonEmpty, lastNonEmpty, parseT };
