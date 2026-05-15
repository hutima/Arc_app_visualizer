// GPX file -> SQLite. Reuses the existing browser parser (via dom-shim) and
// then writes the parsed Source into the DB in blob form.

import "./dom-shim.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseGpx } from "../src/parser/gpx-parser.js";
import { encodePoints, summarizePoints } from "./codec.js";

/**
 * Replace the parser's session-local IDs with stable UUIDs so the rows live
 * past the ingesting process. Mutates in place.
 */
function reidSource(source) {
  source.id = `src_${randomUUID()}`;
  for (const t of source.tracks) {
    t.id = `trk_${randomUUID()}`;
    t.sourceId = source.id;
    for (const s of t.segments) {
      s.id = `seg_${randomUUID()}`;
      s.trackId = t.id;
    }
  }
  for (const w of source.waypoints) {
    w.id = `wpt_${randomUUID()}`;
    w.sourceId = source.id;
  }
}

/**
 * Serialize an array of DOM Element nodes back to XML so they can survive
 * a DB round trip. The browser serializer accepts these back via importNode.
 */
function serializeExtras(extras) {
  if (!extras || !extras.length) return null;
  const xs = new XMLSerializer();
  return extras.map(n => xs.serializeToString(n)).join("");
}

/**
 * Insert one parsed Source into the DB. Returns the inserted source.id.
 *
 * @param {ReturnType<typeof import("../src/parser/gpx-parser.js").parseGpx>} source
 * @param {import("better-sqlite3").Database} db
 */
export function insertSource(source, db) {
  reidSource(source);

  const insertSrc = db.prepare(`
    INSERT INTO sources (id, filename, imported_at, creator, root_attrs, extras_xml)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertTrk = db.prepare(`
    INSERT INTO tracks (
      id, source_id, ordinal, name, type, raw_type, point_count,
      bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
      first_lat, first_lon, first_time,
      last_lat, last_lon, last_time,
      extras_xml
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRtree = db.prepare(`
    INSERT INTO tracks_rtree (rowid, min_lat, max_lat, min_lon, max_lon)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSeg = db.prepare(`
    INSERT INTO segments (
      id, track_id, ordinal, point_count, coords, times, eles,
      has_times, has_eles, extras_xml
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWpt = db.prepare(`
    INSERT INTO waypoints (id, source_id, ordinal, lat, lon, name, time, extras_xml)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getTrackRowid = db.prepare(`SELECT rowid FROM tracks WHERE id = ?`);

  const tx = db.transaction(() => {
    insertSrc.run(
      source.id,
      source.filename,
      source.importedAt,
      source.creator || null,
      source.rootAttrs ? JSON.stringify(source.rootAttrs) : null,
      serializeExtras(source.extras),
    );

    source.tracks.forEach((t, idx) => {
      // Aggregate over all segments to fill the per-track summary columns.
      let totalCount = 0;
      let agg = null;
      for (const seg of t.segments) {
        const s = summarizePoints(seg.points);
        totalCount += s.count;
        if (!s.bbox) continue;
        if (!agg) {
          agg = {
            bbox: { ...s.bbox },
            first: s.first,
            last: s.last,
          };
        } else {
          agg.bbox.minLat = Math.min(agg.bbox.minLat, s.bbox.minLat);
          agg.bbox.minLon = Math.min(agg.bbox.minLon, s.bbox.minLon);
          agg.bbox.maxLat = Math.max(agg.bbox.maxLat, s.bbox.maxLat);
          agg.bbox.maxLon = Math.max(agg.bbox.maxLon, s.bbox.maxLon);
          agg.last = s.last;
        }
      }
      insertTrk.run(
        t.id, source.id, idx, t.name || null, t.type || "",
        t.rawType || null, totalCount,
        agg?.bbox.minLat ?? null, agg?.bbox.minLon ?? null,
        agg?.bbox.maxLat ?? null, agg?.bbox.maxLon ?? null,
        agg?.first?.lat ?? null, agg?.first?.lon ?? null, agg?.first?.time ?? null,
        agg?.last?.lat ?? null,  agg?.last?.lon ?? null,  agg?.last?.time ?? null,
        serializeExtras(t.extras),
      );
      if (agg) {
        const { rowid } = getTrackRowid.get(t.id);
        insertRtree.run(rowid, agg.bbox.minLat, agg.bbox.maxLat, agg.bbox.minLon, agg.bbox.maxLon);
      }

      t.segments.forEach((seg, segIdx) => {
        const { coords, times, eles, hasTimes, hasEles } = encodePoints(seg.points);
        insertSeg.run(
          seg.id, t.id, segIdx, seg.points.length,
          coords, times, eles,
          hasTimes ? 1 : 0, hasEles ? 1 : 0,
          serializeExtras(seg.extras),
        );
      });
    });

    source.waypoints.forEach((w, idx) => {
      insertWpt.run(
        w.id, source.id, idx, w.lat, w.lon,
        w.name || null, w.time || null,
        serializeExtras(w.extras),
      );
    });
  });
  tx();
  return source.id;
}

/**
 * Ingest one GPX file from disk. Resolves with `{ sourceId, tracks, points }`.
 */
export async function ingestFile(path, db) {
  const xml = await readFile(path, "utf-8");
  const source = parseGpx(xml, basename(path));
  const id = insertSource(source, db);
  let pts = 0;
  for (const t of source.tracks) for (const s of t.segments) pts += s.points.length;
  return { sourceId: id, tracks: source.tracks.length, points: pts };
}
