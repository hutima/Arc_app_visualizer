// Renders the loaded-files list. Each row: visibility checkbox, filename, counts, remove.

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

export function createSourceList(rootEl, store) {
  function render() {
    const sources = store.listSources();
    if (!sources.length) {
      rootEl.innerHTML = `<span class="muted">No files loaded yet.</span>`;
      return;
    }
    rootEl.innerHTML = sources.map(s => {
      const visible = store.isSourceVisible(s.id);
      const counts = `trk ${s.trackCount} - seg ${s.segmentCount} - pts ${(s.pointCount || 0).toLocaleString()} - wpt ${s.waypointCount}`;
      return `
        <div class="srcRow" data-id="${s.id}">
          <input type="checkbox" class="srcToggle" ${visible ? "checked" : ""}>
          <div class="srcMeta">
            <div class="srcName" title="${escapeHtml(s.filename)}">${escapeHtml(s.filename)}</div>
            <div class="srcCounts muted">${counts}</div>
          </div>
          <button class="srcRemove" title="Remove">x</button>
        </div>`;
    }).join("");

    rootEl.querySelectorAll(".srcRow").forEach(row => {
      const id = Number(row.dataset.id);
      row.querySelector(".srcToggle").addEventListener("change", e => {
        store.setSourceVisible(id, e.target.checked);
      });
      row.querySelector(".srcRemove").addEventListener("click", () => {
        store.removeSource(id);
      });
    });
  }

  store.bus.on(store.EVT.sourceAdded, render);
  store.bus.on(store.EVT.sourceRemoved, render);
  store.bus.on(store.EVT.sourcesChanged, render);
  render();
  return { render };
}
