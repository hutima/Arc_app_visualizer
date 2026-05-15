// App entry point. Imports each module and wires them together via the store's bus.
// Keep this file thin: no business logic, just glue.

import { createStore } from "./model/store.js";
import { importFiles } from "./io/file-import.js";
import { downloadText } from "./io/file-export.js";
import { serializeSource, serializeMerged } from "./serializer/gpx-serializer.js";
import { createMapView } from "./map/map-view.js";
import { createLayerManager } from "./map/layer-manager.js";
import { currentVisibility } from "./filtering/visibility.js";
import { createSourceList } from "./ui/source-list.js";
import { createTypeFilters } from "./ui/type-filters.js";
import { createStatusBar } from "./ui/status-bar.js";
import { registerServiceWorker } from "./pwa/register-sw.js";

const store = createStore();
const mapView = createMapView("map");
const layers = createLayerManager(mapView);

const sourceListUi = createSourceList(document.getElementById("sourceList"), store);
const typeFiltersUi = createTypeFilters(document.getElementById("typeFilters"), store, layers);
const statusBar = createStatusBar(document.getElementById("statusBar"), store);

let showWaypoints = true;

function applyAndRender() {
  const { visibleSources, visibleTypes } = currentVisibility(store);
  layers.applyVisibility(visibleSources, visibleTypes, showWaypoints);
  // Refresh the dynamic legend counts after attach/detach.
  typeFiltersUi.render();
}

store.bus.on(store.EVT.sourceAdded, ({ source }) => {
  layers.addSource(source);
  applyAndRender();
  mapView.fitBounds(layers.bounds());
  statusBar.setMessage(`Loaded ${source.filename}`, "ok");
});

store.bus.on(store.EVT.sourceRemoved, ({ sourceId }) => {
  layers.removeSource(sourceId);
  applyAndRender();
  statusBar.setMessage("Removed source.", "muted");
});

store.bus.on(store.EVT.filtersChanged, applyAndRender);

const fileInput = document.getElementById("gpxInput");
fileInput.addEventListener("change", async () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  if (!files.length) return;
  statusBar.setMessage(`Importing ${files.length} file(s)...`, "ok");
  const { ok, errors } = await importFiles(files);
  for (const src of ok) store.addSource(src);
  if (errors.length) {
    statusBar.setMessage(`Imported ${ok.length}, failed ${errors.length}: ${errors[0].file}`, "warn");
    console.warn("Import errors:", errors);
  } else {
    statusBar.setMessage(`Imported ${ok.length} file(s).`, "ok");
  }
  fileInput.value = ""; // allow re-selecting the same file
});

document.getElementById("clearBtn").addEventListener("click", () => {
  for (const s of store.listSources()) store.removeSource(s.id);
  statusBar.setMessage("Cleared.", "muted");
});

document.getElementById("fitBtn").addEventListener("click", () => {
  mapView.fitBounds(layers.bounds());
});

const wptToggle = document.getElementById("toggleWpt");
wptToggle.addEventListener("change", () => {
  showWaypoints = wptToggle.checked;
  applyAndRender();
});

document.getElementById("exportMergedBtn").addEventListener("click", () => {
  const sources = store.listSources();
  if (!sources.length) { statusBar.setMessage("Nothing to export.", "warn"); return; }
  const xml = serializeMerged(sources);
  downloadText("merged.gpx", xml);
  statusBar.setMessage("Exported merged.gpx", "ok");
});

document.getElementById("exportPerFileBtn").addEventListener("click", () => {
  const sources = store.listSources();
  if (!sources.length) { statusBar.setMessage("Nothing to export.", "warn"); return; }
  for (const s of sources) {
    const xml = serializeSource(s);
    const name = s.filename.replace(/\.gpx$/i, "") + ".roundtrip.gpx";
    downloadText(name, xml);
  }
  statusBar.setMessage(`Exported ${sources.length} file(s).`, "ok");
});

// Performance options
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
  el.addEventListener("change", () => {
    applyDisplayOpts();
    // Rebuild affected layers by re-adding sources (simple, correct, infrequent).
    const sources = store.listSources();
    for (const s of sources) layers.removeSource(s.id);
    for (const s of sources) layers.addSource(s);
    applyAndRender();
  });
}
applyDisplayOpts();

registerServiceWorker();
