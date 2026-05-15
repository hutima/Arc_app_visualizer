// Dual-mode API client. When running inside the Electron shell the preload
// has exposed window.electronAPI - we route every call through it. When the
// page is loaded via the HTTP server we fall back to fetch.

const electronApi = (typeof window !== "undefined" && window.electronAPI) || null;
export const MODE = electronApi ? "electron" : "http";

async function jget(path, init) {
  const r = await fetch(path, init);
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

function httpApi() {
  return {
    health: () => jget("/api/health"),
    sources: () => jget("/api/sources"),
    source: id => jget(`/api/source/${encodeURIComponent(id)}`),
    removeSource: id => jget(`/api/source/${encodeURIComponent(id)}`, { method: "DELETE" }),
    types: () => jget("/api/types"),
    match: (pair, sourceIds) => jget("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair, sourceIds }),
    }),
    anchorPairs: () => jget("/api/anchor-pairs"),
    upsertAnchorPair: (id, pair) => jget(`/api/anchor-pair/${encodeURIComponent(id || "new")}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pair),
    }),
    deleteAnchorPair: id => jget(`/api/anchor-pair/${encodeURIComponent(id)}`, { method: "DELETE" }),
    canonicalPaths: () => jget("/api/canonical-paths"),
    upsertCanonicalPath: (id, cp) => jget(`/api/canonical-path/${encodeURIComponent(id || "new")}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cp),
    }),
    deleteCanonicalPath: id => jget(`/api/canonical-path/${encodeURIComponent(id)}`, { method: "DELETE" }),

    async ingestFiles(files) {
      // Upload each .gpx individually via the /api/ingest endpoint.
      const results = [];
      for (const f of files) {
        try {
          const ab = await f.arrayBuffer();
          const r = await fetch(`/api/ingest?filename=${encodeURIComponent(f.name)}`, {
            method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: ab,
          });
          if (!r.ok) throw new Error(`${r.status}`);
          const j = await r.json();
          results.push({ ok: true, file: f.name, ...j });
        } catch (err) {
          results.push({ ok: false, file: f.name, error: err.message });
        }
      }
      return { results };
    },
    ingestDialog: () => Promise.resolve({ results: [] }), // not available in HTTP mode

    // In HTTP mode exports are downloads from the server.
    exportSource: id => {
      window.location.href = `/api/source/${encodeURIComponent(id)}/export`;
      return Promise.resolve({ url: `/api/source/${encodeURIComponent(id)}/export` });
    },
    exportMerged: () => {
      window.location.href = `/api/export/merged`;
      return Promise.resolve({ url: `/api/export/merged` });
    },
    exportText: (defaultName, contents) => {
      const blob = new Blob([contents], { type: "application/gpx+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = defaultName || "export.gpx";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      return Promise.resolve({ path: defaultName });
    },

    openDatabase: () => Promise.resolve({ switched: false }),
    newDatabase: () => Promise.resolve({ switched: false }),
    onMenu: () => {},
    onDbSwitched: () => {},
  };
}

function ipcApi(e) {
  return {
    health: () => e.health(),
    sources: () => e.sources(),
    source: id => e.source(id),
    removeSource: id => e.removeSource(id),
    types: () => e.types(),
    match: (pair, sourceIds) => e.match(pair, sourceIds),
    anchorPairs: () => e.anchorPairs(),
    upsertAnchorPair: (id, pair) => e.upsertAnchorPair(id, pair),
    deleteAnchorPair: id => e.deleteAnchorPair(id),
    canonicalPaths: () => e.canonicalPaths(),
    upsertCanonicalPath: (id, cp) => e.upsertCanonicalPath(id, cp),
    deleteCanonicalPath: id => e.deleteCanonicalPath(id),
    async ingestFiles(files) {
      // Read each file in the renderer; ship bytes via IPC. Buffer is
      // structured-cloned across the boundary intact.
      const results = [];
      for (const f of files) {
        try {
          const u8 = new Uint8Array(await f.arrayBuffer());
          const res = await e.ingestBuffer(f.name, u8);
          results.push(res);
        } catch (err) {
          results.push({ ok: false, file: f.name, error: err.message });
        }
      }
      return { results };
    },
    ingestDialog: () => e.ingestDialog(),
    exportSource: id => e.exportSource(id),
    exportMerged: () => e.exportMerged(),
    exportText: (defaultName, contents) => e.exportText(defaultName, contents),
    openDatabase: () => e.openDatabase(),
    newDatabase: () => e.newDatabase(),
    onMenu: cb => e.onMenu(cb),
    onDbSwitched: cb => e.onDbSwitched(cb),
  };
}

export const api = electronApi ? ipcApi(electronApi) : httpApi();
