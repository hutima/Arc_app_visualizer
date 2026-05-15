// One-shot map interactions. Puts the map into "next click" mode, resolves a
// promise with the clicked latlng or with a clicked candidate-track id.

export function createMapPicker(mapView) {
  let active = false;
  let cleanup = null;

  function setCrosshair(on) {
    const c = mapView.raw.getContainer();
    if (c) c.classList.toggle("cp-picking", !!on);
  }

  function cancel() {
    if (cleanup) { cleanup(); cleanup = null; }
    setCrosshair(false);
    active = false;
  }

  /**
   * Resolves with `{lat, lon}` on the next click, or `null` on Esc.
   */
  function pickPoint() {
    cancel();
    active = true;
    setCrosshair(true);
    return new Promise(resolve => {
      const onClick = e => {
        cleanup?.();
        resolve({ lat: e.latlng.lat, lon: e.latlng.lng });
      };
      const onKey = e => {
        if (e.key === "Escape") { cleanup?.(); resolve(null); }
      };
      mapView.raw.on("click", onClick);
      window.addEventListener("keydown", onKey);
      cleanup = () => {
        mapView.raw.off("click", onClick);
        window.removeEventListener("keydown", onKey);
        setCrosshair(false);
        active = false;
        cleanup = null;
      };
    });
  }

  /**
   * Pick from a set of candidate polylines. Each candidate is `{ id, latlngs }`.
   * Renders a temporary highlight; resolves with the picked id or null.
   *
   * @param {{id:string, latlngs:[number,number][]}[]} candidates
   */
  function pickTrack(candidates) {
    cancel();
    active = true;
    setCrosshair(true);
    const layer = L.layerGroup().addTo(mapView.raw);
    const lines = candidates.map(c => {
      const line = L.polyline(c.latlngs, {
        color: "#ffd66b", weight: 6, opacity: 0.85, interactive: true,
      });
      line.cpId = c.id;
      layer.addLayer(line);
      return line;
    });
    return new Promise(resolve => {
      const finish = id => { cleanup?.(); resolve(id); };
      const onClickLine = e => finish(e.target.cpId);
      lines.forEach(l => l.on("click", onClickLine));
      const onKey = e => { if (e.key === "Escape") finish(null); };
      window.addEventListener("keydown", onKey);
      cleanup = () => {
        lines.forEach(l => l.off("click", onClickLine));
        window.removeEventListener("keydown", onKey);
        mapView.raw.removeLayer(layer);
        setCrosshair(false);
        active = false;
        cleanup = null;
      };
    });
  }

  return { pickPoint, pickTrack, cancel, get active() { return active; } };
}
