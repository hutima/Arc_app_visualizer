// Edit-operation model.
//
// Ops are applied to a shallow-cloned copy of a Source. The original parsed
// Source in the store is never mutated. `applyOps` is pure: same source +
// same op list always produces the same effective source, which makes undo
// trivial (drop the last group from the op list).

import { nextId } from "../../core/id.js";

/**
 * Stable, cheap fingerprint of a track's identifying bits. Used so an op can
 * notice if the underlying source has been replaced behind its back.
 */
export function fingerprintTrack(track) {
  let ptCount = 0;
  let first = null, last = null;
  for (const s of track.segments) {
    for (const p of s.points) {
      ptCount += 1;
      if (!first) first = p;
      last = p;
    }
  }
  return {
    firstPoint: first ? { lat: first.lat, lon: first.lon, time: first.time || null } : null,
    lastPoint: last ? { lat: last.lat, lon: last.lon, time: last.time || null } : null,
    ptCount,
    type: track.type || "",
  };
}

function shallowCloneTrack(track) {
  return {
    id: track.id,
    sourceId: track.sourceId,
    name: track.name,
    type: track.type,
    rawType: track.rawType,
    segments: track.segments.slice(),
    extras: track.extras,
  };
}

function shallowCloneSource(source) {
  return {
    ...source,
    tracks: source.tracks.slice(),
  };
}

/**
 * Snapshot enough of a track to fully reconstruct it later.
 */
export function snapshotTrack(track, originalIndex) {
  return {
    trackId: track.id,
    name: track.name,
    type: track.type,
    rawType: track.rawType,
    // Segments hold references to immutable Point objects; we shallow-clone
    // the segments array but reuse the points themselves.
    segments: track.segments.map(s => ({
      id: s.id,
      trackId: s.trackId,
      points: s.points.slice(),
      extras: s.extras,
    })),
    extras: track.extras,
    originalIndex,
  };
}

export function makeOp(type, fields) {
  return {
    id: nextId("op"),
    appliedAt: Date.now(),
    groupId: fields.groupId || nextId("grp"),
    type,
    ...fields,
  };
}

/**
 * Apply an ordered list of ops to a source and return a new Source. The
 * original is not mutated. Ops for other sources are ignored.
 *
 * @param {import("../../model/types.js").Source} source
 * @param {import("../../model/types.js").EditOp[]} ops
 */
export function applyOps(source, ops) {
  const mine = ops.filter(o => o.sourceId === source.id);
  if (!mine.length) return source;
  const out = shallowCloneSource(source);
  for (const op of mine) {
    switch (op.type) {
      case "replaceTrackPoints": {
        const idx = out.tracks.findIndex(t => t.id === op.trackId);
        if (idx < 0) break;
        const orig = out.tracks[idx];
        const next = shallowCloneTrack(orig);
        next.segments = [{
          id: nextId("seg"),
          trackId: orig.id,
          points: op.newSegments?.[0]?.points
            ? op.newSegments[0].points.slice()
            : [],
        }];
        // If newSegments contains more than one, splice them all in.
        if (op.newSegments && op.newSegments.length > 1) {
          next.segments = op.newSegments.map(s => ({
            id: s.id || nextId("seg"),
            trackId: orig.id,
            points: s.points.slice(),
          }));
        }
        out.tracks[idx] = next;
        break;
      }
      case "deleteTrack": {
        const idx = out.tracks.findIndex(t => t.id === op.trackId);
        if (idx < 0) break;
        out.tracks.splice(idx, 1);
        break;
      }
      case "insertTrack": {
        const pos = op.insertAfterIndex == null
          ? out.tracks.length
          : Math.min(out.tracks.length, op.insertAfterIndex + 1);
        if (op.newTrack) out.tracks.splice(pos, 0, op.newTrack);
        break;
      }
      default:
        // Unknown op type; ignore (forward compatibility).
        break;
    }
  }
  return out;
}

/**
 * Apply only to one track (used by previews that don't need the full source).
 */
export function applyOpsToTrack(track, ops) {
  const synthSource = { id: track.sourceId, tracks: [track] };
  const next = applyOps(synthSource, ops);
  return next.tracks.find(t => t.id === track.id) || null;
}

/**
 * Quick equality check between a current track and the op's stored snapshot.
 * Returns true if the op can be safely re-applied / undone.
 */
export function fingerprintMatches(track, snapshot) {
  if (!track || !snapshot) return false;
  const a = fingerprintTrack(track);
  const b = {
    firstPoint: snapshot.segments[0]?.points[0]
      ? { lat: snapshot.segments[0].points[0].lat,
          lon: snapshot.segments[0].points[0].lon,
          time: snapshot.segments[0].points[0].time || null }
      : null,
    lastPoint: (() => {
      const segs = snapshot.segments;
      const lastSeg = segs[segs.length - 1];
      const lastPt = lastSeg?.points[lastSeg.points.length - 1];
      return lastPt
        ? { lat: lastPt.lat, lon: lastPt.lon, time: lastPt.time || null }
        : null;
    })(),
    ptCount: snapshot.segments.reduce((n, s) => n + s.points.length, 0),
    type: snapshot.type || "",
  };
  return JSON.stringify(a) === JSON.stringify(b);
}
