# ARC GPX Visualizer

Desktop app for inspecting GPX files exported from
[ARC Editor 4](https://apps.apple.com/app/arc/id1063151918). Imports any number
of `.gpx` files into a local SQLite library, renders them on a dark Leaflet map
with bbox + zoom-aware decimation, and lets you toggle visibility by activity
type and by source file.

Built on Electron with a `better-sqlite3` backend. The full library (tracks,
segments, points, waypoints) lives in a single SQLite file under the OS user-data
directory; nothing leaves your machine.

The repo contains no real personal location data. `samples/sample-arc-week.gpx`
is a synthetic file that mirrors the ARC schema with fictional mid-Atlantic
coordinates.

## Run on macOS

You need Node.js 18+ and Xcode Command Line Tools (for compiling the
`better-sqlite3` native module).

```sh
# 1. Clone
git clone https://github.com/hutima/arc_app_visualizer.git
cd arc_app_visualizer

# 2. Install deps. This also rebuilds better-sqlite3 against Electron's Node ABI
#    via the postinstall hook.
npm install

# 3. Launch
npm start
```

The app opens. Click **Add GPX files...**, multi-select your `.gpx` exports,
and they stream into the SQLite library. The library persists across launches.

To package a signed `.dmg` for installation:

```sh
npm run build:mac          # universal (arm64 + x64)
npm run build:mac-arm      # Apple Silicon only, faster
```

Output lands in `dist/`. Drag the `.dmg` to Applications.

### Where is the library stored?

`~/Library/Application Support/ARC GPX Visualizer/library.sqlite`

Delete that file to wipe the library. WAL/journal files (`*.sqlite-wal`,
`*.sqlite-shm`) live alongside.

## Features

- **Streaming GPX import**: a SAX-based parser writes points into SQLite in
  batched transactions. Loading 150 files / 500 MB of GPX is bounded by disk
  speed, not RAM.
- **R-tree spatial index** on per-track and per-waypoint bounding boxes.
  Map queries only fetch tracks that intersect the current viewport.
- **Per-segment decimation** at query time. Setting `max pts/seg` controls
  the upper bound returned to the renderer; segments larger than that are
  strided in SQL.
- **Persistent type colors**, visibility toggles, and source list, all backed
  by SQLite.
- **GPX export** in two modes: merged (one file with every track preserved as a
  separate `<trk>`) or per-file round-trip (one re-serialized GPX per source).
  Both are streaming - they never load a full file into memory.

## Architecture

```
package.json                  Electron entry, build config
electron/
  main.js                     Main process: window, IPC handlers
  preload.js                  contextBridge -> window.api
  db.js                       SQLite schema + queries (better-sqlite3)
  gpx-import.js               Streaming SAX parser -> batched inserts
  gpx-export.js               Streaming serializer (DB -> .gpx file)
index.html                    Renderer shell + Leaflet CDN
styles/app.css                Dark UI theme
icons/                        App icons
samples/                      Synthetic GPX example
src/
  main.js                     Renderer bootstrap - wires modules
  core/
    event-bus.js              Pub/sub primitive
  model/
    store.js                  Renderer-side cache of source summaries;
                              mutations go through window.api
  io/
    file-import.js            IPC shim for importing GPX paths
    file-export.js            IPC shim for writing GPX files
  map/
    map-view.js               Leaflet wrapper
    layer-manager.js          Viewport-driven queries; rebuilds polylines
                              on moveend / zoomend
    palette.js                Default colors + deterministic hash for
                              unknown activity types
  ui/
    source-list.js            Per-source rows with visibility + remove
    type-filters.js           Dynamic type toggles + persistent color pickers
    status-bar.js             Aggregate counts + last status message
```

### Data flow

```
[Mac filesystem] --> electron/gpx-import.js (SAX, streaming)
                       |
                       v
                  SQLite (library.sqlite + R-tree indices)
                       |
                       v
                  electron/db.js queries (bbox-narrowed)
                       |
                       v IPC
                       v
              src/map/layer-manager.js (Leaflet polylines, rebuilt per viewport)
```

The renderer never holds the full library in memory - only the lightweight
source summaries (counts + bounds) and the small subset of points currently
on screen.

## Schema

- `sources` - one row per imported file (filename, creator, counts, bounds, visible flag)
- `tracks` - per-track metadata, type, time range, bbox, point count
- `tracks_rtree` - virtual R-tree on track bbox
- `segments` - per-track segments with point count
- `points` - lat, lon, ele, time, indexed by `(segment_id, seq)`
- `waypoints` + `waypoints_rtree` - waypoint positions and spatial index
- `type_colors` - persisted color overrides per activity type

## Smoke test

```sh
node scripts/smoke.js
```

Imports the synthetic sample into a temp DB, runs every query path, and
writes round-trip GPX files. Useful for verifying the native module built
correctly after `npm install`.

## Notes on the sample file

`samples/sample-arc-week.gpx` is synthetic: ~10 waypoints, 15 tracks across a
fictional 3-day span centered on `(10.0, -30.0)` (mid-Atlantic). It exercises
walking, running, car, taxi, bus, train, tram, metro, stationary, airplane,
and kayaking - enough to drive the type-filter UI and palette logic.

## Removed in this fork

- **PWA mode**: this fork is desktop-only. The service worker, manifest, and
  in-browser file picker are gone.
- **Canonical-path editing**: the bulk-edit module from the previous version
  operated on full in-memory `Source` objects, which we no longer keep. It's
  preserved in git history (PR #4) and can be re-integrated against the
  SQLite-backed model when needed.

## Legacy

The two single-file HTML prototypes that preceded the PWA are kept under
`legacy/` for reference. They still work standalone in a browser but are not
the intended entry point.
