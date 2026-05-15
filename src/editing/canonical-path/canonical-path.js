// CanonicalPath constructors and small utilities.
//
// A CanonicalPath is just an ordered vertex list (lat, lon) plus metadata
// about where it came from. The editing state owns its lifecycle.

import { nextId } from "../../core/id.js";
import { cumulativeDistances, distMeters, polylineLengthMeters } from "./geo.js";

/**
 * @param {[number,number][]} vertices
 * @param {string} anchorPairId
 */
export function fromVertices(vertices, anchorPairId) {
  return {
    id: nextId("cp"),
    anchorPairId,
    vertices: vertices.map(v => [v[0], v[1]]),
    origin: "drawn",
    updatedAt: Date.now(),
  };
}

/**
 * Flatten an exemplar track's segments into one ordered vertex list.
 * @param {import("../../model/types.js").Track} track
 * @param {string} anchorPairId
 */
export function fromExemplarTrack(track, anchorPairId) {
  const vertices = [];
  for (const seg of track.segments) {
    for (const p of seg.points) vertices.push([p.lat, p.lon]);
  }
  return {
    id: nextId("cp"),
    anchorPairId,
    vertices,
    origin: "exemplar",
    exemplarSourceId: track.sourceId,
    exemplarTrackId: track.id,
    updatedAt: Date.now(),
  };
}

/**
 * Replace a canonical's vertex list while preserving its identity. Returns
 * a new object (immutable update); the caller writes it back to the store.
 *
 * @param {import("../../model/types.js").CanonicalPath} canonical
 * @param {[number,number][]} vertices
 * @param {"drawn"|"exemplar"|"imported"|"road-snapped"} [origin]
 */
export function withVertices(canonical, vertices, origin) {
  return {
    ...canonical,
    vertices: vertices.map(v => [v[0], v[1]]),
    origin: origin || canonical.origin,
    updatedAt: Date.now(),
  };
}

/**
 * Insert intermediate vertices along any segment longer than `maxStepMeters`,
 * by linear lat/lon interpolation. Cheap and good enough at small scales.
 */
export function densify(vertices, maxStepMeters) {
  if (!vertices || vertices.length < 2 || !(maxStepMeters > 0)) return vertices;
  const out = [vertices[0]];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const d = distMeters({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    if (d > maxStepMeters) {
      const n = Math.ceil(d / maxStepMeters);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out.push(b);
  }
  return out;
}

export function lengthMeters(canonical) {
  return canonical?.vertices?.length ? polylineLengthMeters(canonical.vertices) : 0;
}

export function vertexCount(canonical) {
  return canonical?.vertices?.length || 0;
}

/**
 * Cumulative distances along a canonical's vertex list, in meters.
 */
export function cumDistances(canonical) {
  return canonical?.vertices?.length ? cumulativeDistances(canonical.vertices) : [];
}
