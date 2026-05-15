// Turn a (canonical, match) pair into the EditOp(s) that rewrite the matched
// track(s). Time is distributed along the canonical by along-path distance,
// anchored to the match's robust endpoints.

import { nextId } from "../../core/id.js";
import { cumulativeDistances } from "./geo.js";
import { snapshotTrack, makeOp } from "./edit-ops.js";
import { parseT } from "./trip-view.js";

const DEFAULT_STRATEGY = {
  // Decision 1: overwrite + push EditOp (undo restores).
  replacementMode: "overwrite",
  // Decision 2: single segment.
  segmentMode: "single",
  // Whether to keep the original first / last trkpt exactly.
  preserveOriginalEndpoints: false,
};

function distributeTimes(vertices, t0, t1) {
  const cum = cumulativeDistances(vertices);
  const total = cum[cum.length - 1] || 0;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0 || total === 0) {
    // No usable time anchors; emit untimed points. The serializer skips time.
    return vertices.map(v => ({ lat: v[0], lon: v[1] }));
  }
  const dt = t1 - t0;
  return vertices.map((v, i) => ({
    lat: v[0],
    lon: v[1],
    time: new Date(t0 + dt * (cum[i] / total)).toISOString(),
  }));
}

/**
 * @param {import("../../model/types.js").CanonicalPath} canonical
 * @param {import("../../model/types.js").MatchCandidate} match
 * @param {import("../../model/types.js").Source} source
 * @param {{strategy?: Partial<typeof DEFAULT_STRATEGY>, groupId?: string}} [opts]
 * @returns {import("../../model/types.js").EditOp[]}
 */
export function planApply(canonical, match, source, opts = {}) {
  const strategy = { ...DEFAULT_STRATEGY, ...(opts.strategy || {}) };
  const groupId = opts.groupId || nextId("grp");

  // Reverse the canonical for reverse-direction matches (decision 8).
  const vertices = match.direction === "reverse"
    ? canonical.vertices.slice().reverse()
    : canonical.vertices.slice();

  const t0 = parseT(match.robustStart);
  const t1 = parseT(match.robustEnd);
  let pointList = distributeTimes(vertices, t0, t1);

  if (strategy.preserveOriginalEndpoints && pointList.length >= 2) {
    pointList[0] = { ...pointList[0], lat: match.robustStart.lat, lon: match.robustStart.lon };
    const li = pointList.length - 1;
    pointList[li] = { ...pointList[li], lat: match.robustEnd.lat, lon: match.robustEnd.lon };
  }

  const ops = [];

  // For chained matches we replace the first track and delete the rest.
  const trackIds = match.trackIds;
  const primaryTrackId = trackIds[0];

  const primaryTrack = source.tracks.find(t => t.id === primaryTrackId);
  if (!primaryTrack) return ops;
  const primaryIndex = source.tracks.indexOf(primaryTrack);

  ops.push(makeOp("replaceTrackPoints", {
    groupId,
    anchorPairId: opts.anchorPairId,
    canonicalPathId: canonical.id,
    sourceId: source.id,
    trackId: primaryTrackId,
    newSegments: [{
      id: nextId("seg"),
      trackId: primaryTrackId,
      points: pointList,
    }],
    snapshot: snapshotTrack(primaryTrack, primaryIndex),
  }));

  for (let i = 1; i < trackIds.length; i++) {
    const tid = trackIds[i];
    const tt = source.tracks.find(t => t.id === tid);
    if (!tt) continue;
    ops.push(makeOp("deleteTrack", {
      groupId,
      anchorPairId: opts.anchorPairId,
      canonicalPathId: canonical.id,
      sourceId: source.id,
      trackId: tid,
      snapshot: snapshotTrack(tt, source.tracks.indexOf(tt)),
    }));
  }

  return ops;
}

/**
 * Convenience: plan apply for every match across all sources.
 */
export function planApplyAll(canonical, matches, sourceById, opts = {}) {
  const groupId = opts.groupId || nextId("grp");
  const out = [];
  for (const m of matches) {
    const src = sourceById.get(m.sourceId);
    if (!src) continue;
    out.push(...planApply(canonical, m, src, { ...opts, groupId }));
  }
  return out;
}
