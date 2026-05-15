// Single source of truth for loaded data, visibility flags, and edit operations.
// Modules read state via getters and react to bus events; they never mutate directly.

import { createBus } from "../core/event-bus.js";

const EVT = {
  sourceAdded: "sources:added",
  sourceRemoved: "sources:removed",
  sourceVisibility: "sources:visibility",
  typesChanged: "types:changed",
  typeVisibility: "types:visibility",
  filtersChanged: "filters:changed",
  // Editing-state events. The editing module emits these on this same bus
  // so subscribers (layer-manager, sidebar) don't need a back-reference.
  anchorsChanged: "anchors:changed",
  canonicalChanged: "canonical:changed",
  editsChanged: "edits:changed",
};

export function createStore() {
  const bus = createBus();

  /** @type {Map<string, import("./types.js").Source>} */
  const sources = new Map();
  /** @type {Map<string, boolean>} */
  const sourceVisible = new Map();
  /** Set of normalized type keys present across all loaded sources. */
  const knownTypes = new Set();
  /** @type {Map<string, boolean>} */
  const typeVisible = new Map();

  function recomputeTypes() {
    const next = new Set();
    for (const s of sources.values()) for (const t of s.tracks) next.add(t.type || "");
    // Carry over visibility for known types; default new ones to visible
    // except "bogus" which ARC sometimes emits for unparseable segments.
    for (const t of next) if (!typeVisible.has(t)) typeVisible.set(t, t !== "bogus");
    for (const t of [...typeVisible.keys()]) if (!next.has(t)) typeVisible.delete(t);
    knownTypes.clear();
    for (const t of next) knownTypes.add(t);
    bus.emit(EVT.typesChanged, { types: [...knownTypes] });
  }

  return {
    bus,
    EVT,

    addSource(source) {
      sources.set(source.id, source);
      sourceVisible.set(source.id, true);
      recomputeTypes();
      bus.emit(EVT.sourceAdded, { source });
      bus.emit(EVT.filtersChanged);
    },

    removeSource(sourceId) {
      if (!sources.has(sourceId)) return;
      sources.delete(sourceId);
      sourceVisible.delete(sourceId);
      recomputeTypes();
      bus.emit(EVT.sourceRemoved, { sourceId });
      bus.emit(EVT.filtersChanged);
    },

    setSourceVisible(sourceId, visible) {
      if (!sources.has(sourceId)) return;
      sourceVisible.set(sourceId, !!visible);
      bus.emit(EVT.sourceVisibility, { sourceId, visible: !!visible });
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

    listSources() { return [...sources.values()]; },
    getSource(id) { return sources.get(id); },
    isSourceVisible(id) { return sourceVisible.get(id) !== false; },
    listTypes() { return [...knownTypes].sort(); },
    isTypeVisible(t) { return typeVisible.get(t) !== false; },

    // Aggregate stats for the status bar.
    stats() {
      let trk = 0, seg = 0, pt = 0, wpt = 0;
      for (const s of sources.values()) {
        wpt += s.waypoints.length;
        for (const t of s.tracks) {
          trk += 1;
          for (const sg of t.segments) {
            seg += 1;
            pt += sg.points.length;
          }
        }
      }
      return { sources: sources.size, trk, seg, pt, wpt };
    },
  };
}
