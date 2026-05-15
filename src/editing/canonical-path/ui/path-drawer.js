// Click-to-add-vertex drawing tool.
//
// While active, single-click on the map appends a vertex, the in-progress
// polyline is rendered via the overlay, `u` / Ctrl+Z removes the last vertex,
// `Enter` or double-click commits, `Esc` cancels. `s` toggles snap-to-vertex.
//
// The caller (canonical-card) provides the overlay handle and a set of
// existing-track polylines to snap to.

export function createPathDrawer(mapView, overlay) {
  let vertices = [];
  let snapping = false;
  let active = false;
  let commitCb = null;
  let cancelCb = null;
  let onUpdate = null;
  let colorHint = "#7ec850";
  let snapPolylines = [];

  function emitUpdate() {
    overlay.showDrawProgress(vertices, colorHint);
    onUpdate?.(vertices.slice());
  }

  function nearestSnap(latlng) {
    if (!snapping || !snapPolylines.length) return null;
    const p0 = mapView.raw.latLngToContainerPoint(latlng);
    let best = null;
    let bestDist = 8 * 8;
    for (const polyline of snapPolylines) {
      for (const ll of polyline) {
        const p = mapView.raw.latLngToContainerPoint(ll);
        const d2 = (p.x - p0.x) ** 2 + (p.y - p0.y) ** 2;
        if (d2 < bestDist) { bestDist = d2; best = ll; }
      }
    }
    return best;
  }

  function onMapClick(e) {
    const snapped = nearestSnap(e.latlng);
    const ll = snapped || e.latlng;
    vertices.push([ll.lat, ll.lng]);
    emitUpdate();
  }

  function onDblClick(e) {
    L.DomEvent.preventDefault(e);
    commit();
  }

  function onKey(e) {
    if (!active) return;
    // Don't hijack keys while the user is typing in a sidebar input.
    const tag = e.target?.tagName || "";
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Escape still cancels regardless of focus.
      if (e.key === "Escape") cancel();
      return;
    }
    if (e.key === "Escape") { cancel(); return; }
    if (e.key === "Enter") { commit(); return; }
    if (e.key === "u" || (e.key === "z" && (e.ctrlKey || e.metaKey))) {
      vertices.pop();
      emitUpdate();
      return;
    }
    if (e.key === "s") {
      snapping = !snapping;
      onUpdate?.(vertices.slice());
    }
  }

  function commit() {
    if (!active) return;
    if (vertices.length < 2) return; // need >= 2
    const out = vertices.slice();
    teardown();
    commitCb?.(out);
  }

  function cancel() {
    if (!active) return;
    teardown();
    overlay.clearDraw();
    cancelCb?.();
  }

  function teardown() {
    active = false;
    mapView.raw.off("click", onMapClick);
    mapView.raw.off("dblclick", onDblClick);
    window.removeEventListener("keydown", onKey);
    mapView.raw.doubleClickZoom.enable();
    const c = mapView.raw.getContainer();
    if (c) c.classList.remove("cp-drawing");
  }

  function start(opts = {}) {
    teardown();
    vertices = (opts.initialVertices || []).slice();
    snapping = !!opts.snap;
    snapPolylines = opts.snapPolylines || [];
    colorHint = opts.colorHint || "#7ec850";
    commitCb = opts.onCommit || null;
    cancelCb = opts.onCancel || null;
    onUpdate = opts.onUpdate || null;
    active = true;
    mapView.raw.doubleClickZoom.disable();
    mapView.raw.on("click", onMapClick);
    mapView.raw.on("dblclick", onDblClick);
    window.addEventListener("keydown", onKey);
    const c = mapView.raw.getContainer();
    if (c) c.classList.add("cp-drawing");
    emitUpdate();
  }

  return {
    start, commit, cancel,
    get active() { return active; },
    get snapping() { return snapping; },
    get vertices() { return vertices.slice(); },
    setSnapping(v) { snapping = !!v; onUpdate?.(vertices.slice()); },
  };
}
