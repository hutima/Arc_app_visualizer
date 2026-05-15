// Sidebar "Library" card. Lists every source the server knows about with a
// per-row "load / unload" toggle so the browser only holds parsed Sources
// for what the user is actively inspecting. This is the key affordance for
// big-corpus workflows: 200 weekly files are listed cheaply by metadata,
// the user clicks 3 to load into the map.

import { api } from "./api-client.js";

function esc(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function fmtPts(n) {
  if (n == null) return "?";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1000) + "k";
  return String(n);
}

export function createLibrary(rootEl, store, statusBar) {
  /** @type {Map<string, {filename:string, trackCount:number, pointCount:number, waypointCount:number, bbox:[number,number,number,number]|null}>} */
  const catalog = new Map();
  /** @type {Set<string>} */
  const loaded = new Set();

  async function refresh() {
    try {
      const rows = await api.sources();
      catalog.clear();
      for (const r of rows) catalog.set(r.id, r);
      // Drop loaded ids that no longer exist on the server.
      for (const id of [...loaded]) {
        if (!catalog.has(id)) { loaded.delete(id); store.removeSource(id); }
      }
      render();
    } catch (e) {
      statusBar.setMessage(`Library refresh failed: ${e.message}`, "warn");
    }
  }

  async function ingestFiles(files) {
    if (!files?.length) return;
    statusBar.setMessage(`Ingesting ${files.length} file(s)...`, "muted");
    const { results } = await api.ingestFiles(files);
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    statusBar.setMessage(`Ingested ${ok}, failed ${failed}.`, failed ? "warn" : "ok");
    await refresh();
  }

  async function ingestDialog() {
    const { results } = await api.ingestDialog();
    if (!results?.length) return;
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    statusBar.setMessage(`Ingested ${ok}, failed ${failed}.`, failed ? "warn" : "ok");
    await refresh();
  }

  async function load(id) {
    if (loaded.has(id)) return;
    statusBar.setMessage(`Loading ${catalog.get(id)?.filename || id}...`, "muted");
    try {
      const src = await api.source(id);
      if (!src) throw new Error("not found");
      store.addSource(src);
      loaded.add(id);
      statusBar.setMessage(`Loaded ${src.filename}.`, "ok");
      render();
    } catch (e) {
      statusBar.setMessage(`Load failed: ${e.message}`, "warn");
    }
  }

  function unload(id) {
    if (!loaded.has(id)) return;
    store.removeSource(id);
    loaded.delete(id);
    statusBar.setMessage("Unloaded source.", "muted");
    render();
  }

  async function remove(id) {
    const name = catalog.get(id)?.filename || id;
    if (!confirm(`Delete ${name} from the database? This cannot be undone.`)) return;
    try {
      await api.removeSource(id);
      unload(id);
      catalog.delete(id);
      statusBar.setMessage(`Removed ${name} from server.`, "ok");
      render();
    } catch (e) {
      statusBar.setMessage(`Delete failed: ${e.message}`, "warn");
    }
  }

  function isLoaded(id) { return loaded.has(id); }
  function loadedIds() { return [...loaded]; }
  function unloadAll() {
    for (const id of [...loaded]) unload(id);
  }

  function render() {
    if (!catalog.size) {
      rootEl.innerHTML = `<span class="muted tiny">Database is empty. Ingest GPX files or upload below.</span>`;
      return;
    }
    const rows = [...catalog.values()].map(r => {
      const isOn = loaded.has(r.id);
      return `
        <div class="libRow ${isOn ? "loaded" : "unloaded"}" data-id="${esc(r.id)}">
          <button class="libToggleLoad" title="${isOn ? "Unload" : "Load"}">${isOn ? "-" : "+"}</button>
          <span class="swatch" style="background:${isOn ? "var(--accent)" : "transparent"};border-color:var(--line)"></span>
          <div class="libMeta">
            <div class="libName" title="${esc(r.filename)}">${esc(r.filename)}</div>
            <div class="libCounts muted">trk ${r.trackCount} - pts ${fmtPts(r.pointCount)} - wpt ${r.waypointCount}</div>
          </div>
          <button class="libRemove" title="Delete from server">x</button>
        </div>`;
    }).join("");
    rootEl.innerHTML = rows;
    rootEl.querySelectorAll(".libRow").forEach(row => {
      const id = row.dataset.id;
      row.querySelector(".libToggleLoad").addEventListener("click", () => {
        loaded.has(id) ? unload(id) : load(id);
      });
      row.querySelector(".libRemove").addEventListener("click", () => remove(id));
    });
  }

  refresh();
  return { refresh, load, unload, remove, unloadAll, isLoaded, loadedIds, catalog, ingestFiles, ingestDialog };
}
