// Electron preload. Exposes a typed surface on window.electronAPI; the
// renderer never touches Node directly. CommonJS so Electron's preload
// loader (with sandbox: false on Electron 33) is happy regardless of the
// package.json "type": "module" outside this folder.

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("electronAPI", {
  // server / health
  health: () => invoke("health"),

  // sources
  sources: () => invoke("sources:list"),
  source: id => invoke("source:load", id),
  removeSource: id => invoke("source:remove", id),

  // matcher
  types: () => invoke("types"),
  match: (pair, sourceIds) => invoke("match", { pair, sourceIds }),

  // anchor pairs
  anchorPairs: () => invoke("anchorPairs:list"),
  upsertAnchorPair: (id, pair) => invoke("anchorPairs:upsert", { id, pair }),
  deleteAnchorPair: id => invoke("anchorPairs:delete", id),

  // canonical paths
  canonicalPaths: () => invoke("canonicalPaths:list"),
  upsertCanonicalPath: (id, cp) => invoke("canonicalPaths:upsert", { id, cp }),
  deleteCanonicalPath: id => invoke("canonicalPaths:delete", id),

  // ingest
  ingestDialog: () => invoke("ingest:dialog"),
  ingestPaths: paths => invoke("ingest:paths", paths),
  ingestBuffer: (filename, bytes) => invoke("ingest:buffer", { filename, bytes }),

  // export
  exportSource: id => invoke("export:source", id),
  exportMerged: () => invoke("export:merged"),
  exportText: (defaultName, contents) => invoke("export:writeText", { defaultName, contents }),

  // database
  openDatabase: () => invoke("db:open"),
  newDatabase: () => invoke("db:new"),

  // events from main process (menu items, db switches)
  onMenu: cb => {
    ipcRenderer.on("menu:open-import",   () => cb("open-import"));
    ipcRenderer.on("menu:open-database", () => cb("open-database"));
    ipcRenderer.on("menu:new-database",  () => cb("new-database"));
    ipcRenderer.on("menu:export-merged", () => cb("export-merged"));
  },
  onDbSwitched: cb => {
    ipcRenderer.on("db:switched", (_e, data) => cb(data));
  },
});
