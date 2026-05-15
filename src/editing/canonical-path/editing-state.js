// Editing state: anchor pairs, canonical paths, and a linear op stack.
// Reuses the store's event bus so layer-manager and UI can subscribe
// without a back-reference to this module.
//
// The store still owns the parsed Source data. This module never mutates
// it; instead it produces "effective" Source/Tracks on demand by replaying
// the op stack through applyOps.

import { nextId } from "../../core/id.js";
import { applyOps } from "./edit-ops.js";

/**
 * @param {ReturnType<typeof import("../../model/store.js").createStore>} store
 */
export function createEditingState(store) {
  /** @type {Map<string, import("../../model/types.js").AnchorPair>} */
  const anchorPairs = new Map();
  /** @type {Map<string, import("../../model/types.js").CanonicalPath>} */
  const canonicalPaths = new Map(); // keyed by anchorPairId
  /** @type {import("../../model/types.js").EditOp[]} */
  const ops = [];

  const emit = (name, payload) => store.bus.emit(name, payload);

  function affectedSourceIdsForGroup(groupId) {
    const set = new Set();
    for (const op of ops) if (op.groupId === groupId) set.add(op.sourceId);
    return [...set];
  }

  return {
    // -------- Anchor pairs --------

    addAnchorPair(partial) {
      const pair = {
        id: nextId("ap"),
        label: partial.label || "",
        start: { ...partial.start },
        end: { ...partial.end },
        bidirectional: partial.bidirectional !== false,
        chainFragments: !!partial.chainFragments,
        chainGapSec: partial.chainGapSec ?? 180,
        filters: partial.filters || undefined,
        canonicalPathId: undefined,
        enabled: partial.enabled !== false,
        createdAt: Date.now(),
      };
      anchorPairs.set(pair.id, pair);
      emit(store.EVT.anchorsChanged, { pairId: pair.id, kind: "added" });
      return pair;
    },

    updateAnchorPair(id, patch) {
      const cur = anchorPairs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      if (patch.start) next.start = { ...cur.start, ...patch.start };
      if (patch.end) next.end = { ...cur.end, ...patch.end };
      anchorPairs.set(id, next);
      emit(store.EVT.anchorsChanged, { pairId: id, kind: "updated" });
      return next;
    },

    removeAnchorPair(id) {
      if (!anchorPairs.has(id)) return false;
      anchorPairs.delete(id);
      const cp = canonicalPaths.get(id);
      if (cp) canonicalPaths.delete(id);
      // Drop edits associated with this pair from the stack.
      const dropGroups = new Set();
      for (const op of ops) if (op.anchorPairId === id) dropGroups.add(op.groupId);
      if (dropGroups.size) {
        const affected = new Set();
        for (let i = ops.length - 1; i >= 0; i--) {
          if (dropGroups.has(ops[i].groupId)) {
            affected.add(ops[i].sourceId);
            ops.splice(i, 1);
          }
        }
        emit(store.EVT.editsChanged, { sourceIds: [...affected] });
      }
      emit(store.EVT.anchorsChanged, { pairId: id, kind: "removed" });
      return true;
    },

    setAnchorPairEnabled(id, enabled) {
      const cur = anchorPairs.get(id);
      if (!cur) return;
      cur.enabled = !!enabled;
      emit(store.EVT.anchorsChanged, { pairId: id, kind: "updated" });
    },

    listAnchorPairs() { return [...anchorPairs.values()]; },
    getAnchorPair(id) { return anchorPairs.get(id); },

    // -------- Canonical paths --------

    setCanonicalPath(anchorPairId, canonical) {
      if (!anchorPairs.has(anchorPairId)) return;
      const stored = { ...canonical, anchorPairId };
      canonicalPaths.set(anchorPairId, stored);
      const pair = anchorPairs.get(anchorPairId);
      pair.canonicalPathId = stored.id;
      emit(store.EVT.canonicalChanged, { pairId: anchorPairId });
    },

    getCanonicalPath(anchorPairId) {
      return canonicalPaths.get(anchorPairId);
    },

    clearCanonicalPath(anchorPairId) {
      if (!canonicalPaths.delete(anchorPairId)) return;
      const pair = anchorPairs.get(anchorPairId);
      if (pair) pair.canonicalPathId = undefined;
      emit(store.EVT.canonicalChanged, { pairId: anchorPairId });
    },

    // -------- Edit op stack --------

    applyEdits(newOps) {
      if (!newOps?.length) return;
      ops.push(...newOps);
      const set = new Set(newOps.map(o => o.sourceId));
      emit(store.EVT.editsChanged, { sourceIds: [...set] });
    },

    undoLast() {
      if (!ops.length) return false;
      const lastGroup = ops[ops.length - 1].groupId;
      const sourceIds = new Set();
      while (ops.length && ops[ops.length - 1].groupId === lastGroup) {
        sourceIds.add(ops[ops.length - 1].sourceId);
        ops.pop();
      }
      emit(store.EVT.editsChanged, { sourceIds: [...sourceIds] });
      return true;
    },

    clearAllEdits() {
      if (!ops.length) return;
      const set = new Set(ops.map(o => o.sourceId));
      ops.length = 0;
      emit(store.EVT.editsChanged, { sourceIds: [...set] });
    },

    listOps() { return ops.slice(); },
    opsForSource(sourceId) { return ops.filter(o => o.sourceId === sourceId); },
    opCount() { return ops.length; },
    affectedSourceIdsForGroup,

    // -------- Effective source/tracks --------

    effectiveSource(sourceId) {
      const src = store.getSource(sourceId);
      if (!src) return undefined;
      return applyOps(src, ops);
    },

    effectiveTracks(sourceId) {
      const eff = this.effectiveSource(sourceId);
      return eff ? eff.tracks : [];
    },

    hasEdits(sourceId) {
      return ops.some(o => o.sourceId === sourceId);
    },
  };
}
