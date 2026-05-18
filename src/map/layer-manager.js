// Viewport-driven layer manager. On map move/zoom, queries the SQLite-backed
// store for visible tracks (bbox-narrowed via R-tree, decimated per-segment
// based on configured point cap), then rebuilds Leaflet polylines.
//
// Because we always rebuild on viewport change, "applyVisibility" and
// "removeSource" are just triggers - they call requestRedraw().

import { colorForType } from "./palette.js";

const DEFAULT_OPTS = {
  weight: 2,
  opacity: 0.78,
  maxPointsPerSegment: 4000,
  omitSinglePointSegments: false,
  maxTracksPerQuery: 5000,
};

const REDRAW_DEBOUNCE_MS = 120;

export function createLayerManager(mapView, store) {
  let options = { ...DEFAULT_OPTS };
  /** Map<typeKey, hexColor> - in-renderer override layer over palette. */
  const typeColorOverrides = new Map();

  // Container layers. We rebuild their contents wholesale on each redraw.
  const trackLayer = L.layerGroup().addTo(mapView.raw);
  const waypointLayer = L.layerGroup().addTo(mapView.raw);

  let showWaypoints = true;
  let lastRedrawSeq = 0;
  let pendingTimer = null;

  function colorFor(type) {
    return typeColorOverrides.get(type) || colorForType(type);
  }

  function bboxOfMap() {
    const b = mapView.raw.getBounds();
    // Pad slightly so points just off the edge don't pop out.
    const pad = 0.1;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const dLat = (ne.lat - sw.lat) * pad;
    const dLon = (ne.lng - sw.lng) * pad;
    return [sw.lat - dLat, sw.lng - dLon, ne.lat + dLat, ne.lng + dLon];
  }

  async function redrawNow() {
    const seq = ++lastRedrawSeq;
    const sourceIds = store.visibleSourceIds();
    const types = store.visibleTypes();
    if (!sourceIds.length || !types.length) {
      trackLayer.clearLayers();
      waypointLayer.clearLayers();
      return;
    }
    const bbox = bboxOfMap();

    const [tracks, waypoints] = await Promise.all([
      window.api.queryTracks({
        bbox, sourceIds, types,
        maxPointsPerSegment: options.maxPointsPerSegment,
        maxTracks: options.maxTracksPerQuery,
      }),
      showWaypoints
        ? window.api.queryWaypoints({ bbox, sourceIds })
        : Promise.resolve([]),
    ]);

    // A newer redraw may have overtaken us between awaits; drop stale results.
    if (seq !== lastRedrawSeq) return;

    trackLayer.clearLayers();
    for (const t of tracks) {
      const color = colorFor(t.type);
      for (const seg of t.segments) {
        if (seg.length === 0) continue;
        if (seg.length === 1) {
          if (options.omitSinglePointSegments) continue;
          const dot = L.circleMarker([seg[0].lat, seg[0].lon], {
            radius: 2, weight: 1, color, fillColor: color,
            fillOpacity: 0.9, opacity: options.opacity,
          });
          trackLayer.addLayer(dot);
          continue;
        }
        const latlngs = seg.map(p => [p.lat, p.lon]);
        const line = L.polyline(latlngs, {
          color, weight: options.weight, opacity: options.opacity,
        });
        line.bindTooltip(`${t.type || "(none)"}${t.name ? " - " + t.name : ""}`, { sticky: true });
        trackLayer.addLayer(line);
      }
    }

    waypointLayer.clearLayers();
    if (showWaypoints) {
      for (const w of waypoints) {
        const m = L.circleMarker([w.lat, w.lon], {
          radius: 3, weight: 1, color: "#ffffff", fillColor: "#ffffff",
          fillOpacity: 0.65, opacity: 0.85,
        });
        const lines = [];
        if (w.name) lines.push(`<strong>${escapeHtml(w.name)}</strong>`);
        if (w.time) lines.push(`<div style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(new Date(w.time).toISOString())}</div>`);
        m.bindPopup(lines.join(""));
        waypointLayer.addLayer(m);
      }
    }
  }

  function requestRedraw() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; redrawNow(); }, REDRAW_DEBOUNCE_MS);
  }

  mapView.raw.on("moveend zoomend", requestRedraw);

  return {
    setOptions(next) { options = { ...options, ...next }; requestRedraw(); },
    getOptions() { return { ...options }; },

    setShowWaypoints(v) { showWaypoints = !!v; requestRedraw(); },

    setTypeColor(type, color) {
      typeColorOverrides.set(type, color);
      window.api.setTypeColor(type, color).catch(() => {});
      requestRedraw();
    },

    async loadTypeColors() {
      const stored = await window.api.listTypeColors();
      for (const [type, color] of Object.entries(stored)) typeColorOverrides.set(type, color);
      requestRedraw();
    },

    requestRedraw,

    async fitAll() {
      const b = await window.api.overallBounds();
      if (!b) return;
      const bounds = L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
      mapView.fitBounds(bounds);
    },

    countsByType() {
      // Aggregate from cached source summaries is not type-granular; we
      // expose a stub so the UI can still render a row per type. The map
      // itself shows real per-bbox counts through the visible polylines.
      const acc = new Map();
      for (const t of store.listTypes()) {
        acc.set(t, { tracks: 0, segs: 0, pts: 0, color: colorFor(t) });
      }
      return acc;
    },
  };
}

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
