// Anchor-pair matcher. Given the loaded sources and a pair, return the list
// of matching units (tracks or synthesised chains), classified as forward or
// reverse, filtered by type and time-of-day if requested.

import { bboxIntersectsCircle, bboxOf, distMeters, inCircle } from "./geo.js";
import { chainTracks } from "./chaining.js";
import { robustStart, robustEnd, firstNonEmpty, lastNonEmpty, flattenPoints, parseT } from "./trip-view.js";

function passesTypeFilter(type, filters) {
  if (!filters?.includeTypes?.length) return true;
  return filters.includeTypes.includes(type || "");
}

function passesTimeFilter(startPoint, filters) {
  if (!filters) return true;
  const ts = parseT(startPoint);
  if (ts == null) {
    return !(filters.weekdays?.length || filters.hourRange);
  }
  const d = new Date(ts);
  if (filters.weekdays?.length && !filters.weekdays.includes(d.getDay())) return false;
  if (filters.hourRange) {
    const [a, b] = filters.hourRange;
    const h = d.getHours();
    if (h < a || h >= b) return false;
  }
  return true;
}

function unitFromTrack(track) {
  const pts = flattenPoints(track);
  return {
    sourceId: track.sourceId,
    trackIds: [track.id],
    chained: false,
    type: track.type || "",
    bbox: bboxOf(pts),
    track,
  };
}

function unitFromChain(chain, tracksById) {
  return {
    sourceId: chain.sourceId,
    trackIds: chain.trackIds,
    chained: true,
    type: chain.effectiveType,
    bbox: chain.bbox,
    chainTracks: chain.trackIds.map(id => tracksById.get(id)),
  };
}

function tryMatchUnit(unit, anchorA, anchorB) {
  if (!bboxIntersectsCircle(unit.bbox, anchorA, anchorA.radiusMeters)
   && !bboxIntersectsCircle(unit.bbox, anchorB, anchorB.radiusMeters)) {
    return null;
  }
  // For chained units we treat the synthetic chain as a single virtual track
  // for endpoint purposes - first point of first, last point of last.
  const startPt = unit.chained
    ? robustStartOfChain(unit.chainTracks, anchorA)
    : robustStart(unit.track, anchorA);
  const endPt = unit.chained
    ? robustEndOfChain(unit.chainTracks, anchorB)
    : robustEnd(unit.track, anchorB);
  if (!startPt || !endPt) return null;
  if (!inCircle(startPt, anchorA, anchorA.radiusMeters)) return null;
  if (!inCircle(endPt, anchorB, anchorB.radiusMeters)) return null;
  return {
    robustStart: startPt,
    robustEnd: endPt,
    startDistMeters: distMeters(startPt, anchorA),
    endDistMeters: distMeters(endPt, anchorB),
  };
}

function robustStartOfChain(tracks, anchor) {
  for (const t of tracks) {
    const p = robustStart(t, anchor);
    if (p && inCircle(p, anchor, anchor.radiusMeters)) return p;
  }
  return firstNonEmpty(tracks[0]);
}

function robustEndOfChain(tracks, anchor) {
  for (let i = tracks.length - 1; i >= 0; i--) {
    const p = robustEnd(tracks[i], anchor);
    if (p && inCircle(p, anchor, anchor.radiusMeters)) return p;
  }
  return lastNonEmpty(tracks[tracks.length - 1]);
}

/**
 * @param {import("../../model/types.js").Source[]} sources
 * @param {import("../../model/types.js").AnchorPair} pair
 * @returns {import("../../model/types.js").MatchCandidate[]}
 */
export function findMatches(sources, pair) {
  const allTracks = sources.flatMap(s => s.tracks);
  const tracksById = new Map(allTracks.map(t => [t.id, t]));

  /** @type {Array<ReturnType<typeof unitFromTrack> | ReturnType<typeof unitFromChain>>} */
  let units;
  if (pair.chainFragments) {
    const chains = chainTracks(allTracks, {
      maxGapSec: pair.chainGapSec ?? 180,
      sameSourceOnly: true,
    });
    // Tracks that didn't get into a multi-track chain still appear as
    // length-1 chains; we can treat them uniformly.
    units = chains.map(c => c.trackIds.length === 1
      ? unitFromTrack(tracksById.get(c.trackIds[0]))
      : unitFromChain(c, tracksById));
  } else {
    units = allTracks.map(unitFromTrack);
  }

  /** @type {import("../../model/types.js").MatchCandidate[]} */
  const out = [];

  for (const unit of units) {
    if (!passesTypeFilter(unit.type, pair.filters)) continue;

    const fwd = tryMatchUnit(unit, pair.start, pair.end);
    if (fwd && passesTimeFilter(fwd.robustStart, pair.filters)) {
      out.push({
        sourceId: unit.sourceId,
        trackIds: unit.trackIds.slice(),
        robustStart: fwd.robustStart,
        robustEnd: fwd.robustEnd,
        direction: "forward",
        chained: unit.chained,
        startDistMeters: fwd.startDistMeters,
        endDistMeters: fwd.endDistMeters,
      });
      continue;
    }

    if (pair.bidirectional) {
      const rev = tryMatchUnit(unit, pair.end, pair.start);
      if (rev && passesTimeFilter(rev.robustStart, pair.filters)) {
        out.push({
          sourceId: unit.sourceId,
          trackIds: unit.trackIds.slice(),
          // Surface direction-aligned endpoints: robustStart is at pair.start.
          robustStart: rev.robustEnd,
          robustEnd: rev.robustStart,
          direction: "reverse",
          chained: unit.chained,
          startDistMeters: rev.endDistMeters,
          endDistMeters: rev.startDistMeters,
        });
      }
    }
  }

  out.sort((a, b) => {
    const aT = parseT(a.robustStart) ?? Infinity;
    const bT = parseT(b.robustStart) ?? Infinity;
    if (aT !== bT) return aT - bT;
    return (a.startDistMeters + a.endDistMeters) - (b.startDistMeters + b.endDistMeters);
  });

  return out;
}
