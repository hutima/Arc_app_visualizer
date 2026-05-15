// Desktop renderer bootstrap. Runs in both Electron (via app:// protocol)
// and HTTP (via /web/...) modes. Reuses every existing module under /src/
// unchanged. The data source - sources list, anchor pairs, canonical paths -
// is the dual-mode `api` from api-client.js, which picks Electron IPC if
// available and falls back to HTTP fetch otherwise.

import { createStore } from "../../src/model/store.js";
import { createMapView } from "../../src/map/map-view.js";
import { createLayerManager } from "../../src/map/layer-manager.js";
import { currentVisibility } from "../../src/filtering/visibility.js";
import { createTypeFilters } from "../../src/ui/type-filters.js";
import { createStatusBar } from "../../src/ui/status-bar.js";
import { createEditingState } from "../../src/editing/canonical-path/editing-state.js";
import { createMapPicker } from "../../src/editing/canonical-path/ui/map-picker.js";
import { createCanonicalOverlay } from "../../src/editing/canonical-path/ui/canonical-overlay.js";
import { createPathDrawer } from "../../src/editing/canonical-path/ui/path-drawer.js";
import { createCanonicalCard } from "../../src/editing/canonical-path/ui/canonical-card.js";
import { serializeSource, serializeMerged } from "../../src/serializer/gpx-serializer.js";

import { api, MODE } from "./api-client.js";
import { createLibrary } from "./library.js";
import { createPersistenceBridge } from "./persistence-bridge.js";

const store = createStore();
const mapView = createMapView("map");
const layers = createLayerManager(mapView);
const editing = createEditingState(store);

const typeFiltersUi = createTypeFilters(document.getElementById("typeFilters"), store, layers);
const statusBar = createStatusBar(document.getElementById("statusBar"), store);
const library = createLibrary(document.getElementById("libraryList"), store, statusBar);

const mapPicker = createMapPicker(mapView);
const overlay = createCanonicalOverlay(mapView);
const pathDrawer = createPathDrawer(mapView, overlay);
createCanonicalCard(
  document.getElementById("canonicalCard"),
  store, editing, mapPicker, overlay, pathDrawer, statusBar,
);

document.getElementById("modeBadge").textContent = `(${MODE})`;

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
});
store.bus.on(store.EVT.sourceRemoved, ({ sourceId }) => {
  layers.removeSource(sourceId);
  applyAndRender();
});
store.bus.on(store.EVT.filtersChanged, applyAndRender);
store.bus.on(store.EVT.editsChanged, ({ sourceIds }) => {
  for (const id of (sourceIds || [])) refreshSourceLayers(id);
  applyAndRender();
});

document.getElementById("canonicalCard").addEventListener("cp:fit", e => {
  mapView.fitBounds(e.detail.bounds);
});
document.getElementById("fitBtn").addEventListener("click", () => {
  mapView.fitBounds(layers.bounds());
});
document.getElementById("reloadLibraryBtn").addEventListener("click", () => library.refresh());
document.getElementById("clearLoadedBtn").addEventListener("click", () => library.unloadAll());

// Import button. In Electron mode we show a native dialog. In HTTP mode we
// use the hidden file input (uploads to /api/ingest).
const ingestBtn = document.getElementById("ingestBtn");
const gpxUpload = document.getElementById("gpxUpload");
ingestBtn.addEventListener("click", () => {
  if (MODE === "electron") library.ingestDialog();
  else gpxUpload.click();
});
gpxUpload.addEventListener("change", async e => {
  const files = Array.from(e.target.files || []);
  if (files.length) await library.ingestFiles(files);
  e.target.value = "";
});

// Drag-drop ingest.
let dragDepth = 0;
const containsGpx = e => Array.from(e.dataTransfer?.types || []).includes("Files");
window.addEventListener("dragenter", e => {
  if (!containsGpx(e)) return;
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add("cp-dropping");
});
window.addEventListener("dragover", e => {
  if (!containsGpx(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("cp-dropping");
});
window.addEventListener("drop", async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("cp-dropping");
  const files = Array.from(e.dataTransfer?.files || [])
    .filter(f => /\.gpx$/i.test(f.name));
  if (files.length) await library.ingestFiles(files);
});

const wptToggle = document.getElementById("toggleWpt");
wptToggle.addEventListener("change", () => {
  showWaypoints = wptToggle.checked;
  applyAndRender();
});

// ---- Exports ----

document.getElementById("exportMergedBtn").addEventListener("click", async () => {
  // Server-side merged export covers everything in the DB.
  try {
    const r = await api.exportMerged();
    if (r?.path) statusBar.setMessage(`Saved to ${r.path}`, "ok");
    else if (r?.canceled) statusBar.setMessage("Save cancelled.", "muted");
  } catch (e) {
    statusBar.setMessage(`Export failed: ${e.message}`, "warn");
  }
});

document.getElementById("exportPerFileBtn").addEventListener("click", async () => {
  // For loaded sources, export with the in-memory effective tracks so
  // canonical-path edits bake in.
  const loadedIds = library.loadedIds();
  if (!loadedIds.length) {
    statusBar.setMessage("No sources loaded.", "warn");
    return;
  }
  for (const id of loadedIds) {
    const eff = editing.effectiveSource(id);
    if (!eff) continue;
    const xml = serializeSource(eff);
    const orig = library.catalog.get(id)?.filename || "source.gpx";
    const suffix = editing.hasEdits(id) ? ".canonicalized.gpx" : ".gpx";
    const name = orig.replace(/\.gpx$/i, "") + suffix;
    await api.exportText(name, xml);
  }
  statusBar.setMessage(`Exported ${loadedIds.length} file(s).`, "ok");
});

// ---- Display options ----

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

// ---- Electron menu hooks ----
api.onMenu?.(action => {
  switch (action) {
    case "open-import":   library.ingestDialog(); break;
    case "open-database": api.openDatabase().then(() => library.refresh()); break;
    case "new-database":  api.newDatabase().then(() => library.refresh()); break;
    case "export-merged": api.exportMerged(); break;
  }
});
api.onDbSwitched?.(({ dbPath }) => {
  statusBar.setMessage(`Switched database: ${dbPath}`, "ok");
  refreshServerInfo();
  library.refresh();
});

// ---- Status banner ----
function refreshServerInfo() {
  api.health()
    .then(h => {
      document.getElementById("serverInfo").innerHTML =
        `mode <strong>${h.mode || MODE}</strong> - sqlite ${h.sqlite}<br>` +
        `<span class="mono tiny">${h.dbPath}</span>`;
    })
    .catch(e => {
      document.getElementById("serverInfo").innerHTML =
        `<span class="warn">${MODE} offline (${e.message})</span>`;
    });
}
refreshServerInfo();

// ---- Hydrate persisted editing state ----
await createPersistenceBridge(store, editing, statusBar);
