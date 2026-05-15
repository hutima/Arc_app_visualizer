// Maintains a set of Leaflet layer groups keyed by (sourceId, type).
//
// Why keyed by both: visibility can be toggled per source AND per type independently.
// The product set is computed by filtering/visibility.js, and we add/remove groups
// from the map accordingly. Within a group, polylines are downsampled lazily.

import { colorForType } from "./palette.js";

const DEFAULT_OPTS = {
  weight: 2,
  opacity: 0.78,
  maxPointsPerSegment: 4000, // cap before downsampling kicks in
  omitSinglePointSegments: false,
};

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

export function createLayerManager(mapView) {
  // key = `${sourceId}::${type}`
  const groups = new Map();
  const meta = new Map(); // key -> { sourceId, type, color, attached, counts }
  const waypointGroups = new Map(); // sourceId -> L.layerGroup of circleMarkers

  let options = { ...DEFAULT_OPTS };

  function keyOf(sourceId, type) { return `${sourceId}::${type}`; }

  function ensureGroup(sourceId, type) {
    const k = keyOf(sourceId, type);
    let g = groups.get(k);
    if (!g) {
      g = L.layerGroup();
      groups.set(k, g);
      meta.set(k, { sourceId, type, color: colorForType(type), attached: false, counts: { tracks: 0, segs: 0, pts: 0 } });
    }
    return { key: k, group: g, info: meta.get(k) };
  }

  function attach(k) {
    const info = meta.get(k);
    if (!info || info.attached) return;
    mapView.addLayer(groups.get(k));
    info.attached = true;
  }
  function detach(k) {
    const info = meta.get(k);
    if (!info || !info.attached) return;
    mapView.removeLayer(groups.get(k));
    info.attached = false;
  }

  return {
    setOptions(next) { options = { ...options, ...next }; },
    getOptions() { return { ...options }; },

    /** Add all tracks/waypoints from a source. */
    addSource(source) {
      // Waypoints
      const wg = L.layerGroup();
      for (const w of source.waypoints) {
        const m = L.circleMarker([w.lat, w.lon], {
          radius: 3, weight: 1, color: "#ffffff", fillColor: "#ffffff",
          fillOpacity: 0.65, opacity: 0.85,
        });
        const lines = [];
        if (w.name) lines.push(`<strong>${escapeHtml(w.name)}</strong>`);
        if (w.time) lines.push(`<div style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(w.time)}</div>`);
        lines.push(`<div class="muted" style="font-size:.85em">${escapeHtml(source.filename)}</div>`);
        m.bindPopup(lines.join(""));
        wg.addLayer(m);
      }
      waypointGroups.set(source.id, wg);
      mapView.addLayer(wg);

      // Tracks
      for (const t of source.tracks) {
        const { group, info } = ensureGroup(source.id, t.type || "");
        info.counts.tracks += 1;
        for (const seg of t.segments) {
          let pts = seg.points;
          if (!pts.length) continue;
          if (pts.length === 1) {
            if (options.omitSinglePointSegments) continue;
            const dot = L.circleMarker([pts[0].lat, pts[0].lon], {
              radius: 2, weight: 1, color: info.color, fillColor: info.color,
              fillOpacity: 0.9, opacity: options.opacity,
            });
            dot.bindTooltip(`${t.type || "(none)"} - ${source.filename}`, { sticky: true });
            group.addLayer(dot);
            info.counts.segs += 1;
            info.counts.pts += 1;
            continue;
          }
          if (pts.length > options.maxPointsPerSegment) {
            pts = downsample(pts, options.maxPointsPerSegment);
          }
          const latlngs = pts.map(p => [p.lat, p.lon]);
          const line = L.polyline(latlngs, { color: info.color, weight: options.weight, opacity: options.opacity });
          line.bindTooltip(`${t.type || "(none)"} - ${source.filename}`, { sticky: true });
          group.addLayer(line);
          info.counts.segs += 1;
          info.counts.pts += latlngs.length;
        }
        attach(keyOf(source.id, t.type || ""));
      }
    },

    removeSource(sourceId) {
      const wg = waypointGroups.get(sourceId);
      if (wg) { mapView.removeLayer(wg); waypointGroups.delete(sourceId); }
      for (const [k, info] of meta) {
        if (info.sourceId !== sourceId) continue;
        detach(k);
        groups.delete(k);
        meta.delete(k);
      }
    },

    /** Apply visibility: visibleSourceIds X visibleTypes. */
    applyVisibility(visibleSourceIds, visibleTypes, showWaypoints) {
      for (const [k, info] of meta) {
        const want = visibleSourceIds.has(info.sourceId) && visibleTypes.has(info.type);
        if (want) attach(k); else detach(k);
      }
      for (const [sid, wg] of waypointGroups) {
        const want = showWaypoints && visibleSourceIds.has(sid);
        const isAttached = mapView.raw.hasLayer(wg);
        if (want && !isAttached) mapView.addLayer(wg);
        if (!want && isAttached) mapView.removeLayer(wg);
      }
    },

    /** Color override for a single type across all sources. */
    setTypeColor(type, color) {
      for (const [k, info] of meta) {
        if (info.type !== type) continue;
        info.color = color;
        groups.get(k).eachLayer(layer => {
          if (layer.setStyle) layer.setStyle({ color });
        });
      }
    },

    /** Re-render a source by removing + re-adding its layers. Cheap and
        correct; used by the editing module when an edit op changes a track. */
    refreshSource(source) {
      this.removeSource(source.id);
      this.addSource(source);
    },

    /** Compute aggregate bounds across attached groups for fitBounds. */
    bounds() {
      const b = L.latLngBounds([]);
      for (const [, g] of groups) {
        g.eachLayer(l => {
          if (l.getBounds) b.extend(l.getBounds());
          else if (l.getLatLng) b.extend(l.getLatLng());
        });
      }
      return b;
    },

    /** For UI: per-type aggregate counts. */
    countsByType() {
      const acc = new Map();
      for (const info of meta.values()) {
        const cur = acc.get(info.type) || { tracks: 0, segs: 0, pts: 0, color: info.color };
        cur.tracks += info.counts.tracks;
        cur.segs += info.counts.segs;
        cur.pts += info.counts.pts;
        cur.color = info.color;
        acc.set(info.type, cur);
      }
      return acc;
    },
  };
}

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
