// Mirror anchor-pair and canonical-path mutations from the in-browser
// editing-state to the server. Also hydrates the editing-state at startup
// from whatever the server has persisted.
//
// Edits (the op stack) are NOT persisted in this first cut - they're
// session-only, same as the browser-only build. Export the canonicalized
// GPX to bake edits into the file system.

import { api } from "./api-client.js";

export async function createPersistenceBridge(store, editing, statusBar) {
  // ---- Hydrate from server ----

  let pairs = [];
  let canonicals = [];
  try {
    [pairs, canonicals] = await Promise.all([
      api.anchorPairs(),
      api.canonicalPaths(),
    ]);
  } catch (e) {
    statusBar.setMessage(`Could not load persisted anchors: ${e.message}`, "warn");
    return { suppress: () => {}, release: () => {} };
  }

  // While hydrating, suppress the bridge so we don't echo server data
  // back to the server.
  let suppressed = true;

  for (const p of pairs) {
    editing.addAnchorPair(p); // editing-state honours partial.id
  }
  for (const cp of canonicals) {
    editing.setCanonicalPath(cp.anchorPairId, cp);
  }

  suppressed = false;
  if (pairs.length || canonicals.length) {
    statusBar.setMessage(
      `Hydrated ${pairs.length} anchor pair(s) and ${canonicals.length} canonical path(s).`,
      "muted",
    );
  }

  // ---- Mirror local changes back to the server ----

  store.bus.on(store.EVT.anchorsChanged, async ({ pairId, kind }) => {
    if (suppressed) return;
    try {
      if (kind === "removed") {
        await api.deleteAnchorPair(pairId);
      } else {
        const pair = editing.getAnchorPair(pairId);
        if (!pair) return;
        await api.upsertAnchorPair(pair.id, pair);
      }
    } catch (e) {
      statusBar.setMessage(`Persist anchor failed: ${e.message}`, "warn");
    }
  });

  store.bus.on(store.EVT.canonicalChanged, async ({ pairId }) => {
    if (suppressed) return;
    try {
      const cp = editing.getCanonicalPath(pairId);
      if (cp) {
        await api.upsertCanonicalPath(cp.id, cp);
      } else {
        // Canonical cleared. Find its id from the deleted pair? Server
        // cascade-deletes when the owning anchor pair is removed, so this
        // branch is only hit when the user explicitly clears.
        // We don't currently expose a "clear canonical" UI, so leave a TODO.
      }
    } catch (e) {
      statusBar.setMessage(`Persist canonical failed: ${e.message}`, "warn");
    }
  });

  return {
    suppress() { suppressed = true; },
    release()  { suppressed = false; },
  };
}
