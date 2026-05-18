"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { openDatabase } = require("./db");
const { importGpxFiles } = require("./gpx-import");
const { writeStreamSource, writeStreamMerged } = require("./gpx-export");

let mainWindow = null;
let db = null;

function getDb() {
  if (!db) {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    db = openDatabase(dir);
  }
  return db;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "ARC GPX Visualizer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  if (process.env.ARC_DEV === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  getDb();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (db) { try { db.close(); } catch {} db = null; }
});

// ----------------- IPC handlers -----------------

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle("dialog:pickGpxFiles", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Select GPX files to import",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "GPX", extensions: ["gpx", "xml"] }, { name: "All files", extensions: ["*"] }],
  });
  if (r.canceled) return [];
  return r.filePaths;
});

ipcMain.handle("import:files", async (_e, paths) => {
  const d = getDb();
  return await importGpxFiles(d, paths, (ev) => broadcast("import:progress", ev));
});

ipcMain.handle("sources:list", () => getDb().listSources());

ipcMain.handle("sources:setVisible", (_e, { id, visible }) => {
  getDb().setSourceVisible(id, visible);
  return true;
});

ipcMain.handle("sources:remove", (_e, id) => {
  getDb().removeSource(id);
  return true;
});

ipcMain.handle("types:list", () => getDb().listTypes());
ipcMain.handle("types:listColors", () => getDb().listTypeColors());
ipcMain.handle("types:setColor", (_e, { type, color }) => { getDb().setTypeColor(type, color); return true; });

ipcMain.handle("bounds:overall", () => getDb().overallBounds());

ipcMain.handle("query:tracks", (_e, opts) => getDb().queryTracks(opts));
ipcMain.handle("query:waypoints", (_e, opts) => getDb().queryWaypoints(opts));

ipcMain.handle("export:merged", async (_e, { sourceIds }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "Export merged GPX",
    defaultPath: "merged.gpx",
    filters: [{ name: "GPX", extensions: ["gpx"] }],
  });
  if (r.canceled || !r.filePath) return { written: [] };
  await writeStreamMerged(getDb(), sourceIds, r.filePath);
  return { written: [r.filePath] };
});

ipcMain.handle("export:perFile", async (_e, { sourceIds }) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Choose folder to write per-file GPX exports",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths?.length) return { written: [] };
  const dir = r.filePaths[0];
  const d = getDb();
  const sources = d.listSources().filter(s => sourceIds.includes(s.id));
  const written = [];
  for (const s of sources) {
    const base = s.filename.replace(/\.gpx$/i, "") + ".roundtrip.gpx";
    const out = path.join(dir, base);
    await writeStreamSource(d, s.id, out);
    written.push(out);
  }
  return { written };
});

ipcMain.handle("shell:revealFile", (_e, p) => { shell.showItemInFolder(p); return true; });

ipcMain.handle("db:info", () => {
  const d = getDb();
  let size = null;
  try { size = fs.statSync(d.file).size; } catch {}
  return { file: d.file, size };
});
