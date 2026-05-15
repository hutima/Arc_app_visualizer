// Ephemeral map overlay for the canonical-path module:
//
// - one anchor-circles layer per pair
// - the canonical-path polyline for the active pair
// - a match-highlight layer
// - a "preview apply" ghost layer (renders what the edits *would* look like)
//
// Nothing here writes to the store; the canonical-card pushes data in.

function colorForPair(id) {
  // Stable hash -> hue so each pair gets its own colour without a palette.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 75%, 62%)`;
}

export function createCanonicalOverlay(mapView) {
  const anchorLayer = L.layerGroup().addTo(mapView.raw);
  const canonicalLayer = L.layerGroup().addTo(mapView.raw);
  const matchLayer = L.layerGroup().addTo(mapView.raw);
  const previewLayer = L.layerGroup().addTo(mapView.raw);
  const drawLayer = L.layerGroup().addTo(mapView.raw);

  function clearAnchors() { anchorLayer.clearLayers(); }
  function clearCanonical() { canonicalLayer.clearLayers(); }
  function clearMatches() { matchLayer.clearLayers(); }
  function clearPreview() { previewLayer.clearLayers(); }
  function clearDraw() { drawLayer.clearLayers(); }

  /**
   * Show anchor circles + endpoint markers for an anchor pair.
   * @param {import("../../../model/types.js").AnchorPair} pair
   * @param {{ active?: boolean }} [opts]
   */
  function showAnchors(pair, opts = {}) {
    const c = colorForPair(pair.id);
    const opacity = opts.active === false ? 0.35 : 0.9;
    const fillOpacity = opts.active === false ? 0.05 : 0.12;
    const startCircle = L.circle([pair.start.lat, pair.start.lon], {
      radius: pair.start.radiusMeters,
      color: c, weight: 1.5, opacity, fillColor: c, fillOpacity,
      dashArray: "4 4",
    });
    const endCircle = L.circle([pair.end.lat, pair.end.lon], {
      radius: pair.end.radiusMeters,
      color: c, weight: 1.5, opacity, fillColor: c, fillOpacity,
      dashArray: "4 4",
    });
    const startMarker = L.circleMarker([pair.start.lat, pair.start.lon], {
      radius: 4, color: "#ffffff", weight: 1.5, fillColor: c, fillOpacity: 1, opacity,
    });
    const endMarker = L.circleMarker([pair.end.lat, pair.end.lon], {
      radius: 4, color: "#ffffff", weight: 1.5, fillColor: c, fillOpacity: 1, opacity,
    });
    if (pair.start.label) startMarker.bindTooltip(pair.start.label);
    if (pair.end.label) endMarker.bindTooltip(pair.end.label);
    anchorLayer.addLayer(startCircle);
    anchorLayer.addLayer(endCircle);
    anchorLayer.addLayer(startMarker);
    anchorLayer.addLayer(endMarker);
  }

  /**
   * Show the canonical polyline for a pair.
   * @param {import("../../../model/types.js").AnchorPair} pair
   * @param {import("../../../model/types.js").CanonicalPath} canonical
   * @param {{ active?: boolean }} [opts]
   */
  function showCanonical(pair, canonical, opts = {}) {
    if (!canonical?.vertices?.length) return;
    const c = colorForPair(pair.id);
    const opacity = opts.active === false ? 0.5 : 0.95;
    const weight = opts.active === false ? 3 : 5;
    const line = L.polyline(canonical.vertices, {
      color: c, weight, opacity,
    });
    line.bindTooltip(pair.label || "canonical");
    canonicalLayer.addLayer(line);
  }

  /**
   * Highlight matched tracks for the active pair. `matches` carries the
   * effective polylines (caller resolves trackIds -> latlng list).
   * @param {{trackIds:string[], polylines:[number,number][][], robustStart:any, robustEnd:any, direction:string}[]} matches
   */
  function showMatches(matches) {
    for (const m of matches) {
      const color = m.direction === "reverse" ? "#76b7e0" : "#ffd66b";
      for (const latlngs of m.polylines) {
        const line = L.polyline(latlngs, {
          color, weight: 4, opacity: 0.9,
        });
        matchLayer.addLayer(line);
      }
      const a = L.circleMarker([m.robustStart.lat, m.robustStart.lon], {
        radius: 3, color: "#0c1208", weight: 1, fillColor: color, fillOpacity: 1,
      });
      const b = L.circleMarker([m.robustEnd.lat, m.robustEnd.lon], {
        radius: 3, color: "#0c1208", weight: 1, fillColor: color, fillOpacity: 1,
      });
      matchLayer.addLayer(a);
      matchLayer.addLayer(b);
    }
  }

  /**
   * Show a "preview apply" overlay: the canonical path drawn over each match,
   * in the same colour family as the canonical itself, with reduced opacity.
   * @param {import("../../../model/types.js").AnchorPair} pair
   * @param {{latlngs:[number,number][]}[]} previewLines
   */
  function showPreview(pair, previewLines) {
    const c = colorForPair(pair.id);
    for (const p of previewLines) {
      const ghost = L.polyline(p.latlngs, {
        color: c, weight: 4, opacity: 0.85, dashArray: "6 4",
      });
      previewLayer.addLayer(ghost);
    }
  }

  /**
   * Draw an in-progress polyline (the path-drawer feeds vertex lists here).
   * @param {[number,number][]} vertices
   * @param {string} colorHint
   */
  function showDrawProgress(vertices, colorHint) {
    drawLayer.clearLayers();
    if (!vertices.length) return;
    if (vertices.length > 1) {
      drawLayer.addLayer(L.polyline(vertices, {
        color: colorHint || "#7ec850", weight: 3, opacity: 0.95,
        dashArray: "5 4",
      }));
    }
    for (const v of vertices) {
      drawLayer.addLayer(L.circleMarker(v, {
        radius: 4, color: "#0c1208", weight: 1.5,
        fillColor: colorHint || "#7ec850", fillOpacity: 1,
      }));
    }
  }

  function clearAll() {
    clearAnchors();
    clearCanonical();
    clearMatches();
    clearPreview();
    clearDraw();
  }

  return {
    showAnchors, clearAnchors,
    showCanonical, clearCanonical,
    showMatches, clearMatches,
    showPreview, clearPreview,
    showDrawProgress, clearDraw,
    clearAll,
    colorForPair,
  };
}
