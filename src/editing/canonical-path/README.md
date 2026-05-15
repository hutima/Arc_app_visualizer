# Canonical-path module

Implements the bulk-edit feature described in `docs/canonical-path-plan.md`:
identify repeated trips between two geographic regions and rewrite them onto
a user-defined canonical path.

## Pieces

| File                       | Purpose                                                      |
|----------------------------|--------------------------------------------------------------|
| `geo.js`                   | haversine + polyline helpers (length, bbox, cumulative)      |
| `trip-view.js`             | Trip-shaped views with underground-robust endpoint pick      |
| `chaining.js`              | adjacent-track chaining for ARC's fragmented subway trips    |
| `matcher.js`               | apply an `AnchorPair` to all sources -> `MatchCandidate[]`   |
| `edit-ops.js`              | `applyOps`, `snapshotTrack`, fingerprinting for undo         |
| `canonical-path.js`        | constructors and small utilities for `CanonicalPath`         |
| `apply.js`                 | `(canonical, match) -> EditOp[]` with time interpolation     |
| `road-snap.js`             | optional OSRM map-matching to snap a user-drawn path to OSM  |
| `editing-state.js`         | state container: pairs, canonicals, op stack, effective src  |
| `ui/map-picker.js`         | next-click point / track pickers                             |
| `ui/canonical-overlay.js`  | anchor circles, match highlights, canonical preview          |
| `ui/path-drawer.js`        | click-to-add-vertex with undo / snap / commit                |
| `ui/canonical-card.js`     | sidebar card; ties everything together                       |

Decisions are documented and rationalised in `docs/canonical-path-plan.md`
section 6. The map-picker, drawer, overlay, and card are wired together in
`src/main.js`.

## OSM road snap

`road-snap.js` calls the public OSRM map-matching endpoint
(`router.project-osrm.org`). On success the user-drawn vertex list is
replaced with the snapped geometry; on any failure (rate limit, network,
no match, AbortError) the canonical keeps the user-drawn polyline and a
status message explains why. The endpoint is meant for development - point
`opts.baseUrl` at a private OSRM instance for heavy use. Subway / metro /
train / boat / airplane canonicals shouldn't be snapped (no road
underneath); the UI gates the button on user discretion.
