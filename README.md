# ARC GPX Visualizer

A Progressive Web App for inspecting and editing GPX files exported from
[ARC Editor 4](https://apps.apple.com/app/arc/id1063151918). Loads any number
of weekly `.gpx` exports at once, renders them on a dark Leaflet map, and lets
you toggle visibility by activity type and by source file.

The repo contains no real personal location data. `samples/sample-arc-week.gpx`
is a synthetic file that mirrors the ARC schema with fictional mid-Atlantic
coordinates.

## Run

This is a static site - no build step. From the repo root:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

You need to serve over HTTP (not `file://`) for ES modules and the service
worker to register.

## Features

- Import any number of `.gpx` files at once. They merge into a shared model
  while preserving file-level provenance: every track and waypoint knows
  which source it came from.
- Per-source visibility toggles and remove buttons.
- Activity-type toggles, generated dynamically from whatever types appear in
  the loaded files - no hard-coded list. Per-type color overrides.
- Display options: line width, opacity, max points per segment
  (downsampling), and "omit single-point segments" for noisy ARC
  `stationary` tracks.
- Waypoint markers with popups showing name, time, and source filename.
- Export merged or per-file round-tripped GPX. The serializer preserves
  unknown child elements verbatim, so any future ARC extensions survive
  the round trip.
- Installable as a PWA; service worker caches the app shell for offline use.
  Map tiles are not cached by default.

## Architecture

```
index.html                   shell + Leaflet CDN
manifest.webmanifest         PWA manifest
sw.js                        app-shell service worker
styles/app.css               dark UI theme
icons/                       PWA icons
samples/                     synthetic GPX example
legacy/                      retired single-file prototypes
src/
  main.js                    bootstrap - wires modules through the store bus
  core/
    event-bus.js             pub/sub primitive used by the store
    id.js                    session-local id generation
  model/
    types.js                 JSDoc shapes - Source, Track, Segment, Point, Waypoint, Trip
    store.js                 single source of truth: sources, visibility, stats
  parser/
    gpx-parser.js            GPX DOM -> Source. Preserves unknown nodes in `extras`.
  serializer/
    gpx-serializer.js        Source -> GPX 1.1. Round-trip-safe.
  io/
    file-import.js           batch File -> Source[] with per-file error reporting
    file-export.js           triggers browser downloads
  map/
    map-view.js              Leaflet wrapper
    layer-manager.js         per-(source, type) layer groups; downsampling; dots
    palette.js               base palette + deterministic hash for unknown types
  filtering/
    visibility.js            derives {visibleSources} x {visibleTypes}
  ui/
    source-list.js           per-source rows with visibility + remove
    type-filters.js          dynamic type toggles + color pickers
    status-bar.js            aggregate counts + last status message
  editing/
    canonical-path/          extension point for the future bulk-edit feature
  pwa/
    register-sw.js
```

The boundaries: parsing knows about GPX XML and nothing else; the store knows
about the data model and emits events; the map module knows about Leaflet and
internal types but not about the store directly (it gets shaped data); the UI
modules subscribe to store events and call store mutators. `main.js` is the
only place that imports from every layer.

## Extensibility - canonical trip module

A future module will detect repeated trips between two geographic areas and
collapse them to a canonical path. The data model already supports this:

- Every `Track` carries `sourceId`, so bulk edits can be applied across all
  loaded files without losing provenance.
- The serializer re-emits each Track as a separate `<trk>` (never flattening)
  and preserves any `extras` child nodes verbatim.
- `Track.id` is stable for the session, so an "edit operation" model
  (`{type:"replaceTrackPoints", trackId, points}`) can record changes
  independently of the renderer.
- Trip-level summaries can be computed lazily from a Track's first and last
  segment endpoints.

See `src/editing/canonical-path/README.md` for the implementation sketch.

## Notes on the sample file

`samples/sample-arc-week.gpx` is synthetic: ~10 waypoints, 15 tracks across a
fictional 3-day span centered on `(10.0, -30.0)` (mid-Atlantic). It exercises
walking, running, car, taxi, bus, train, tram, metro, stationary, airplane,
and kayaking - enough to drive the type-filter UI and palette logic.

## Legacy

The two single-file HTML prototypes that preceded this PWA are kept under
`legacy/` for reference. They still work standalone but are no longer the
intended entry point.
