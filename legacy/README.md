# Legacy prototypes

These two single-file HTML prototypes preceded the modular PWA in the parent
directory. They still work standalone (open in a browser, point at a GPX file)
and remain here as a reference for the visualization and merge logic that
informed the new architecture.

- `visualizer-fixed-v4.html` - one-file Leaflet visualizer with type legend,
  date filter, performance mode, waypoint clustering, and PNG export.
- `gpx-merge-fixed.html` - merges several GPX files into one while keeping
  each `<trk>` as a distinct node, with per-type include/exclude.

The PWA supersedes both. New work should happen in `src/` rather than here.
