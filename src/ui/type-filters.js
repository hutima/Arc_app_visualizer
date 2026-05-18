// Dynamic type/category toggles. Rebuilt every time the set of known types changes.

import { colorForType } from "../map/palette.js";

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

export function createTypeFilters(rootEl, store, layerManager) {
  let typeColors = {};

  async function refreshColors() {
    typeColors = await window.api.listTypeColors();
  }

  function colorOf(t) {
    return typeColors[t] || colorForType(t);
  }

  function render() {
    const types = store.listTypes();
    if (!types.length) {
      rootEl.innerHTML = `<span class="muted">Load a GPX file to see type toggles.</span>`;
      return;
    }
    const rows = types.map(t => {
      const color = colorOf(t);
      const id = `tf_${btoa(unescape(encodeURIComponent(t || "_"))).replaceAll("=","")}`;
      const checked = store.isTypeVisible(t);
      return `
        <div class="typeRow">
          <input type="checkbox" id="${id}" data-type="${escapeHtml(t)}" ${checked ? "checked" : ""}>
          <span class="swatch" style="background:${color}"></span>
          <label for="${id}" class="mono">${escapeHtml(t || "(none)")}</label>
          <input type="color" class="typeColor" data-type="${escapeHtml(t)}" value="${color}">
        </div>`;
    }).join("");
    rootEl.innerHTML = `
      <div class="typeControls">
        <button class="tinyBtn" data-act="all">All</button>
        <button class="tinyBtn" data-act="none">None</button>
      </div>
      <div class="typeList">${rows}</div>`;

    rootEl.querySelectorAll(".tinyBtn").forEach(b => {
      b.addEventListener("click", () => {
        store.setAllTypesVisible(b.dataset.act === "all");
        render();
      });
    });
    rootEl.querySelectorAll('input[type="checkbox"][data-type]').forEach(cb => {
      cb.addEventListener("change", e => {
        store.setTypeVisible(e.target.dataset.type, e.target.checked);
      });
    });
    rootEl.querySelectorAll(".typeColor").forEach(cp => {
      cp.addEventListener("input", e => {
        const type = e.target.dataset.type;
        typeColors[type] = e.target.value;
        layerManager.setTypeColor(type, e.target.value);
        const sw = e.target.parentElement.querySelector(".swatch");
        if (sw) sw.style.background = e.target.value;
      });
    });
  }

  store.bus.on(store.EVT.typesChanged, render);
  store.bus.on(store.EVT.sourcesChanged, render);
  refreshColors().then(render);
  return { render, refreshColors };
}
