// Renderer-side store. Holds UI state and a cached snapshot of source summaries
// fetched from the main-process SQLite layer. All mutations go through window.api;
// after each one we refresh the summary list and emit the relevant bus event.
//
// Sources here are lightweight (counts + bounds), not full parsed GPX data.
// Detailed track points are fetched on demand from the map layer-manager.

import { createBus } from "../core/event-bus.js";

const EVT = {
  sourceAdded:      "sources:added",
  sourceRemoved:    "sources:removed",
  sourcesChanged:   "sources:changed",   // any list-shape change
  sourceVisibility: "sources:visibility",
  typesChanged:     "types:changed",
  typeVisibility:   "types:visibility",
  filtersChanged:   "filters:changed",
};

export async function createStore() {
  const bus = createBus();

  /** @type {Map<number, SourceSummary>} */
  const sources = new Map();
  /** Visibility per-source (mirrors DB column but cached so UI is sync). */
  const sourceVisible = new Map();
  /** Set of distinct track types present across all sources. */
  let knownTypes = [];
  /** UI-only: visibility flag per type. Defaults to true except "bogus". */
  const typeVisible = new Map();

  async function refreshAll(opts = {}) {
    const { silent = false } = opts;
    const list = await window.api.listSources();
    sources.clear();
    for (const s of list) {
      sources.set(s.id, s);
      if (!sourceVisible.has(s.id)) sourceVisible.set(s.id, !!s.visible);
    }
    knownTypes = await window.api.listTypes();
    for (const t of knownTypes) if (!typeVisible.has(t)) typeVisible.set(t, t !== "bogus");
    for (const t of [...typeVisible.keys()]) if (!knownTypes.includes(t)) typeVisible.delete(t);
    if (!silent) {
      bus.emit(EVT.typesChanged, { types: knownTypes.slice() });
      bus.emit(EVT.sourcesChanged);
      bus.emit(EVT.filtersChanged);
    }
  }

  await refreshAll({ silent: true });

  return {
    bus,
    EVT,

    listSources() { return [...sources.values()]; },
    getSource(id) { return sources.get(id); },
    isSourceVisible(id) { return sourceVisible.get(id) !== false; },
    listTypes() { return knownTypes.slice().sort(); },
    isTypeVisible(t) { return typeVisible.get(t) !== false; },

    async importPaths(paths) {
      const r = await window.api.importFiles(paths);
      await refreshAll({ silent: true });
      for (const s of r.ok) {
        sourceVisible.set(s.id, true);
        bus.emit(EVT.sourceAdded, { source: sources.get(s.id) || s });
      }
      bus.emit(EVT.typesChanged, { types: knownTypes.slice() });
      bus.emit(EVT.sourcesChanged);
      bus.emit(EVT.filtersChanged);
      return r;
    },

    async removeSource(id) {
      if (!sources.has(id)) return;
      await window.api.removeSource(id);
      sources.delete(id);
      sourceVisible.delete(id);
      const types = await window.api.listTypes();
      knownTypes = types;
      for (const t of [...typeVisible.keys()]) if (!types.includes(t)) typeVisible.delete(t);
      bus.emit(EVT.sourceRemoved, { sourceId: id });
      bus.emit(EVT.typesChanged, { types: knownTypes.slice() });
      bus.emit(EVT.sourcesChanged);
      bus.emit(EVT.filtersChanged);
    },

    async setSourceVisible(id, visible) {
      if (!sources.has(id)) return;
      sourceVisible.set(id, !!visible);
      await window.api.setSourceVisible(id, !!visible);
      bus.emit(EVT.sourceVisibility, { sourceId: id, visible: !!visible });
      bus.emit(EVT.filtersChanged);
    },

    setTypeVisible(type, visible) {
      typeVisible.set(type, !!visible);
      bus.emit(EVT.typeVisibility, { type, visible: !!visible });
      bus.emit(EVT.filtersChanged);
    },

    setAllTypesVisible(visible) {
      for (const t of knownTypes) typeVisible.set(t, !!visible);
      bus.emit(EVT.typeVisibility, { type: null, visible: !!visible });
      bus.emit(EVT.filtersChanged);
    },

    visibleSourceIds() {
      const out = [];
      for (const s of sources.values()) if (sourceVisible.get(s.id) !== false) out.push(s.id);
      return out;
    },

    visibleTypes() {
      return knownTypes.filter(t => typeVisible.get(t) !== false);
    },

    stats() {
      let trk = 0, seg = 0, pt = 0, wpt = 0;
      for (const s of sources.values()) {
        trk += s.trackCount || 0;
        seg += s.segmentCount || 0;
        pt  += s.pointCount || 0;
        wpt += s.waypointCount || 0;
      }
      return { sources: sources.size, trk, seg, pt, wpt };
    },

    async clear() {
      const ids = [...sources.keys()];
      for (const id of ids) await window.api.removeSource(id);
      sources.clear();
      sourceVisible.clear();
      knownTypes = [];
      typeVisible.clear();
      bus.emit(EVT.sourcesChanged);
      bus.emit(EVT.typesChanged, { types: [] });
      bus.emit(EVT.filtersChanged);
    },

    refresh: refreshAll,
  };
}
