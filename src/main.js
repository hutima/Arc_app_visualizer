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
import { createEditingState } from "./editing/canonical-path/editing-state.js";
import { createMapPicker } from "./editing/canonical-path/ui/map-picker.js";
import { createCanonicalOverlay } from "./editing/canonical-path/ui/canonical-overlay.js";
import { createPathDrawer } from "./editing/canonical-path/ui/path-drawer.js";
import { createCanonicalCard } from "./editing/canonical-path/ui/canonical-card.js";

const store = createStore();
const mapView = createMapView("map");
const layers = createLayerManager(mapView);
const editing = createEditingState(store);

const sourceListUi = createSourceList(document.getElementById("sourceList"), store);
const typeFiltersUi = createTypeFilters(document.getElementById("typeFilters"), store, layers);
const statusBar = createStatusBar(document.getElementById("statusBar"), store);

const mapPicker = createMapPicker(mapView);
const overlay = createCanonicalOverlay(mapView);
const pathDrawer = createPathDrawer(mapView, overlay);
const canonicalCard = createCanonicalCard(
  document.getElementById("canonicalCard"),
  store, editing, mapPicker, overlay, pathDrawer, statusBar,
);

let showWaypoints = true;

function applyAndRender() {
  const { visibleSources, visibleTypes } = currentVisibility(store);
  layers.applyVisibility(visibleSources, visibleTypes, showWaypoints);
  typeFiltersUi.render();
}

function addSourceToLayers(sourceId) {
  const effective = editing.effectiveSource(sourceId);
  if (effective) layers.addSource(effective);
}

function refreshSourceLayers(sourceId) {
  const effective = editing.effectiveSource(sourceId);
  if (effective) layers.refreshSource(effective);
}

store.bus.on(store.EVT.sourceAdded, ({ source }) => {
  addSourceToLayers(source.id);
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

store.bus.on(store.EVT.editsChanged, ({ sourceIds }) => {
  for (const id of (sourceIds || [])) refreshSourceLayers(id);
  applyAndRender();
});

// Canonical-card requests a fitBounds via a DOM CustomEvent so it doesn't
// need a direct mapView dependency.
document.getElementById("canonicalCard").addEventListener("cp:fit", e => {
  mapView.fitBounds(e.detail.bounds);
});

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
  fileInput.value = "";
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
  const effective = sources.map(s => editing.effectiveSource(s.id) || s);
  const xml = serializeMerged(effective);
  const anyEdits = sources.some(s => editing.hasEdits(s.id));
  downloadText(anyEdits ? "merged.canonicalized.gpx" : "merged.gpx", xml);
  statusBar.setMessage(`Exported merged GPX${anyEdits ? " (canonicalized)" : ""}.`, "ok");
});

document.getElementById("exportPerFileBtn").addEventListener("click", () => {
  const sources = store.listSources();
  if (!sources.length) { statusBar.setMessage("Nothing to export.", "warn"); return; }
  for (const s of sources) {
    const eff = editing.effectiveSource(s.id) || s;
    const xml = serializeSource(eff);
    const suffix = editing.hasEdits(s.id) ? ".canonicalized.gpx" : ".roundtrip.gpx";
    const name = s.filename.replace(/\.gpx$/i, "") + suffix;
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
    const sources = store.listSources();
    for (const s of sources) layers.removeSource(s.id);
    for (const s of sources) addSourceToLayers(s.id);
    applyAndRender();
  });
}
applyDisplayOpts();

registerServiceWorker();
