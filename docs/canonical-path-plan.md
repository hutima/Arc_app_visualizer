# Canonical-path module - planning artifact

Status: planning only. No code under `src/` is changed in this pass.

This document is the design plan for the bulk-editing / canonical-trip module
sketched in `src/editing/canonical-path/README.md` and the project README's
"Extensibility - canonical trip module" section. It addresses anchor-pair
definition, robust trip matching across loaded GPX files, canonical-path
authoring, lazy edit application, undoable edit operations, and per-source
export with edits baked in.

The motivating use case is subway commutes where ARC emits noisy / fragmented
/ mis-classified tracks because GPS drops underground, but the same machinery
generalises to any repeated commute (car between home and work, bike to gym,
etc.).

---

## 1. Module decomposition

All new code lives under `src/editing/canonical-path/` unless noted. One-line
purpose, public surface, dependencies.

### Core (no DOM, no Leaflet)

#### `geo.js`
- Purpose: haversine + a handful of polyline helpers. No projections, no turf.
- Surface:
  - `distMeters(a, b)` - haversine between `{lat,lon}` points.
  - `inCircle(point, center, radiusMeters)` - boolean.
  - `polylineLengthMeters(vertices)` - cumulative length helper.
  - `cumulativeDistances(vertices)` - returns `number[]` of cumulative meters.
  - `pointAtDistance(vertices, cum, meters)` - linear interpolation along a
    polyline by along-path distance.
  - `bboxOf(points)` - `[minLat,minLon,maxLat,maxLon]`.
  - `bboxIntersectsCircle(bbox, center, radius)` - cheap prefilter.
- Deps: none.

#### `trip-view.js`
- Purpose: derive a `Trip` view from a `Track`, with the underground-robust
  endpoint extraction described in section 3.
- Surface:
  - `tripOf(track, opts?)` -> `Trip` (uses first/last non-empty point by
    default; with `opts.anchor` does robust-endpoint extraction).
  - `tripsOfSource(source, opts?)` -> `Trip[]`.
- Deps: `geo.js`, `../../model/types.js` JSDoc.

#### `chaining.js`
- Purpose: heuristic that synthesises virtual chained trips by stitching
  adjacent tracks within a small temporal window. Pure function; never
  mutates the store. The matcher consumes its output.
- Surface:
  - `chainTracks(tracks, { maxGapSec, sameSourceOnly })` -> `Chain[]` where
    each `Chain = { trackIds:string[], sourceId, start:Point, end:Point }`.
- Deps: `geo.js`, `trip-view.js`.

#### `matcher.js`
- Purpose: given an `AnchorPair` and the loaded sources, return
  `MatchCandidate[]`. Includes forward and reverse matching and the optional
  type/weekday/hour filters.
- Surface:
  - `findMatches(sources, anchorPair, opts)` -> `MatchCandidate[]`.
- Deps: `geo.js`, `trip-view.js`, `chaining.js`.

#### `edit-ops.js`
- Purpose: the edit-operation model. Define ops, apply ops to produce an
  effective source / track, and produce inverse ops for undo.
- Surface:
  - `applyOps(source, ops)` -> a shallow-cloned `Source` with edited tracks.
  - `applyOpsToTrack(track, ops)` -> a shallow-cloned `Track`.
  - `inverseOp(op, beforeSource)` -> `EditOp` (records what was overwritten
    so undo can fully restore).
  - `fingerprintTrack(track)` -> `{firstPoint, lastPoint, ptCount, sha}` -
    used so an op can detect drift if the underlying source changed.
- Deps: `../../model/types.js`, none runtime.

#### `canonical-path.js`
- Purpose: data accessors and validators for a `CanonicalPath`. Builds a
  canonical path from a chosen exemplar track or from user-drawn vertices.
- Surface:
  - `fromVertices(vertices)` -> `CanonicalPath`.
  - `fromExemplarTrack(track)` -> `CanonicalPath` (flattens segments to a
    single ordered vertex list).
  - `fromGeoJsonLineString(json)` -> `CanonicalPath` (stretch; reuse later).
  - `densify(canonical, maxStepMeters)` -> `CanonicalPath` (optional, for
    smoother time interpolation in long segments).
- Deps: `geo.js`.

#### `apply.js`
- Purpose: given a canonical path and a match candidate, produce the
  `EditOp(s)` that turn the matched track(s) into the canonical version.
  This is where the "preserve endpoints" and "single vs sibling track"
  strategies live.
- Surface:
  - `planApply(canonical, match, { strategy })` -> `EditOp[]`.
    - `strategy.preserveOriginalEndpoints: boolean`
    - `strategy.replacementMode: "overwrite" | "sibling"`
    - `strategy.collapseChain: "single-canonical" | "keep-others-empty"`
- Deps: `geo.js`, `edit-ops.js`, `trip-view.js`.

### Store extension (lives next to existing store)

#### `editing-state.js`
- Purpose: holds anchor pairs, canonical paths, and the edit op stack.
  Wraps an existing store instance and emits new events on the same bus.
- Surface (mounted by `main.js`):
  ```js
  const editing = createEditingState(store);

  editing.addAnchorPair(pair) / updateAnchorPair / removeAnchorPair
  editing.listAnchorPairs() -> AnchorPair[]
  editing.setAnchorPairEnabled(id, bool)

  editing.setCanonicalPath(anchorPairId, canonical)
  editing.getCanonicalPath(anchorPairId)

  editing.applyEdits(ops)              // pushes onto stack, emits edits:changed
  editing.undoLast()                   // pops one logical apply (may be N ops)
  editing.listOps({ sourceId? })
  editing.opsForSource(sourceId)

  editing.effectiveSource(sourceId)    // applyOps(source, ops)
  editing.effectiveTracks(sourceId)    // for layer-manager
  ```
- New bus events (added to `store.EVT`):
  - `anchors:changed` (payload: `{ pairId, kind: "added"|"updated"|"removed" }`)
  - `canonical:changed` (payload: `{ pairId }`)
  - `edits:changed` (payload: `{ sourceIds: string[] }`)
- Deps: `../../core/event-bus.js`, `edit-ops.js`.

Why a separate file instead of folding into `model/store.js`: keeps
`model/store.js` focused on the import-time data model, keeps the editing
state opt-in (the app still works without it), and lets the editing module
own its own typedefs.

### UI

#### `ui/canonical-card.js`
- Purpose: the sidebar card that lists anchor pairs and hosts the
  create/edit flow. Subscribes to `anchors:changed`, `canonical:changed`,
  `edits:changed`.
- Surface: `createCanonicalCard(rootEl, store, editing, mapPicker)`.
- Deps: `editing-state.js`, `ui/map-picker.js`.

#### `ui/map-picker.js`
- Purpose: small controller that puts the map into "pick a point" mode and
  resolves with `{lat,lon}` on the next click. Used for anchor centers and
  for the exemplar picker.
- Surface: `createMapPicker(mapView)` -> `pickPoint()`, `pickTrack(matches)`.
- Deps: Leaflet via `mapView`.

#### `ui/canonical-overlay.js`
- Purpose: ephemeral map overlay - draws the two anchor circles, highlights
  matched candidate tracks, draws the canonical-path polyline while it is
  being authored, and renders the "preview" of applied results without
  committing edits to the store.
- Surface:
  - `createCanonicalOverlay(mapView)` returns
    `{ showAnchors, showMatches, showCanonical, showPreview, clear }`.
- Deps: Leaflet via `mapView`.

#### `ui/path-drawer.js`
- Purpose: the click-to-add-vertex drawing tool with undo and optional
  snap-to-existing-track. Emits the in-progress vertex list to the overlay
  so the user sees the line grow.
- Surface: `startDraw({ onCommit, snapTracks })`, `cancel()`.
- Deps: Leaflet via `mapView`, `geo.js` (for snap distance).

### Touch points in existing modules

These are not new files; section 5 lists the exact changes.

- `src/main.js` - wire the editing state, mount the UI card, route
  `edits:changed` to `layers.refreshSource(sourceId)`, and switch the
  exporters to use `editing.effectiveSource(id)`.
- `src/map/layer-manager.js` - add `refreshSource(source)` (remove + re-add
  using the same internal code path) so it can re-render after an edit.
- `src/model/types.js` - add JSDoc typedefs for `AnchorPair`, `Anchor`,
  `CanonicalPath`, `EditOp`, `MatchCandidate` (and re-export `Trip` is
  already there).
- `index.html` - one new `<div class="card">` block for the canonical-path
  UI, plus a hidden draw-mode hint banner.

Nothing under `parser/`, `serializer/`, `filtering/`, `io/` needs to change.

---

## 2. Data shapes

JSDoc typedefs to add to `src/model/types.js`. They reuse the existing
`Point` shape verbatim.

```js
/**
 * @typedef {Object} Anchor
 * @property {number} lat
 * @property {number} lon
 * @property {number} radiusMeters   user-set, 10..2000 typical
 * @property {string} [label]        e.g. "Home station"
 */

/**
 * @typedef {Object} TripFilters
 * @property {string[]} [includeTypes]   ["metro","train"] - match if track.type is in set
 * @property {number[]} [weekdays]       0..6 (Sun..Sat); empty/undefined = any
 * @property {[number,number]} [hourRange]  [startHour, endHourExclusive] in local time
 */

/**
 * @typedef {Object} AnchorPair
 * @property {string} id                   "ap_<n>"
 * @property {string} [label]              "Home <-> Work"
 * @property {Anchor} start
 * @property {Anchor} end
 * @property {boolean} bidirectional       accept end-to-start trips
 * @property {boolean} chainFragments      run chaining.js before matching
 * @property {number} [chainGapSec]        default 180
 * @property {TripFilters} [filters]
 * @property {string} [canonicalPathId]
 * @property {boolean} enabled
 * @property {number} createdAt
 */

/**
 * @typedef {Object} CanonicalPath
 * @property {string} id                   "cp_<n>"
 * @property {string} anchorPairId         1:1 with the owning AnchorPair
 * @property {[number,number][]} vertices  ordered (lat, lon) list
 * @property {"drawn"|"exemplar"|"imported"} origin
 * @property {string} [exemplarSourceId]   only if origin === "exemplar"
 * @property {string} [exemplarTrackId]
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} MatchCandidate
 * @property {string} sourceId
 * @property {string[]} trackIds           1 element for a normal match, N for a chain
 * @property {Point} robustStart           see section 3
 * @property {Point} robustEnd
 * @property {"forward"|"reverse"} direction
 * @property {boolean} chained
 * @property {number} startDistMeters      distance robustStart -> anchor.start.center
 * @property {number} endDistMeters
 * @property {string} [reason]             debug breadcrumb shown in the match list
 */

/**
 * @typedef {Object} TrackSnapshot
 * Compact pre-edit snapshot used to make EditOps fully reversible.
 * @property {string} trackId
 * @property {string} [name]
 * @property {string} type
 * @property {string} [rawType]
 * @property {Segment[]} segments         deep enough to restore points + extras
 * @property {Element[]} [extras]
 */

/**
 * @typedef {Object} EditOp
 * Edit operations are stored on a single linear stack inside the editing
 * state. They are NEVER applied to the parsed Source - they are applied
 * lazily by editing.effectiveSource() at render/export time.
 *
 * @property {string} id                     "op_<n>"
 * @property {number} appliedAt              epoch ms
 * @property {string} groupId                groups ops produced by a single
 *                                           "apply" click so undo pops them together
 * @property {string} [anchorPairId]
 * @property {string} [canonicalPathId]
 * @property {"replaceTrackPoints"|"deleteTrack"|"insertTrack"} type
 *
 * // replaceTrackPoints
 * @property {string} [sourceId]
 * @property {string} [trackId]
 * @property {Segment[]} [newSegments]       what to substitute in
 * @property {TrackSnapshot} [snapshot]      what was there before (for undo)
 *
 * // deleteTrack
 * // uses sourceId + trackId + snapshot
 *
 * // insertTrack
 * @property {Track} [newTrack]              fully-formed track to insert
 * @property {number} [insertAfterIndex]     where in source.tracks to put it
 */
```

How they slot into the existing store:

- `store` keeps owning `Source[]` exactly as today; it never mutates a
  parsed track. Renderers must call `editing.effectiveSource(id)` if they
  want post-edit output. The default rendering path in `main.js` uses
  `editing.effectiveSource` for every source so the map always shows the
  edited state.
- Anchor pairs, canonical paths, and the op stack live in
  `editing-state.js` and emit their own events on the shared bus.
- The existing `EVT.filtersChanged` keeps doing exactly what it does
  today (visibility re-render); the new `edits:changed` event is a
  separate signal so visibility toggles don't cause edits to be
  re-applied.

---

## 3. Algorithms

### 3.1 Trip-endpoint extraction (underground-robust)

Naive version: first and last non-empty point of the track.

Robust version, only used when an anchor is in scope:

```
function robustEndpointForStart(track, anchor):
  // Walk forward through points; pick the first one inside the radius
  // that ALSO has a plausible time relative to its neighbours.
  let prevTime = null
  for each segment in track.segments:
    for each point p in segment.points:
      if p.time then t = parse(p.time) else t = null
      const inside = inCircle(p, anchor.center, anchor.radiusMeters)
      const timeConsistent =
        t == null || prevTime == null ||
        (t - prevTime) > 0 && (t - prevTime) < MAX_GAP_FOR_CONSISTENCY
      if inside and timeConsistent:
        return p
      prevTime = t ?? prevTime
  // Fallback: the literal first non-empty point.
  return firstNonEmpty(track)
```

The mirror function `robustEndpointForEnd` walks backwards. Constants:
`MAX_GAP_FOR_CONSISTENCY = 600s` (10 minutes) - tolerant of underground
silences but rejects "ARC inserted a stationary spike on the surface
hours later".

Rationale: the literal first trkpt of a subway track is sometimes a
hundred metres off-route because the GPS hadn't reacquired when the
train pulled out. We want the first trkpt that is in the start circle
AND not a temporal outlier.

Side benefit: `robustStart` and `robustEnd` are also what we feed into
the time interpolator (section 3.3), so the canonicalised track keeps
the real-world boarding/alighting timestamps.

### 3.2 Radius matching

```
function findMatches(sources, pair):
  out = []
  if pair.chainFragments:
    chains = chainTracks(allTracksAcrossSources(sources),
                         { maxGapSec: pair.chainGapSec ?? 180,
                           sameSourceOnly: true })
    units = chainsAsUnits(chains)
  else:
    units = tracksAsUnits(sources)
  for unit in units:
    if !passesFilters(unit, pair.filters): continue
    forward = tryMatch(unit, pair.start, pair.end)
    if forward: out.push({...forward, direction: "forward"})
    else if pair.bidirectional:
      reverse = tryMatch(unit, pair.end, pair.start)
      if reverse: out.push({...reverse, direction: "reverse"})
  return out.sort(byStartDistThenEndDist)

function tryMatch(unit, anchorA, anchorB):
  // Cheap reject by bbox-vs-circle before computing endpoints.
  if !bboxIntersectsCircle(unit.bbox, anchorA.center, anchorA.radius)
     && !bboxIntersectsCircle(unit.bbox, anchorB.center, anchorB.radius):
    return null
  const rs = robustEndpointForStart(unit, anchorA)
  const re = robustEndpointForEnd(unit, anchorB)
  if !inCircle(rs, anchorA.center, anchorA.radiusMeters): return null
  if !inCircle(re, anchorB.center, anchorB.radiusMeters): return null
  return { robustStart: rs, robustEnd: re,
           startDistMeters: distMeters(rs, anchorA.center),
           endDistMeters:   distMeters(re, anchorB.center) }
```

Optimisations:

- For each source, compute the union bbox once at import time. If the
  source bbox doesn't intersect either anchor's circle, skip the whole
  source. (Plenty for one week's worth of files; 50 sources = 50 cheap
  rejections.)
- Per-track bbox cached on first use.
- Spatial grid: skip. With N in the low thousands and matching being a
  user-triggered operation, bbox prefilter is enough. Document this in
  the file so future-us doesn't reach for turf.

### 3.3 Time interpolation along a polyline

Given the canonical path's vertex list `V[0..n-1]` and two endpoint
timestamps `t0` (from `robustStart`) and `t1` (from `robustEnd`):

```
function interpolateTimes(V, t0, t1):
  cum = cumulativeDistances(V)        // cum[0] = 0, cum[n-1] = total
  if cum[n-1] === 0:                  // degenerate (all vertices stacked)
    return V.map(v => ({...v, time: isoOf(t0)}))
  dt = t1 - t0
  return V.map((v, i) => ({
    lat: v[0], lon: v[1],
    time: isoOf(t0 + dt * (cum[i] / cum[n-1])),
  }))
```

This is invariant to non-uniform input timestamps - we only consume the
two endpoint times. Gaps and outliers in the original trkpts are
discarded by design. If we ever want a richer interpolation (e.g.
respect intermediate "known good" surface points), it slots in as an
alternate function selectable from the apply strategy.

Notes:
- Times are written back as ISO-8601 UTC strings so the serializer can
  emit them without further work.
- Elevation: by default leave `ele` unset on the canonical points;
  optionally average the elevation of the matched track if requested.
- If the canonical path was authored with `densify(maxStepMeters)`, the
  interpolated timestamps are roughly second-accurate even on long
  straight runs.

### 3.4 Adjacent-track chaining heuristic

Goal: address ARC fragmenting one subway trip into [walk, stationary,
metro, walk]. Pseudocode:

```
function chainTracks(tracks, { maxGapSec, sameSourceOnly }):
  // Sort by start time across all sources or per source.
  buckets = groupBy(tracks, t => sameSourceOnly ? t.sourceId : "_")
  out = []
  for each bucket in buckets:
    sorted = bucket.sort(by firstPointTime)
    if sorted.empty: continue
    cur = [ sorted[0] ]
    for t in sorted.slice(1):
      gap = firstPointTime(t) - lastPointTime(cur[last])
      if gap >= 0 && gap <= maxGapSec * 1000:
        cur.push(t)
      else:
        out.push(asChain(cur))
        cur = [t]
    out.push(asChain(cur))
  return out

function asChain(tracks):
  return {
    sourceId: tracks[0].sourceId,
    trackIds: tracks.map(t => t.id),
    start: firstNonEmpty(tracks[0]),
    end: lastNonEmpty(tracks[tracks.length-1]),
    bbox: bboxUnion(tracks.map(t => bboxOfTrack(t))),
    // Type heuristic: if any of the chained tracks has a transit-ish
    // type, prefer that as the chain's "effective type".
    effectiveType: pickDominantType(tracks),
  }
```

Tradeoff - module vs preprocessing step:

- Keeping chaining inside `matcher.js` (consumed only when
  `AnchorPair.chainFragments === true`) is non-destructive: the user
  can toggle it per pair, and the existing source list / per-type
  visibility behaviour is unchanged. The cost is a small extra pass on
  match time.
- Doing it as preprocessing (e.g. "Merge fragments" button that rewrites
  the loaded sources) would let the user see consolidated tracks in the
  source list and type filters too, but it crosses boundaries: it
  reaches into the model and mutates it for a reason that only the
  editing module cares about. It also makes per-source export less
  predictable (a merged track no longer corresponds to any one source).

Recommendation: do chaining inside the matcher only. If the user later
wants a "merge fragmented tracks" feature, it can be a separate edit-op
type expressed through the same op stack rather than a side mutation.

---

## 4. UI flow

The canonical-path UI is a single sidebar card and a small number of
overlay states on the map. The card collapses to a list when not
actively editing a pair.

### 4.1 Sidebar card (collapsed)

```
+----------------------------------------------+
| Canonical paths                              |
+----------------------------------------------+
| [x] Home <-> Work metro       3 matches   v |
|     trk_3, trk_8, trk_42 ...                 |
| [ ] Home <-> Gym bike         0 matches   v |
|                                              |
| [ + New anchor pair ]                        |
+----------------------------------------------+
```

- Checkbox toggles the anchor pair's `enabled` flag. Disabled pairs
  don't draw their anchors/overlay and don't auto-preview matches.
- "v" expands the pair to the edit panel below.
- The match count is computed lazily when the pair is enabled.

### 4.2 Sidebar card (editing a pair)

```
+----------------------------------------------+
| Canonical paths > Home <-> Work metro        |
+----------------------------------------------+
| Label: [Home <-> Work metro            ]     |
|                                              |
| Start anchor                                 |
|   [ pick on map ]   12.345, -56.789          |
|   radius [-----o------]  120 m               |
|   label  [ Home station                ]     |
|                                              |
| End anchor                                   |
|   [ pick on map ]   12.350, -56.790          |
|   radius [-----o------]  120 m               |
|   label  [ Work station                ]     |
|                                              |
| [x] Match reverse direction too              |
| [x] Chain fragmented tracks   gap [ 180 ] s  |
|                                              |
| Filters (optional)                           |
|   types  [metro x] [train x] + add           |
|   weekdays [M][T][W][T][F][ ][ ]             |
|   hours    [ 06 ]:00 - [ 22 ]:00             |
|                                              |
| Matches: 14 trips                            |
|   [ refresh ]   [ show on map ]              |
|     trk_3   2026-W18  Mon 08:14   forward    |
|     trk_8   2026-W18  Mon 18:02   reverse    |
|     ...                                      |
|                                              |
| Canonical path: (none)                       |
|   [ draw on map ]   [ use exemplar... ]      |
|                                              |
| [ preview apply ]   [ apply ]   [ undo last ]|
+----------------------------------------------+
```

The exact field widgets can be sliders or numeric inputs - whichever
matches the existing Display card's style.

### 4.3 Map interactions

- "pick on map": the cursor turns into a crosshair; the next single
  click sets the anchor center. Esc cancels.
- Anchor circle is drawn as a translucent disc plus a dashed border, in
  the pair's assigned colour (deterministic hash of pair id).
- "show on map" highlights matches: each candidate track turns thicker
  and brighter for the duration; the robust endpoints render as small
  filled dots; non-matching tracks dim. Toggling the button reverts.
- "draw on map": the cursor turns into a crosshair. Click adds a
  vertex. The growing polyline is rendered live. Hotkeys: `u` undo last
  vertex, `Enter` or double-click commit, `Esc` cancel. If snap is on,
  vertices snap to the nearest exemplar-track vertex within 8 px.
- "use exemplar...": cursor becomes a picker; the next click on any
  matched candidate's polyline adopts that candidate's geometry.
- "preview apply": renders the *result* of applying the canonical path
  to every match as a ghost overlay on top of the originals. The store
  is not mutated until "apply".

### 4.4 Step-by-step user flow

1. User clicks `+ New anchor pair`.
2. UI opens the edit panel; pair is created in the store with default
   radii and `enabled: true`.
3. User clicks "pick on map" next to Start anchor and clicks a point
   on the map. Anchor circle appears.
4. Adjusts radius via slider; the circle resizes in real time.
5. Repeats for End anchor.
6. UI runs `findMatches` and shows the count and the list.
7. User clicks "draw on map" and clicks 10-20 vertices along the
   actual subway line. `u` undoes a misplaced vertex, `s` toggles
   snap to candidate-track vertices. Presses Enter (or double-clicks
   the final vertex) to commit. Alternatively, clicks "use
   exemplar..." and picks a known-good matched trip. See section 4.6.
8. The canonical path is stored and rendered as a heavy line over the
   matched corridor.
9. User clicks "preview apply" - sees the would-be result.
10. User clicks "apply" - edits are pushed onto the op stack and the
    map re-renders with the edited tracks.
11. User clicks "undo last" if anything looks wrong.
12. User exports per-file - the GPX files contain the canonicalised
    tracks instead of the originals.

### 4.5 Multi-pair management

- Each pair lives in the sidebar list. Pairs are independent.
- Anchor circles and canonical paths of *enabled but unedited* pairs
  are drawn faintly on the map so the user can see their corpus of
  canonical commutes at a glance.
- The active pair (the one being edited) renders with full opacity.
- Disabled pairs render nothing on the map but stay in the list.

### 4.6 Canonical-path authoring (click-to-define)

The canonical path is what every matched trip is rewritten to follow,
so authoring needs to be precise and reversible. Three input modes,
all implemented in `ui/path-drawer.js` and rendered live by
`ui/canonical-overlay.js`:

#### Mode A - draw on map (primary)

Click-to-add-vertex with a growing polyline preview and per-vertex undo.

```
+------------------ Map ------------------+
|                                          |
|         o-----o-----o-----o ...          |  <- growing canonical path
|                            \             |     (in pair's colour, dashed
|                             o            |      until committed)
|                              \           |
|                  (anchor       o----+    |
|                   circles                |
|                   drawn at                |
|                   each end)               |
+------------------------------------------+
   [ click: add vertex   u: undo last
     enter / dbl-click: commit   esc: cancel
     s: toggle snap   space: pan ]
```

Behaviour:

- Entering draw mode disables map click-handlers for selection.
  Single-click *only* adds a vertex; double-click commits, mirroring
  the Leaflet `Draw` plugin convention (we are not actually using
  that plugin - it would be a heavy dependency for one tool).
- Drag still pans the map. Mouse wheel still zooms.
- The growing line is rendered as `L.polyline(latlngs, { dashArray })`
  in the anchor pair's colour. Vertices are small `L.circleMarker`s
  so the user can see where clicks landed.
- `u` (and `Cmd/Ctrl+Z`) removes the last vertex. The undo buffer is
  the in-progress vertex list itself - dropping the tail is enough.
- `s` toggles snap-to-existing-vertex while drawing. When on, the
  next click rounds to the nearest vertex of any candidate-match
  track within 8 px (see decision 11). The cursor shows a small ring
  when a snap target is in range. This is what makes "trace over the
  best surface-GPS recording" feasible.
- `Enter` or double-click commits the in-progress list into a new
  `CanonicalPath` with `origin: "drawn"`. Esc clears the buffer and
  exits draw mode without storing anything.
- A minimum of 2 vertices is required to commit; the UI greys out the
  commit affordance until that threshold is met.
- Vertex count is shown live in the sidebar ("12 vertices, 1.84 km")
  so the user knows whether they have enough detail.

Editing an existing canonical path is the same flow: clicking
`edit` on a stored canonical pre-loads the vertex list into the
drawer so the user can append, delete-tail, or restart.

#### Mode B - pick an exemplar trip

For commutes where one of the matched trips already has clean
above-ground GPS (e.g. a single sunny day where the train was on a
viaduct the whole way), the user can adopt that trip's geometry
verbatim:

1. Press "use exemplar..." in the canonical-path section.
2. Map enters pick mode; matched candidate polylines pulse.
3. User clicks any one of them.
4. `CanonicalPath` is built via `canonical-path.fromExemplarTrack(track)`
   with `origin: "exemplar"` and `exemplarSourceId/Trackid` recorded so
   the user can see later "this canonical came from `2026-W18.gpx /
   trk_3`".
5. The user can subsequently switch to draw mode to refine the
   exemplar's geometry; refining converts the origin to `"drawn"`.

#### Mode C - import GeoJSON LineString (stretch)

Drop a `.geojson` file containing a single LineString feature.
Coordinates are read as `[lon, lat]` per the GeoJSON spec, flipped to
`[lat, lon]` to match the rest of the model, and stored with
`origin: "imported"`. Implemented in step 6 (stretch) so users who
already have hand-curated routes from another tool can bring them in.

#### Storage and lifetime

- A `CanonicalPath` is owned 1:1 by its `AnchorPair` (decision 4).
- It persists in `editing-state.canonicalPaths` regardless of whether
  any edits have been applied yet, so the user can author once and
  re-apply after loading more weekly GPX files.
- Editing the vertex list does *not* automatically re-apply existing
  edits - the user explicitly re-runs "apply" after editing, so they
  can see the new preview first.

---

## 5. Integration plan

The smallest set of changes to existing modules.

### 5.1 `src/model/store.js`

No mutations to its existing shape. Add `editing` events to the
exported `EVT` object so subscribers can listen on the shared bus
without a circular import:

```js
const EVT = {
  // ...existing...
  anchorsChanged:   "anchors:changed",
  canonicalChanged: "canonical:changed",
  editsChanged:     "edits:changed",
};
```

That's the only change to `store.js`. All state and methods live in
`editing-state.js`.

### 5.2 `src/editing/canonical-path/editing-state.js`

New module. Owns:

- `anchorPairs: Map<string, AnchorPair>`
- `canonicalPaths: Map<string, CanonicalPath>` (keyed by `anchorPairId`)
- `ops: EditOp[]` (linear stack)
- `groupCounter` (for grouping ops produced by a single apply)

Public API as listed in section 1. Notifications:

- Anchor mutator: emits `anchors:changed`.
- Canonical mutator: emits `canonical:changed`.
- `applyEdits([...ops])` / `undoLast()`: emit `edits:changed` with the
  set of affected `sourceId`s so subscribers can re-render only those.

`effectiveSource(sourceId)`:

```
function effectiveSource(id):
  const src = store.getSource(id)
  if !src: return undefined
  const sourceOps = ops.filter(o => o.sourceId === id)
  if !sourceOps.length: return src
  return applyOps(src, sourceOps)   // shallow clone
```

The shallow clone is important: layer-manager keeps Leaflet polylines
in identity-keyed groups, so we never mutate the parsed `Track`
objects.

### 5.3 `src/map/layer-manager.js`

Add one method:

```js
refreshSource(source) {
  this.removeSource(source.id);
  this.addSource(source);
}
```

This is the same remove-then-add trick `main.js` already does when
display options change (lines 116-119 in the current `main.js`). No
new code paths inside `addSource` are needed. The downsampling,
single-point-segment handling, type/colour resolution, and waypoint
rendering all work unchanged.

### 5.4 `src/main.js`

```js
import { createEditingState } from "./editing/canonical-path/editing-state.js";
import { createCanonicalCard } from "./editing/canonical-path/ui/canonical-card.js";
import { createMapPicker }    from "./editing/canonical-path/ui/map-picker.js";
import { createCanonicalOverlay } from "./editing/canonical-path/ui/canonical-overlay.js";

const editing = createEditingState(store);
const mapPicker = createMapPicker(mapView);
const overlay = createCanonicalOverlay(mapView);

createCanonicalCard(
  document.getElementById("canonicalCard"),
  store,
  editing,
  mapPicker,
  overlay,
);

// Re-render affected sources when edits change.
store.bus.on(store.EVT.editsChanged, ({ sourceIds }) => {
  for (const id of sourceIds) {
    const effective = editing.effectiveSource(id);
    if (effective) layers.refreshSource(effective);
  }
  applyAndRender();
});

// addSource path goes through effectiveSource so re-imports are clean.
store.bus.on(store.EVT.sourceAdded, ({ source }) => {
  const effective = editing.effectiveSource(source.id) ?? source;
  // (...same as today but using `effective` instead of `source`)
});

// Exporters use editing.effectiveSource so edits round-trip to disk.
document.getElementById("exportPerFileBtn").addEventListener("click", () => {
  for (const s of store.listSources()) {
    const eff = editing.effectiveSource(s.id);
    const xml = serializeSource(eff);
    const hasEdits = editing.opsForSource(s.id).length > 0;
    const suffix = hasEdits ? ".canonicalized.gpx" : ".roundtrip.gpx";
    const name = s.filename.replace(/\.gpx$/i, "") + suffix;
    downloadText(name, xml);
  }
});

document.getElementById("exportMergedBtn").addEventListener("click", () => {
  const eff = store.listSources().map(s => editing.effectiveSource(s.id));
  downloadText("merged.gpx", serializeMerged(eff));
});
```

### 5.5 `src/serializer/gpx-serializer.js`

Unchanged. It already accepts a `Source` and emits GPX. Because
`effectiveSource()` returns a `Source`-shaped object with the same
keys, the serializer is oblivious to whether it's looking at the
original or an edited one. This is the cleanest part of the design.

### 5.6 `index.html`

One new card:

```html
<div class="card">
  <h2>Canonical paths</h2>
  <div id="canonicalCard"></div>
</div>
```

Plus a thin draw-mode banner overlay that shows hotkeys while drawing.
The Leaflet container does not need to change.

### 5.7 Undo propagation

1. User clicks "undo last".
2. `editing.undoLast()` pops every op sharing the topmost `groupId`,
   appends inverse ops back into a redo stack (optional later), and
   emits `edits:changed` with the affected source ids.
3. `main.js`'s `edits:changed` handler calls `layers.refreshSource()`
   for each affected source.
4. The sidebar `canonical-card` re-renders (it also subscribes to
   `edits:changed`) so the "applied edits" count updates.

Because `effectiveSource` is pure (re-runs `applyOps` from the empty
parsed source on every call), undo is guaranteed correct: there is no
hidden state that can drift.

---

## 6. Decisions

These are locked at planning approval. Sections 1-5 and 7 assume them.
A short rationale is recorded so future-us doesn't relitigate.

1. **Replacement strategy: overwrite the matched track and push an
   EditOp.** Undo restores the original. A per-apply "keep original as
   sibling track" checkbox is *not* in scope for the first
   implementation; if a user asks for side-by-side comparison in the
   exported file we revisit then.

2. **Canonical segment structure: single `<trkseg>` per canonical
   track.** ARC subway tracks already collapse to roughly one logical
   movement and a single segment makes timing math trivial.
   Multi-segment canonicals (one segment per inter-station leg) can be
   layered on later if a concrete need shows up.

3. **Chaining default: off; user opts in per anchor pair, gap 180 s.**
   Keeps filter semantics and chaining semantics orthogonal.

4. **AnchorPair <-> CanonicalPath cardinality: 1:1.** Alternate routes
   between the same endpoints = make a second anchor pair with the
   same coordinates and a different label. Going 1:N would force an
   "which canonical applies here?" decision at apply time that we
   don't need yet.

5. **Drift detection: reject re-apply on fingerprint mismatch.**
   `EditOp.snapshot` includes `{firstPoint, lastPoint, ptCount, sha}`.
   On mismatch, surface a "stale edit" status and drop the op rather
   than silently overwriting a divergent track.

6. **Export filenames:** `<orig>.canonicalized.gpx` when the source
   has at least one edit op, `<orig>.roundtrip.gpx` otherwise. The
   suffix is the at-a-glance signal that something was changed.

7. **Persistence across reload: session-only.** Matches the rest of
   the app (browser-only, no disk writes). If a future feature
   persists state to localStorage, it stores anchor pairs and
   canonical paths but *not* op stacks - ops are derivable from
   "apply this canonical to current sources" on demand.

8. **Reverse direction:** when a match is `reverse`, reverse the
   canonical vertex list before time interpolation so spatial flow
   matches the recorded direction. The robust endpoints already
   encode direction, so this is the entire fix.

9. **Type on canonicalised track: preserve original `type` and
   `rawType`.** No automatic "promote to dominant chain type" - that
   would be a separate per-apply opt-in if a user asks.

10. **`extras` handling:** preserve `Track.extras` verbatim. Drop
    `Segment.extras` (segments are new). `Point.extras` doesn't exist
    in the current model.

11. **Snap distance while drawing: screen-pixel distance, threshold 8
    px.** Computed via Leaflet's `map.latLngToContainerPoint`.
    Zoom-independent UX; haversine-meters snap is unintuitive when the
    map is zoomed out.

12. **Anchor circle rendering: `L.circle([lat,lon], { radius })`.**
    Scales with the map in meters so the visual matches the slider.
    `L.circleMarker` would lie about the matching radius.

---

## 7. Incremental implementation order

Five reviewable PR-sized chunks. Each one is shippable on its own and
leaves the app in a working state.

### Step 1 - Geo + data model + store extension (no UI)

- Add `geo.js` with the haversine + polyline helpers.
- Add JSDoc typedefs for `Anchor`, `AnchorPair`, `CanonicalPath`,
  `EditOp`, `MatchCandidate`, `TrackSnapshot` to `model/types.js`.
- Add `editing-state.js` with anchor-pair/canonical-path/op-stack
  state and the new bus events.
- Add `edit-ops.js` (`applyOps`, `inverseOp`, `fingerprintTrack`).
- Wire `editing-state` into `main.js`, exporters now route through
  `editing.effectiveSource(id)`. With no ops, behaviour is identical
  to today.
- Tiny manual test: create an op programmatically in the console,
  verify the map re-renders and the export contains the edited track.

### Step 2 - Anchor pair UI + map pickers + preview overlay

- Add `ui/canonical-card.js` (sidebar UI: list, create, edit panel).
- Add `ui/map-picker.js` (single-shot lat/lon picker).
- Add `ui/canonical-overlay.js` (anchor circles).
- Bidirectional toggle, type filter, weekday/hour filter widgets.
- "Show matches" preview pipes through `matcher.js` (basic, no
  chaining yet).
- No canonical path, no apply. Just preview.

### Step 3 - Trip view, matcher, and match list

- Add `trip-view.js` (basic + robust endpoint).
- Add `matcher.js` (forward + reverse + filters).
- Sidebar match list, including click-to-zoom on a match.
- Robust endpoints drawn as dots on the map preview.

### Step 4 - Canonical path authoring + apply

- Add `canonical-path.js` (fromVertices, fromExemplarTrack).
- Add `ui/path-drawer.js` (click-to-add, undo, optional snap).
- Add "use exemplar" picker.
- Add `apply.js` (`planApply` produces EditOps).
- "Preview apply" overlay (ghost rendering, no store mutation).
- "Apply" pushes the op group and triggers `edits:changed`.
- "Undo last" pops the top group.

### Step 5 - Chaining + per-source export polish + multi-pair UX

- Add `chaining.js`.
- Anchor-pair toggle for `chainFragments`.
- Filename suffix (`.canonicalized.gpx`) when edits exist.
- Multi-pair list polish: faint anchor circles for enabled-but-inactive
  pairs, per-pair colour, expand/collapse memory.
- Drift detection at apply time with the fingerprint.

### Step 6 (stretch) - Polish + tooling

- GeoJSON LineString import for canonical paths.
- Optional sibling-track replacement mode.
- Densify long canonical segments so interpolated times stay smooth.
- Persist anchor pairs + canonical paths (not edits) to localStorage.

Each step ends in a working app; steps 1-4 unlock the core feature;
steps 5-6 are quality and edge-case handling.

---

## Appendix - data lifecycle at a glance

```
   GPX file on disk           Source (parsed)            Effective Source
+-------------------+      +-------------------+      +-------------------+
|                   |  ->  |  store.getSource  |  ->  | editing.effective |
|                   |      |  (immutable)      |      |  (applyOps copy)  |
+-------------------+      +-------------------+      +-------------------+
                                                                |
                                                                v
                                                  +-------------------+
                                                  | layer-manager     |
                                                  | serializer        |
                                                  +-------------------+

      ^                                                                ^
      |                                                                |
      |                +--------------------------+                    |
      +--- export -----| editing.opsForSource(id) |--- apply / undo ---+
                       +--------------------------+
```

Single source of truth holds only parsed `Source`s. Edits are pure
data, applied lazily, and reversible.
