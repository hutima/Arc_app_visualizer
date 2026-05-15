// Adjacent-track chaining heuristic.
//
// ARC sometimes fragments a single subway trip into [walk, stationary, metro,
// walk]. When the user opts into chaining on an anchor pair, the matcher
// stitches tracks together along the time axis (same source only, default
// gap 180 seconds) and matches the synthetic chain against the radii.
//
// The output is a virtual unit; nothing in the store is mutated.

import { bboxOf, bboxUnion } from "./geo.js";
import { firstNonEmpty, lastNonEmpty, parseT } from "./trip-view.js";

/**
 * @typedef {Object} Chain
 * @property {string} sourceId
 * @property {string[]} trackIds
 * @property {import("../../model/types.js").Point} start
 * @property {import("../../model/types.js").Point} end
 * @property {[number,number,number,number]} bbox
 * @property {string} effectiveType
 */

function trackBbox(track) {
  const pts = [];
  for (const s of track.segments) for (const p of s.points) pts.push(p);
  return bboxOf(pts);
}

function pickDominantType(tracks) {
  // Prefer transit-ish types over walking/stationary if present.
  const transit = new Set(["metro", "train", "tram", "bus", "airplane", "boat", "cablecar"]);
  for (const t of tracks) if (transit.has(t.type)) return t.type;
  // Otherwise the longest by point count wins.
  let best = tracks[0], bestN = -1;
  for (const t of tracks) {
    let n = 0;
    for (const s of t.segments) n += s.points.length;
    if (n > bestN) { best = t; bestN = n; }
  }
  return best.type || "";
}

/**
 * @param {import("../../model/types.js").Track[]} tracks
 * @param {{maxGapSec?: number, sameSourceOnly?: boolean}} [opts]
 * @returns {Chain[]}
 */
export function chainTracks(tracks, opts = {}) {
  const maxGapMs = (opts.maxGapSec ?? 180) * 1000;
  const sameSourceOnly = opts.sameSourceOnly !== false;

  const buckets = new Map();
  for (const t of tracks) {
    const key = sameSourceOnly ? t.sourceId : "_";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }

  /** @type {Chain[]} */
  const out = [];

  for (const bucket of buckets.values()) {
    // Sort by first-point time; tracks without times go to the end.
    const dated = bucket.map(t => ({ t, ts: parseT(firstNonEmpty(t)) }));
    dated.sort((a, b) => {
      if (a.ts == null && b.ts == null) return 0;
      if (a.ts == null) return 1;
      if (b.ts == null) return -1;
      return a.ts - b.ts;
    });

    let cur = [];
    let prevEnd = null;
    const flush = () => {
      if (!cur.length) return;
      out.push(buildChain(cur));
      cur = [];
    };
    for (const { t, ts } of dated) {
      const startTs = ts;
      const endTs = parseT(lastNonEmpty(t));
      if (!cur.length) {
        cur.push(t);
        prevEnd = endTs;
        continue;
      }
      const gap = startTs != null && prevEnd != null ? startTs - prevEnd : Infinity;
      if (gap >= 0 && gap <= maxGapMs) {
        cur.push(t);
        if (endTs != null) prevEnd = endTs;
      } else {
        flush();
        cur.push(t);
        prevEnd = endTs;
      }
    }
    flush();
  }
  return out;
}

function buildChain(tracks) {
  const start = firstNonEmpty(tracks[0]);
  const end = lastNonEmpty(tracks[tracks.length - 1]);
  let bbox = trackBbox(tracks[0]);
  for (let i = 1; i < tracks.length; i++) bbox = bboxUnion(bbox, trackBbox(tracks[i]));
  return {
    sourceId: tracks[0].sourceId,
    trackIds: tracks.map(t => t.id),
    start,
    end,
    bbox,
    effectiveType: pickDominantType(tracks),
  };
}
