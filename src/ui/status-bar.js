// Aggregate counts + last-status message at the bottom of the sidebar.

export function createStatusBar(rootEl, store) {
  let lastMessage = "";
  let lastClass = "muted";

  function render() {
    const s = store.stats();
    rootEl.innerHTML = `
      <div class="stats muted">
        sources <span class="mono">${s.sources}</span> -
        tracks <span class="mono">${s.trk.toLocaleString()}</span> -
        seg <span class="mono">${s.seg.toLocaleString()}</span> -
        pts <span class="mono">${s.pt.toLocaleString()}</span> -
        wpts <span class="mono">${s.wpt.toLocaleString()}</span>
      </div>
      <div class="msg ${lastClass}">${lastMessage || "&nbsp;"}</div>
    `;
  }

  store.bus.on(store.EVT.sourceAdded, render);
  store.bus.on(store.EVT.sourceRemoved, render);
  store.bus.on(store.EVT.sourcesChanged, render);
  render();
  return {
    setMessage(msg, cls) {
      lastMessage = msg;
      lastClass = cls || "muted";
      render();
    },
  };
}
