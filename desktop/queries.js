// Read-side queries against the SQLite store. The functions in this module
// return Source / Track shapes that match the existing src/model/types.js,
// so the browser code path can consume them unchanged.

import { decodePoints } from "./codec.js";

/**
 * Parse the stored extras XML back into Element nodes so the browser
 * serializer can re-emit them. xmldom Documents are usable on the server
 * side too via dom-shim.
 */
function parseExtrasXml(xml) {
  if (!xml) return undefined;
  const wrapped = `<x>${xml}</x>`;
  const doc = new DOMParser().parseFromString(wrapped, "application/xml");
  const root = doc.documentElement;
  const out = [];
  for (const n of root.childNodes) if (n.nodeType === 1) out.push(n);
  return out.length ? out : undefined;
}

export function listSourcesSummary(db) {
  const rows = db.prepare(`
    SELECT
      s.id, s.filename, s.imported_at AS importedAt,
      s.creator,
      (SELECT COUNT(*) FROM tracks t WHERE t.source_id = s.id) AS trackCount,
      (SELECT COUNT(*) FROM segments g JOIN tracks t ON g.track_id = t.id WHERE t.source_id = s.id) AS segmentCount,
      (SELECT COALESCE(SUM(t.point_count), 0) FROM tracks t WHERE t.source_id = s.id) AS pointCount,
      (SELECT COUNT(*) FROM waypoints w WHERE w.source_id = s.id) AS waypointCount,
      (SELECT MIN(bbox_min_lat) FROM tracks t WHERE t.source_id = s.id) AS minLat,
      (SELECT MIN(bbox_min_lon) FROM tracks t WHERE t.source_id = s.id) AS minLon,
      (SELECT MAX(bbox_max_lat) FROM tracks t WHERE t.source_id = s.id) AS maxLat,
      (SELECT MAX(bbox_max_lon) FROM tracks t WHERE t.source_id = s.id) AS maxLon
    FROM sources s
    ORDER BY s.imported_at, s.filename
  `).all();
  for (const r of rows) {
    r.bbox = r.minLat == null ? null : [r.minLat, r.minLon, r.maxLat, r.maxLon];
    delete r.minLat; delete r.minLon; delete r.maxLat; delete r.maxLon;
  }
  return rows;
}

export function listTypesSummary(db) {
  return db.prepare(`
    SELECT type, COUNT(*) AS trackCount, SUM(point_count) AS pointCount
    FROM tracks
    GROUP BY type
    ORDER BY trackCount DESC
  `).all();
}

/**
 * Load one full Source as the browser model would see it (with parsed
 * extras nodes ready for the serializer). Points are decoded from blobs.
 *
 * @returns {import("../src/model/types.js").Source | null}
 */
export function loadFullSource(db, sourceId) {
  const s = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(sourceId);
  if (!s) return null;

  const tracks = db.prepare(`
    SELECT * FROM tracks WHERE source_id = ? ORDER BY ordinal
  `).all(sourceId);

  const segsByTrack = new Map();
  const segs = db.prepare(`
    SELECT g.* FROM segments g
    JOIN tracks t ON g.track_id = t.id
    WHERE t.source_id = ?
    ORDER BY t.ordinal, g.ordinal
  `).all(sourceId);
  for (const g of segs) {
    if (!segsByTrack.has(g.track_id)) segsByTrack.set(g.track_id, []);
    segsByTrack.get(g.track_id).push(g);
  }

  const wpts = db.prepare(`
    SELECT * FROM waypoints WHERE source_id = ? ORDER BY ordinal
  `).all(sourceId);

  const source = {
    id: s.id,
    filename: s.filename,
    importedAt: s.imported_at,
    creator: s.creator || undefined,
    rootAttrs: s.root_attrs ? JSON.parse(s.root_attrs) : undefined,
    tracks: tracks.map(t => ({
      id: t.id,
      sourceId: t.source_id,
      name: t.name || undefined,
      type: t.type || "",
      rawType: t.raw_type || undefined,
      segments: (segsByTrack.get(t.id) || []).map(g => ({
        id: g.id,
        trackId: g.track_id,
        points: decodePoints(g.coords, g.times, g.eles),
        extras: parseExtrasXml(g.extras_xml),
      })),
      extras: parseExtrasXml(t.extras_xml),
    })),
    waypoints: wpts.map(w => ({
      id: w.id,
      sourceId: w.source_id,
      lat: w.lat, lon: w.lon,
      name: w.name || undefined,
      time: w.time || undefined,
      extras: parseExtrasXml(w.extras_xml),
    })),
    extras: parseExtrasXml(s.extras_xml),
  };
  return source;
}

/**
 * Cheap track summaries for the canonical-path matcher when we don't want
 * to decode every blob just to compute trip endpoints. Each row already
 * carries first/last point and bbox; that's everything the matcher needs
 * for the non-robust path.
 *
 * For robust-endpoint extraction we still need point sequences, so the
 * matcher falls back to loadFullSource for the candidate tracks. Cheap in
 * the common case where most tracks reject early.
 */
export function listTrackSummaries(db, { sourceIds, bbox } = {}) {
  let sql = `SELECT * FROM tracks`;
  const where = [];
  const args = [];
  if (sourceIds?.length) {
    where.push(`source_id IN (${sourceIds.map(() => "?").join(",")})`);
    args.push(...sourceIds);
  }
  if (bbox) {
    where.push(`bbox_max_lat >= ? AND bbox_min_lat <= ? AND bbox_max_lon >= ? AND bbox_min_lon <= ?`);
    args.push(bbox[0], bbox[2], bbox[1], bbox[3]);
  }
  if (where.length) sql += ` WHERE ` + where.join(" AND ");
  sql += ` ORDER BY source_id, ordinal`;
  return db.prepare(sql).all(...args);
}

export function deleteSource(db, sourceId) {
  // tracks_rtree rows live by rowid; clean them up first.
  const ids = db.prepare(`SELECT rowid FROM tracks WHERE source_id = ?`).all(sourceId);
  const delRtree = db.prepare(`DELETE FROM tracks_rtree WHERE rowid = ?`);
  const tx = db.transaction(() => {
    for (const r of ids) delRtree.run(r.rowid);
    db.prepare(`DELETE FROM sources WHERE id = ?`).run(sourceId);
  });
  tx();
}

// ----- Anchor pairs + canonical paths -----

function anchorPairFromRow(r) {
  return {
    id: r.id,
    label: r.label || "",
    start: {
      lat: r.start_lat, lon: r.start_lon,
      radiusMeters: r.start_radius_m,
      label: r.start_label || undefined,
    },
    end: {
      lat: r.end_lat, lon: r.end_lon,
      radiusMeters: r.end_radius_m,
      label: r.end_label || undefined,
    },
    bidirectional: !!r.bidirectional,
    chainFragments: !!r.chain_fragments,
    chainGapSec: r.chain_gap_sec,
    filters: r.filters ? JSON.parse(r.filters) : undefined,
    canonicalPathId: r.canonical_path_id || undefined,
    enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

export function listAnchorPairs(db) {
  return db.prepare(`SELECT * FROM anchor_pairs ORDER BY created_at`).all()
    .map(anchorPairFromRow);
}

export function upsertAnchorPair(db, pair) {
  const exists = db.prepare(`SELECT 1 FROM anchor_pairs WHERE id = ?`).get(pair.id);
  if (exists) {
    db.prepare(`
      UPDATE anchor_pairs SET
        label = ?,
        start_lat = ?, start_lon = ?, start_radius_m = ?, start_label = ?,
        end_lat = ?, end_lon = ?, end_radius_m = ?, end_label = ?,
        bidirectional = ?, chain_fragments = ?, chain_gap_sec = ?,
        filters = ?, canonical_path_id = ?, enabled = ?
      WHERE id = ?
    `).run(
      pair.label || null,
      pair.start.lat, pair.start.lon, pair.start.radiusMeters, pair.start.label || null,
      pair.end.lat, pair.end.lon, pair.end.radiusMeters, pair.end.label || null,
      pair.bidirectional ? 1 : 0,
      pair.chainFragments ? 1 : 0,
      pair.chainGapSec ?? 180,
      pair.filters ? JSON.stringify(pair.filters) : null,
      pair.canonicalPathId || null,
      pair.enabled ? 1 : 0,
      pair.id,
    );
  } else {
    db.prepare(`
      INSERT INTO anchor_pairs (
        id, label,
        start_lat, start_lon, start_radius_m, start_label,
        end_lat, end_lon, end_radius_m, end_label,
        bidirectional, chain_fragments, chain_gap_sec,
        filters, canonical_path_id, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pair.id, pair.label || null,
      pair.start.lat, pair.start.lon, pair.start.radiusMeters, pair.start.label || null,
      pair.end.lat, pair.end.lon, pair.end.radiusMeters, pair.end.label || null,
      pair.bidirectional ? 1 : 0,
      pair.chainFragments ? 1 : 0,
      pair.chainGapSec ?? 180,
      pair.filters ? JSON.stringify(pair.filters) : null,
      pair.canonicalPathId || null,
      pair.enabled ? 1 : 0,
      pair.createdAt || Date.now(),
    );
  }
}

export function deleteAnchorPair(db, id) {
  db.prepare(`DELETE FROM anchor_pairs WHERE id = ?`).run(id);
}

function canonicalFromRow(r) {
  return {
    id: r.id,
    anchorPairId: r.anchor_pair_id,
    vertices: JSON.parse(r.vertices),
    origin: r.origin,
    exemplarSourceId: r.exemplar_source_id || undefined,
    exemplarTrackId: r.exemplar_track_id || undefined,
    preSnapVertices: r.pre_snap_vertices ? JSON.parse(r.pre_snap_vertices) : undefined,
    updatedAt: r.updated_at,
  };
}

export function listCanonicalPaths(db) {
  return db.prepare(`SELECT * FROM canonical_paths`).all().map(canonicalFromRow);
}

export function upsertCanonicalPath(db, cp) {
  const exists = db.prepare(`SELECT 1 FROM canonical_paths WHERE id = ?`).get(cp.id);
  if (exists) {
    db.prepare(`
      UPDATE canonical_paths SET
        anchor_pair_id = ?, vertices = ?, origin = ?,
        exemplar_source_id = ?, exemplar_track_id = ?,
        pre_snap_vertices = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cp.anchorPairId, JSON.stringify(cp.vertices), cp.origin,
      cp.exemplarSourceId || null, cp.exemplarTrackId || null,
      cp.preSnapVertices ? JSON.stringify(cp.preSnapVertices) : null,
      cp.updatedAt || Date.now(),
      cp.id,
    );
  } else {
    db.prepare(`
      INSERT INTO canonical_paths (
        id, anchor_pair_id, vertices, origin,
        exemplar_source_id, exemplar_track_id, pre_snap_vertices, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cp.id, cp.anchorPairId, JSON.stringify(cp.vertices), cp.origin,
      cp.exemplarSourceId || null, cp.exemplarTrackId || null,
      cp.preSnapVertices ? JSON.stringify(cp.preSnapVertices) : null,
      cp.updatedAt || Date.now(),
    );
  }
  // Maintain the anchor_pairs.canonical_path_id FK pointer.
  db.prepare(`UPDATE anchor_pairs SET canonical_path_id = ? WHERE id = ?`)
    .run(cp.id, cp.anchorPairId);
}

export function deleteCanonicalPath(db, id) {
  const row = db.prepare(`SELECT anchor_pair_id FROM canonical_paths WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM canonical_paths WHERE id = ?`).run(id);
  if (row) {
    db.prepare(`UPDATE anchor_pairs SET canonical_path_id = NULL WHERE id = ?`).run(row.anchor_pair_id);
  }
}
