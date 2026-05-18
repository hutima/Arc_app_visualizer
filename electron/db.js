"use strict";

const Database = require("better-sqlite3");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  imported_at   INTEGER NOT NULL,
  creator       TEXT,
  visible       INTEGER NOT NULL DEFAULT 1,
  track_count   INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  point_count   INTEGER NOT NULL DEFAULT 0,
  waypoint_count INTEGER NOT NULL DEFAULT 0,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL
);

CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  name       TEXT,
  type       TEXT NOT NULL DEFAULT '',
  raw_type   TEXT,
  start_time INTEGER,
  end_time   INTEGER,
  point_count INTEGER NOT NULL DEFAULT 0,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL
);
CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks(source_id);
CREATE INDEX IF NOT EXISTS idx_tracks_type   ON tracks(type);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_rtree USING rtree(
  id, min_lat, max_lat, min_lon, max_lon
);

CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  point_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_track ON segments(track_id, seq);

CREATE TABLE IF NOT EXISTS points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  ele        REAL,
  time       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_points_segment ON points(segment_id, seq);

CREATE TABLE IF NOT EXISTS waypoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name       TEXT,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  ele        REAL,
  time       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_waypoints_source ON waypoints(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS waypoints_rtree USING rtree(
  id, min_lat, max_lat, min_lon, max_lon
);

CREATE TABLE IF NOT EXISTS type_colors (
  type  TEXT PRIMARY KEY,
  color TEXT NOT NULL
);
`;

function openDatabase(userDataDir) {
  const file = path.join(userDataDir, "library.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -200000");
  db.exec(SCHEMA);

  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();

  return makeApi(db, file);
}

function makeApi(db, file) {
  const stmts = {
    insertSource: db.prepare(`
      INSERT INTO sources (filename, imported_at, creator, visible)
      VALUES (?, ?, ?, 1)
    `),
    updateSourceStats: db.prepare(`
      UPDATE sources
      SET track_count = ?, segment_count = ?, point_count = ?, waypoint_count = ?,
          min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?
      WHERE id = ?
    `),
    setSourceVisible: db.prepare("UPDATE sources SET visible = ? WHERE id = ?"),
    deleteSource: db.prepare("DELETE FROM sources WHERE id = ?"),
    listSources: db.prepare(`
      SELECT id, filename, imported_at AS importedAt, creator, visible,
             track_count    AS trackCount,
             segment_count  AS segmentCount,
             point_count    AS pointCount,
             waypoint_count AS waypointCount,
             min_lat, min_lon, max_lat, max_lon
      FROM sources
      ORDER BY id
    `),
    insertTrack: db.prepare(`
      INSERT INTO tracks (source_id, seq, name, type, raw_type, point_count,
                          start_time, end_time, min_lat, min_lon, max_lat, max_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertTrackRtree: db.prepare(`
      INSERT INTO tracks_rtree (id, min_lat, max_lat, min_lon, max_lon)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertSegment: db.prepare(`
      INSERT INTO segments (track_id, seq, point_count) VALUES (?, ?, ?)
    `),
    insertPoint: db.prepare(`
      INSERT INTO points (segment_id, seq, lat, lon, ele, time)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertWaypoint: db.prepare(`
      INSERT INTO waypoints (source_id, name, lat, lon, ele, time)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertWaypointRtree: db.prepare(`
      INSERT INTO waypoints_rtree (id, min_lat, max_lat, min_lon, max_lon)
      VALUES (?, ?, ?, ?, ?)
    `),
    distinctTypesForSource: db.prepare(`
      SELECT DISTINCT type FROM tracks WHERE source_id = ?
    `),
    distinctTypes: db.prepare(`
      SELECT DISTINCT type FROM tracks ORDER BY type
    `),
    getTypeColor: db.prepare("SELECT color FROM type_colors WHERE type = ?"),
    listTypeColors: db.prepare("SELECT type, color FROM type_colors"),
    upsertTypeColor: db.prepare(`
      INSERT INTO type_colors (type, color) VALUES (?, ?)
      ON CONFLICT(type) DO UPDATE SET color = excluded.color
    `),
    overallBounds: db.prepare(`
      SELECT MIN(min_lat) AS min_lat, MIN(min_lon) AS min_lon,
             MAX(max_lat) AS max_lat, MAX(max_lon) AS max_lon
      FROM sources
      WHERE visible = 1 AND min_lat IS NOT NULL
    `),
  };

  function txn(fn) {
    return db.transaction(fn);
  }

  function listSources() {
    return stmts.listSources.all().map(r => ({
      ...r,
      visible: !!r.visible,
      bounds: (r.min_lat == null) ? null : [r.min_lat, r.min_lon, r.max_lat, r.max_lon],
    }));
  }

  function setSourceVisible(id, visible) {
    stmts.setSourceVisible.run(visible ? 1 : 0, id);
  }

  function removeSource(id) {
    // Cascade handles tracks/segments/points/waypoints. R-tree rows have to go
    // manually since they're virtual tables without FK support.
    const trackIds = db.prepare("SELECT id FROM tracks WHERE source_id = ?").all(id);
    const waypointIds = db.prepare("SELECT id FROM waypoints WHERE source_id = ?").all(id);
    const rmTrackRt = db.prepare("DELETE FROM tracks_rtree WHERE id = ?");
    const rmWptRt = db.prepare("DELETE FROM waypoints_rtree WHERE id = ?");
    const tx = db.transaction(() => {
      for (const t of trackIds) rmTrackRt.run(t.id);
      for (const w of waypointIds) rmWptRt.run(w.id);
      stmts.deleteSource.run(id);
    });
    tx();
  }

  function listTypes() {
    return stmts.distinctTypes.all().map(r => r.type);
  }

  function listTypeColors() {
    const out = {};
    for (const r of stmts.listTypeColors.all()) out[r.type] = r.color;
    return out;
  }

  function setTypeColor(type, color) {
    stmts.upsertTypeColor.run(type, color);
  }

  function overallBounds() {
    const r = stmts.overallBounds.get();
    if (!r || r.min_lat == null) return null;
    return [r.min_lat, r.min_lon, r.max_lat, r.max_lon];
  }

  // ----- Visible-track query with bbox + filters + per-segment decimation -----

  const trackQueryCache = new Map();

  function queryTracks(opts) {
    const {
      bbox,              // [minLat, minLon, maxLat, maxLon]
      sourceIds,         // number[]
      types,             // string[]   (track.type must be in this list)
      maxPointsPerSegment = 4000,
      maxTracks = 5000,
    } = opts;

    if (!sourceIds?.length || !types?.length) return [];

    // R-tree query for tracks intersecting bbox, filtered by source + type.
    const srcList = sourceIds.map(() => "?").join(",");
    const typeList = types.map(() => "?").join(",");
    const sql = `
      SELECT t.id, t.source_id, t.type, t.name,
             t.min_lat, t.min_lon, t.max_lat, t.max_lon, t.point_count
      FROM tracks_rtree r
      JOIN tracks t ON t.id = r.id
      WHERE r.max_lat >= ? AND r.min_lat <= ?
        AND r.max_lon >= ? AND r.min_lon <= ?
        AND t.source_id IN (${srcList})
        AND t.type IN (${typeList})
      ORDER BY t.id
      LIMIT ?
    `;
    let stmt = trackQueryCache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); trackQueryCache.set(sql, stmt); }

    const rows = stmt.all(
      bbox[0], bbox[2], bbox[1], bbox[3],
      ...sourceIds, ...types,
      maxTracks
    );

    const segStmt = db.prepare(
      "SELECT id, point_count FROM segments WHERE track_id = ? ORDER BY seq"
    );
    const ptsAll = db.prepare(
      "SELECT lat, lon FROM points WHERE segment_id = ? ORDER BY seq"
    );
    const ptsStride = db.prepare(
      "SELECT lat, lon FROM points WHERE segment_id = ? AND (seq % ?) = 0 ORDER BY seq"
    );

    const out = [];
    for (const t of rows) {
      const segments = [];
      for (const s of segStmt.all(t.id)) {
        if (s.point_count === 0) continue;
        let pts;
        if (s.point_count <= maxPointsPerSegment) {
          pts = ptsAll.all(s.id);
        } else {
          const stride = Math.max(1, Math.ceil(s.point_count / maxPointsPerSegment));
          pts = ptsStride.all(s.id, stride);
        }
        if (pts.length) segments.push(pts);
      }
      if (!segments.length) continue;
      out.push({
        sourceId: t.source_id,
        trackId: t.id,
        type: t.type,
        name: t.name,
        bounds: [t.min_lat, t.min_lon, t.max_lat, t.max_lon],
        segments,
      });
    }
    return out;
  }

  function queryWaypoints(opts) {
    const { bbox, sourceIds } = opts;
    if (!sourceIds?.length) return [];
    const srcList = sourceIds.map(() => "?").join(",");
    const sql = `
      SELECT w.id, w.source_id, w.name, w.lat, w.lon, w.time
      FROM waypoints_rtree r
      JOIN waypoints w ON w.id = r.id
      WHERE r.max_lat >= ? AND r.min_lat <= ?
        AND r.max_lon >= ? AND r.min_lon <= ?
        AND w.source_id IN (${srcList})
      LIMIT 50000
    `;
    return db.prepare(sql).all(
      bbox[0], bbox[2], bbox[1], bbox[3],
      ...sourceIds
    );
  }

  // ----- Iteration for export (no in-memory accumulation of all points) -----

  function* iterateSourceForExport(sourceId) {
    const src = db.prepare(`
      SELECT id, filename, creator FROM sources WHERE id = ?
    `).get(sourceId);
    if (!src) return;
    yield { kind: "source", source: src };

    const waypoints = db.prepare(`
      SELECT name, lat, lon, ele, time FROM waypoints
      WHERE source_id = ? ORDER BY id
    `).iterate(sourceId);
    for (const w of waypoints) yield { kind: "waypoint", waypoint: w };

    const tracks = db.prepare(`
      SELECT id, name, type, raw_type FROM tracks
      WHERE source_id = ? ORDER BY seq, id
    `).all(sourceId);
    for (const t of tracks) {
      yield { kind: "track-open", track: t };
      const segs = db.prepare(`
        SELECT id FROM segments WHERE track_id = ? ORDER BY seq
      `).all(t.id);
      for (const s of segs) {
        yield { kind: "segment-open" };
        const pts = db.prepare(`
          SELECT lat, lon, ele, time FROM points
          WHERE segment_id = ? ORDER BY seq
        `).iterate(s.id);
        for (const p of pts) yield { kind: "point", point: p };
        yield { kind: "segment-close" };
      }
      yield { kind: "track-close" };
    }
  }

  function listSourceIdsForExport() {
    return db.prepare("SELECT id FROM sources ORDER BY id").all().map(r => r.id);
  }

  return {
    raw: db,
    file,
    stmts,
    txn,
    listSources,
    setSourceVisible,
    removeSource,
    listTypes,
    listTypeColors,
    setTypeColor,
    overallBounds,
    queryTracks,
    queryWaypoints,
    iterateSourceForExport,
    listSourceIdsForExport,
    close: () => db.close(),
  };
}

module.exports = { openDatabase };
