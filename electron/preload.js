"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickGpxFiles:   ()         => ipcRenderer.invoke("dialog:pickGpxFiles"),
  importFiles:    (paths)    => ipcRenderer.invoke("import:files", paths),

  listSources:    ()         => ipcRenderer.invoke("sources:list"),
  setSourceVisible: (id, v)  => ipcRenderer.invoke("sources:setVisible", { id, visible: !!v }),
  removeSource:   (id)       => ipcRenderer.invoke("sources:remove", id),

  listTypes:      ()         => ipcRenderer.invoke("types:list"),
  listTypeColors: ()         => ipcRenderer.invoke("types:listColors"),
  setTypeColor:   (type, color) => ipcRenderer.invoke("types:setColor", { type, color }),

  overallBounds: ()          => ipcRenderer.invoke("bounds:overall"),
  queryTracks:    (opts)     => ipcRenderer.invoke("query:tracks", opts),
  queryWaypoints: (opts)     => ipcRenderer.invoke("query:waypoints", opts),

  exportMerged:  (sourceIds) => ipcRenderer.invoke("export:merged", { sourceIds }),
  exportPerFile: (sourceIds) => ipcRenderer.invoke("export:perFile", { sourceIds }),

  revealFile:    (p)         => ipcRenderer.invoke("shell:revealFile", p),
  dbInfo:        ()          => ipcRenderer.invoke("db:info"),

  onImportProgress(cb) {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on("import:progress", handler);
    return () => ipcRenderer.removeListener("import:progress", handler);
  },
};

contextBridge.exposeInMainWorld("api", api);
