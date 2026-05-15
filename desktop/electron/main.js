// Electron main-process entry. The app is self-contained: SQLite lives
// inside the OS user-data directory, GPX ingest runs in the main process
// against the existing parser, the renderer is the same Leaflet UI the
// browser uses. No HTTP server, no network.

import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import "../dom-shim.js";
import { openDb, closeDb } from "../db.js";
import {
  listSourcesSummary, listTypesSummary, loadFullSource, deleteSource,
  listAnchorPairs, upsertAnchorPair, deleteAnchorPair,
  listCanonicalPaths, upsertCanonicalPath, deleteCanonicalPath,
} from "../queries.js";
import { ingestFile, insertSource } from "../source-loader.js";
import { parseGpx } from "../../src/parser/gpx-parser.js";
import { findMatches } from "../../src/editing/canonical-path/matcher.js";
import { serializeSource, serializeMerged } from "../../src/serializer/gpx-serializer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ELECTRON_ROOT = __dirname;
const DESKTOP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..");

let mainWindow = null;
let db = null;
let dbPath = null;

function defaultDbPath() {
  return join(app.getPath("userData"), "arc.db");
}

async function openDbAt(path) {
  if (db) { closeDb(); db = null; }
  await mkdir(dirname(path), { recursive: true });
  db = openDb(path);
  db.cwdPath = path;
  dbPath = path;
  return db;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "ARC GPX Visualizer",
    webPreferences: {
      preload: join(ELECTRON_ROOT, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL("app://-/desktop/web/desktop.html");
  // Pipe renderer console to stdout so users can diagnose without opening
  // DevTools. Suppress noisy warnings (Leaflet emits a few).
  mainWindow.webContents.on("console-message", (e, level, msg) => {
    if (level === 0) return; // verbose
    const prefix = ["log", "info", "warn", "error"][Math.min(level, 3)] || "log";
    console.log(`[renderer:${prefix}] ${msg}`);
  });
}

// ---------- protocol: app://-/<repo-relative-path> ----------

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol() {
  protocol.handle("app", req => {
    const u = new URL(req.url);
    let path = decodeURIComponent(u.pathname || "/");
    if (path === "/" || path === "") path = "/desktop/web/desktop.html";
    // Resolve under REPO_ROOT and refuse anything that escapes it.
    const abs = resolve(REPO_ROOT, "." + path);
    if (!abs.startsWith(REPO_ROOT)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(abs).toString());
  });
}

// ---------- IPC handlers ----------

function registerIpc() {
  ipcMain.handle("health", () => ({
    ok: true, dbPath, mode: "electron",
    sqlite: db.prepare("SELECT sqlite_version() v").get().v,
  }));

  ipcMain.handle("sources:list", () => listSourcesSummary(db));
  ipcMain.handle("source:load", (_e, id) => loadFullSource(db, id));
  ipcMain.handle("source:remove", (_e, id) => { deleteSource(db, id); return { ok: true }; });
  ipcMain.handle("types", () => listTypesSummary(db));

  ipcMain.handle("match", (_e, { pair, sourceIds }) => {
    const ids = (sourceIds && sourceIds.length)
      ? sourceIds
      : listSourcesSummary(db).map(s => s.id);
    const sources = ids.map(id => loadFullSource(db, id)).filter(Boolean);
    return findMatches(sources, pair);
  });

  ipcMain.handle("anchorPairs:list", () => listAnchorPairs(db));
  ipcMain.handle("anchorPairs:upsert", (_e, { id, pair }) => {
    const finalId = (!id || id === "new") ? `ap_${randomUUID()}` : id;
    const stored = { ...pair, id: finalId, createdAt: pair.createdAt || Date.now() };
    upsertAnchorPair(db, stored);
    return stored;
  });
  ipcMain.handle("anchorPairs:delete", (_e, id) => { deleteAnchorPair(db, id); return { ok: true }; });

  ipcMain.handle("canonicalPaths:list", () => listCanonicalPaths(db));
  ipcMain.handle("canonicalPaths:upsert", (_e, { id, cp }) => {
    const finalId = (!id || id === "new") ? `cp_${randomUUID()}` : id;
    const stored = { ...cp, id: finalId, updatedAt: cp.updatedAt || Date.now() };
    upsertCanonicalPath(db, stored);
    return stored;
  });
  ipcMain.handle("canonicalPaths:delete", (_e, id) => { deleteCanonicalPath(db, id); return { ok: true }; });

  ipcMain.handle("ingest:dialog", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Import GPX files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "GPX", extensions: ["gpx"] }],
    });
    if (r.canceled) return { results: [] };
    return ingestPaths(r.filePaths);
  });

  ipcMain.handle("ingest:paths", (_e, paths) => ingestPaths(paths));

  ipcMain.handle("ingest:buffer", (_e, { filename, bytes }) => {
    const xml = Buffer.from(bytes).toString("utf-8");
    const source = parseGpx(xml, filename);
    const id = insertSource(source, db);
    return { ok: true, file: filename, sourceId: id };
  });

  ipcMain.handle("export:writeText", async (_e, { defaultName, contents }) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "Save GPX",
      defaultPath: defaultName || "export.gpx",
      filters: [{ name: "GPX", extensions: ["gpx"] }],
    });
    if (r.canceled) return { canceled: true };
    await writeFile(r.filePath, contents, "utf-8");
    return { path: r.filePath, bytes: contents.length };
  });

  ipcMain.handle("export:source", async (_e, id) => {
    const src = loadFullSource(db, id);
    if (!src) throw new Error("source not found");
    const xml = serializeSource(src);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "Export GPX",
      defaultPath: src.filename,
      filters: [{ name: "GPX", extensions: ["gpx"] }],
    });
    if (r.canceled) return { canceled: true };
    await writeFile(r.filePath, xml, "utf-8");
    return { path: r.filePath, bytes: xml.length };
  });

  ipcMain.handle("export:merged", async () => {
    const summaries = listSourcesSummary(db);
    if (!summaries.length) throw new Error("no sources");
    const sources = summaries.map(s => loadFullSource(db, s.id)).filter(Boolean);
    const xml = serializeMerged(sources);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "Export merged GPX",
      defaultPath: "merged.gpx",
      filters: [{ name: "GPX", extensions: ["gpx"] }],
    });
    if (r.canceled) return { canceled: true };
    await writeFile(r.filePath, xml, "utf-8");
    return { path: r.filePath, bytes: xml.length };
  });

  ipcMain.handle("db:open", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Open SQLite database",
      properties: ["openFile", "createDirectory", "showHiddenFiles"],
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths.length) return { switched: false };
    await openDbAt(r.filePaths[0]);
    mainWindow.webContents.send("db:switched", { dbPath });
    return { switched: true, dbPath };
  });

  ipcMain.handle("db:new", async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "New SQLite database",
      defaultPath: "arc.db",
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (r.canceled || !r.filePath) return { switched: false };
    await openDbAt(r.filePath);
    mainWindow.webContents.send("db:switched", { dbPath });
    return { switched: true, dbPath };
  });
}

async function ingestPaths(paths) {
  const results = [];
  for (const p of paths) {
    try {
      const res = await ingestFile(p, db);
      results.push({ ok: true, file: basename(p), ...res });
    } catch (e) {
      results.push({ ok: false, file: basename(p), error: e.message });
    }
  }
  return { results };
}

// ---------- Menu ----------

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Import GPX...",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu:open-import"),
        },
        { type: "separator" },
        {
          label: "Open Database...",
          click: () => mainWindow?.webContents.send("menu:open-database"),
        },
        {
          label: "New Database...",
          click: () => mainWindow?.webContents.send("menu:new-database"),
        },
        { type: "separator" },
        {
          label: "Export Merged GPX...",
          click: () => mainWindow?.webContents.send("menu:export-merged"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------- App lifecycle ----------

app.whenReady().then(async () => {
  registerAppProtocol();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  await openDbAt(defaultDbPath());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (db) closeDb();
});
