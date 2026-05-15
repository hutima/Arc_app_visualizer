-- ARC GPX Visualizer - desktop schema.
--
-- Design notes:
-- * Sources, tracks, waypoints are normalized into rows.
-- * Track point lists are stored as packed binary blobs on the `segments`
--   row to keep the DB compact (4 bytes per coord vs ~40 per row). Blob
--   format is described in codec.js: coords = Float64Array of interleaved
--   (lat, lon) pairs; times = optional Int64 epoch ms; eles = optional
--   Float64 elevations.
-- * Pre-computed per-track bbox / first / last endpoints power the
--   matcher without decoding blobs.
-- * R*Tree virtual table indexes track bboxes for viewport queries.
-- * Anchor pairs and canonical paths are persisted; edit ops are not
--   (first cut). Re-applying via the UI is fast since matching is cheap.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL UNIQUE,
  imported_at INTEGER NOT NULL,
  creator     TEXT,
  root_attrs  TEXT,                       -- JSON of <gpx> attributes
  extras_xml  TEXT                        -- serialized preserved <gpx> children
);

CREATE TABLE IF NOT EXISTS tracks (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  name          TEXT,
  type          TEXT NOT NULL DEFAULT '',
  raw_type      TEXT,
  point_count   INTEGER NOT NULL DEFAULT 0,
  bbox_min_lat  REAL, bbox_min_lon REAL,
  bbox_max_lat  REAL, bbox_max_lon REAL,
  first_lat     REAL, first_lon REAL, first_time TEXT,
  last_lat      REAL, last_lon REAL, last_time TEXT,
  extras_xml    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks(source_id);
CREATE INDEX IF NOT EXISTS idx_tracks_type   ON tracks(type);
CREATE INDEX IF NOT EXISTS idx_tracks_first_time ON tracks(first_time);

-- R*Tree spatial index on track bboxes. rowid here mirrors tracks.rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_rtree USING rtree(
  rowid,
  min_lat, max_lat,
  min_lon, max_lon
);

CREATE TABLE IF NOT EXISTS segments (
  id           TEXT PRIMARY KEY,
  track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  point_count  INTEGER NOT NULL DEFAULT 0,
  coords       BLOB,                       -- Float64Array, interleaved lat,lon,lat,lon...
  times        BLOB,                       -- Int64 epoch ms per point or NULL
  eles         BLOB,                       -- Float64 ele per point or NULL
  has_times    INTEGER NOT NULL DEFAULT 0,
  has_eles     INTEGER NOT NULL DEFAULT 0,
  extras_xml   TEXT
);
CREATE INDEX IF NOT EXISTS idx_segments_track ON segments(track_id, ordinal);

CREATE TABLE IF NOT EXISTS waypoints (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  name       TEXT,
  time       TEXT,
  extras_xml TEXT
);
CREATE INDEX IF NOT EXISTS idx_waypoints_source ON waypoints(source_id);

-- ----- Editing state (persisted across sessions). -----

CREATE TABLE IF NOT EXISTS anchor_pairs (
  id              TEXT PRIMARY KEY,
  label           TEXT,
  start_lat       REAL, start_lon REAL, start_radius_m INTEGER, start_label TEXT,
  end_lat         REAL, end_lon REAL,   end_radius_m   INTEGER, end_label   TEXT,
  bidirectional   INTEGER NOT NULL DEFAULT 1,
  chain_fragments INTEGER NOT NULL DEFAULT 0,
  chain_gap_sec   INTEGER NOT NULL DEFAULT 180,
  filters         TEXT,                     -- JSON
  canonical_path_id TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_paths (
  id                 TEXT PRIMARY KEY,
  anchor_pair_id     TEXT NOT NULL UNIQUE REFERENCES anchor_pairs(id) ON DELETE CASCADE,
  vertices           TEXT NOT NULL,        -- JSON [[lat, lon], ...]
  origin             TEXT NOT NULL,
  exemplar_source_id TEXT,
  exemplar_track_id  TEXT,
  pre_snap_vertices  TEXT,                 -- JSON or NULL
  updated_at         INTEGER NOT NULL
);
