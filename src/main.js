// Renderer bootstrap. Wires the modules together; no business logic here.

import { createStore } from "./model/store.js";
import { pickAndImport } from "./io/file-import.js";
import { exportMerged, exportPerFile } from "./io/file-export.js";
import { createMapView } from "./map/map-view.js";
import { createLayerManager } from "./map/layer-manager.js";
import { createSourceList } from "./ui/source-list.js";
import { createTypeFilters } from "./ui/type-filters.js";
import { createStatusBar } from "./ui/status-bar.js";

(async () => {
  const store = await createStore();
  const mapView = createMapView("map");
  const layers = createLayerManager(mapView, store);

  const sourceListUi = createSourceList(document.getElementById("sourceList"), store);
  const typeFiltersUi = createTypeFilters(document.getElementById("typeFilters"), store, layers);
  const statusBar = createStatusBar(document.getElementById("statusBar"), store);

  await layers.loadTypeColors();

  // Trigger an initial redraw if there are already sources in the library.
  layers.requestRedraw();
  if (store.listSources().length) await layers.fitAll();

  // Subscribe to all change events that should re-query the map.
  store.bus.on(store.EVT.filtersChanged, () => layers.requestRedraw());
  store.bus.on(store.EVT.sourceAdded, async () => {
    layers.requestRedraw();
    await layers.fitAll();
  });
  store.bus.on(store.EVT.sourceRemoved, () => layers.requestRedraw());

  // ----- Import button -----
  document.getElementById("importBtn").addEventListener("click", async () => {
    statusBar.setMessage("Pick GPX files...", "muted");
    const { ok, errors, canceled } = await pickAndImport(store, ev => {
      if (ev.phase === "start") {
        statusBar.setMessage(`Importing ${ev.file} (${ev.index + 1}/${ev.total})...`, "ok");
      } else if (ev.phase === "import" && ev.pointsImported != null && ev.pointsImported % 200000 === 0) {
        statusBar.setMessage(`Importing ${ev.file}: ${ev.pointsImported.toLocaleString()} pts...`, "ok");
      } else if (ev.phase === "done") {
        statusBar.setMessage("Import complete.", "ok");
      }
    });
    if (canceled) { statusBar.setMessage("Import canceled.", "muted"); return; }
    if (errors.length) {
      statusBar.setMessage(`Imported ${ok.length}, failed ${errors.length}: ${errors[0].file}`, "warn");
      console.warn("Import errors:", errors);
    } else {
      statusBar.setMessage(`Imported ${ok.length} file(s).`, "ok");
    }
  });

  // ----- Clear all -----
  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (!confirm("Remove all imported sources from the local library?")) return;
    await store.clear();
    statusBar.setMessage("Library cleared.", "muted");
  });

  // ----- Fit -----
  document.getElementById("fitBtn").addEventListener("click", () => layers.fitAll());

  // ----- Waypoint toggle -----
  const wptToggle = document.getElementById("toggleWpt");
  wptToggle.addEventListener("change", () => layers.setShowWaypoints(wptToggle.checked));
  layers.setShowWaypoints(wptToggle.checked);

  // ----- Export -----
  document.getElementById("exportMergedBtn").addEventListener("click", async () => {
    const ids = store.listSources().map(s => s.id);
    if (!ids.length) { statusBar.setMessage("Nothing to export.", "warn"); return; }
    statusBar.setMessage("Writing merged GPX...", "ok");
    const r = await exportMerged(ids);
    if (!r.written.length) { statusBar.setMessage("Export canceled.", "muted"); return; }
    statusBar.setMessage(`Wrote ${r.written[0]}`, "ok");
  });

  document.getElementById("exportPerFileBtn").addEventListener("click", async () => {
    const ids = store.listSources().map(s => s.id);
    if (!ids.length) { statusBar.setMessage("Nothing to export.", "warn"); return; }
    statusBar.setMessage("Writing per-file GPX...", "ok");
    const r = await exportPerFile(ids);
    if (!r.written.length) { statusBar.setMessage("Export canceled.", "muted"); return; }
    statusBar.setMessage(`Wrote ${r.written.length} file(s).`, "ok");
  });

  // ----- Display options -----
  const weightEl = document.getElementById("optWeight");
  const opacityEl = document.getElementById("optOpacity");
  const omitSingleEl = document.getElementById("optOmitSingle");
  const maxPtsEl = document.getElementById("optMaxPts");

  function applyDisplayOpts() {
    layers.setOptions({
      weight: Number(weightEl.value) || 2,
      opacity: Number(opacityEl.value) || 0.78,
      omitSinglePointSegments: omitSingleEl.checked,
      maxPointsPerSegment: Math.max(100, Number(maxPtsEl.value) || 4000),
    });
  }
  for (const el of [weightEl, opacityEl, omitSingleEl, maxPtsEl]) {
    el.addEventListener("change", applyDisplayOpts);
  }
  applyDisplayOpts();
})();
