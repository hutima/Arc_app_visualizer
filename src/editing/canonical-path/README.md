# Canonical-path module (future)

This folder is the extension point for the bulk-edit feature described in the
project brief: identify repeated trips between two geographic regions and
collapse them onto a canonical path.

## Inputs

- `store.listSources()` (read-only)
- Computed `Trip` view: for each track, `{trackId, sourceId, type, start, end, bbox}`
  where `start` and `end` are the first and last `Point` of the first and last
  non-empty segment.
- User-supplied: `start = {lat, lon, radiusMeters}` and `end = {lat, lon, radiusMeters}`.

## Algorithm (sketch)

1. Compute `Trip` for every track once; cache per `sourceId`.
2. Filter trips whose `start.point` lies within `start.radiusMeters` of `start.center`
   and whose `end.point` lies within `end.radiusMeters` of `end.center`. Use a
   haversine helper; no projection needed.
3. Group matches and offer a canonical-path candidate, e.g. the medoid trip
   (the trip whose points have the smallest total distance to the others),
   or a user-supplied path.
4. Apply edits as `{type:"replaceTrackPoints", trackId, points}` operations.
   Edits live in the store; the layer-manager re-renders on `filters:changed`.

## What's already in place

- `Source`/`Track`/`Segment`/`Point` shape preserves original timestamps and
  metadata, so canonical-path application can keep per-point time if desired.
- The serializer respects `rawType` and preserves any `extras` nodes, so any
  ARC extension elements present at import time survive the round trip.

## What still needs to be added when implementing

- A `geo.js` helper (haversine, point-in-circle).
- An `editor-state.js` that records and reverts edit operations.
- UI: two map pickers + radius sliders, "preview matches" overlay, apply button.
- Per-source export with edits applied (already trivial via `serializeSource`).
