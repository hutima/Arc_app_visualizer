// Leaflet wrapper. Keeps the rest of the app from depending directly on L.
//
// We expose a small surface: init, fitBounds, addOverlay, removeOverlay, exportPng.

export function createMapView(containerId) {
  const map = L.map(containerId, { zoomSnap: 0.5, zoomDelta: 0.5, worldCopyJump: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 20,
    crossOrigin: true,
  }).addTo(map);
  map.setView([20, 0], 2);

  return {
    raw: map,
    addLayer(layer) { map.addLayer(layer); },
    removeLayer(layer) { map.removeLayer(layer); },
    fitBounds(bounds, opts) {
      if (bounds && bounds.isValid && bounds.isValid()) {
        map.fitBounds(bounds, opts || { padding: [24, 24] });
      }
    },
    invalidateSize() { map.invalidateSize(); },
  };
}
