// Sidebar UI for canonical paths. Lists anchor pairs, hosts the create /
// edit flow, runs the matcher, drives the path drawer, applies edits.

import { findMatches } from "../matcher.js";
import { fromVertices, fromExemplarTrack, withVertices, lengthMeters, vertexCount } from "../canonical-path.js";
import { planApplyAll } from "../apply.js";
import { snapToRoads, suggestedProfile } from "../road-snap.js";

function esc(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function fmtMeters(m) {
  if (!Number.isFinite(m)) return "-";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}

function fmtCoord(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function formatTimeShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const wd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${wd} ${hh}:${mm}`;
}

function effectivePolylinesForMatch(match, editing, store) {
  const eff = editing.effectiveSource(match.sourceId) || store.getSource(match.sourceId);
  if (!eff) return [];
  const out = [];
  for (const tid of match.trackIds) {
    const t = eff.tracks.find(x => x.id === tid);
    if (!t) continue;
    for (const seg of t.segments) {
      if (seg.points.length < 2) continue;
      out.push(seg.points.map(p => [p.lat, p.lon]));
    }
  }
  return out;
}

export function createCanonicalCard(rootEl, store, editing, mapPicker, overlay, pathDrawer, statusBar) {
  let editingPairId = null;
  let cachedMatches = []; // for the active pair
  let pendingRoadSnap = false;

  function setStatus(msg, cls) { statusBar?.setMessage(msg, cls || "muted"); }

  function refreshOverlay() {
    overlay.clearAll();
    for (const pair of editing.listAnchorPairs()) {
      if (!pair.enabled) continue;
      const isActive = pair.id === editingPairId;
      overlay.showAnchors(pair, { active: isActive });
      const cp = editing.getCanonicalPath(pair.id);
      if (cp) overlay.showCanonical(pair, cp, { active: isActive });
    }
    if (editingPairId) {
      // Re-show matches/preview if any are cached.
      const pair = editing.getAnchorPair(editingPairId);
      if (pair && cachedMatches.length) {
        const enriched = cachedMatches.map(m => ({
          ...m,
          polylines: effectivePolylinesForMatch(m, editing, store),
        }));
        overlay.showMatches(enriched);
      }
    }
  }

  function recomputeMatches() {
    if (!editingPairId) return [];
    const pair = editing.getAnchorPair(editingPairId);
    if (!pair) return [];
    const matches = findMatches(store.listSources(), pair);
    cachedMatches = matches;
    return matches;
  }

  function render() {
    const pairs = editing.listAnchorPairs();

    if (editingPairId) {
      const pair = editing.getAnchorPair(editingPairId);
      if (!pair) {
        editingPairId = null;
        render();
        return;
      }
      renderEditPanel(pair);
      refreshOverlay();
      return;
    }

    rootEl.innerHTML = `
      <div class="cpList"></div>
      <div class="row" style="margin-top:8px">
        <button class="cpNew">+ New anchor pair</button>
      </div>
      <div class="muted tiny" style="margin-top:6px">
        Define two anchor points and a canonical path. Matching trips across
        every loaded GPX are rewritten to follow the canonical when you apply.
      </div>
    `;

    const list = rootEl.querySelector(".cpList");
    if (!pairs.length) {
      list.innerHTML = `<span class="muted">No anchor pairs yet.</span>`;
    } else {
      list.innerHTML = pairs.map(p => {
        const matches = findMatches(store.listSources(), p);
        const swatch = overlay.colorForPair(p.id);
        return `
          <div class="cpRow" data-id="${esc(p.id)}">
            <input type="checkbox" class="cpEnable" ${p.enabled ? "checked" : ""}>
            <span class="swatch" style="background:${swatch}"></span>
            <div class="cpMeta">
              <div class="cpName">${esc(p.label || "(unnamed)")}</div>
              <div class="cpCounts muted tiny">
                ${matches.length} match${matches.length === 1 ? "" : "es"}
                ${p.canonicalPathId ? "- canonical defined" : "- no canonical yet"}
              </div>
            </div>
            <button class="cpEdit" title="Edit">edit</button>
            <button class="cpRemove" title="Remove">x</button>
          </div>`;
      }).join("");
    }
    bindListEvents();
    bindNewButton();
    refreshOverlay();
  }

  function bindListEvents() {
    rootEl.querySelectorAll(".cpRow").forEach(row => {
      const id = row.dataset.id;
      row.querySelector(".cpEnable").addEventListener("change", e => {
        editing.setAnchorPairEnabled(id, e.target.checked);
      });
      row.querySelector(".cpEdit").addEventListener("click", () => {
        editingPairId = id;
        cachedMatches = [];
        render();
      });
      row.querySelector(".cpRemove").addEventListener("click", () => {
        if (confirm("Remove this anchor pair? Any applied edits from it will be undone.")) {
          editing.removeAnchorPair(id);
        }
      });
    });
  }

  function bindNewButton() {
    rootEl.querySelector(".cpNew")?.addEventListener("click", () => {
      const pair = editing.addAnchorPair({
        label: `Pair ${editing.listAnchorPairs().length}`,
        start: { lat: 0, lon: 0, radiusMeters: 150 },
        end: { lat: 0, lon: 0, radiusMeters: 150 },
        bidirectional: true,
        chainFragments: false,
        enabled: true,
      });
      editingPairId = pair.id;
      cachedMatches = [];
      render();
      setStatus("Pick start anchor on the map.", "muted");
    });
  }

  function renderEditPanel(pair) {
    const cp = editing.getCanonicalPath(pair.id);
    const matches = recomputeMatches();
    const opsCount = matches.length
      ? editing.opsForSource(matches[0].sourceId).filter(o => o.anchorPairId === pair.id).length
      : 0;
    const hasAnyEdits = editing.listOps().some(o => o.anchorPairId === pair.id);

    rootEl.innerHTML = `
      <div class="cpEditHeader">
        <button class="cpBack tinyBtn">&lt; back</button>
        <strong>${esc(pair.label || "Pair")}</strong>
      </div>
      <label class="cpField">Label
        <input type="text" class="cpLabel" value="${esc(pair.label || "")}">
      </label>

      <div class="cpField">
        <div class="cpSubhead">Start anchor</div>
        <div class="row">
          <button class="cpPickStart">${pair.start.lat || pair.start.lon ? "re-pick" : "pick on map"}</button>
          <span class="muted tiny">${pair.start.lat || pair.start.lon ? fmtCoord(pair.start.lat, pair.start.lon) : "(not set)"}</span>
        </div>
        <div class="row" style="margin-top:4px">
          <label>radius
            <input type="number" class="cpStartR" min="10" max="5000" step="10" value="${pair.start.radiusMeters}"> m
          </label>
          <label>label
            <input type="text" class="cpStartLabel" value="${esc(pair.start.label || "")}" style="width:9em">
          </label>
        </div>
      </div>

      <div class="cpField">
        <div class="cpSubhead">End anchor</div>
        <div class="row">
          <button class="cpPickEnd">${pair.end.lat || pair.end.lon ? "re-pick" : "pick on map"}</button>
          <span class="muted tiny">${pair.end.lat || pair.end.lon ? fmtCoord(pair.end.lat, pair.end.lon) : "(not set)"}</span>
        </div>
        <div class="row" style="margin-top:4px">
          <label>radius
            <input type="number" class="cpEndR" min="10" max="5000" step="10" value="${pair.end.radiusMeters}"> m
          </label>
          <label>label
            <input type="text" class="cpEndLabel" value="${esc(pair.end.label || "")}" style="width:9em">
          </label>
        </div>
      </div>

      <div class="cpField">
        <label><input type="checkbox" class="cpBidir" ${pair.bidirectional ? "checked" : ""}> match reverse direction</label>
      </div>
      <div class="cpField">
        <label><input type="checkbox" class="cpChain" ${pair.chainFragments ? "checked" : ""}> chain fragmented tracks</label>
        <label class="cpChainGap" style="margin-left:8px">gap
          <input type="number" class="cpChainGapInput" min="0" max="3600" step="10" value="${pair.chainGapSec ?? 180}"> s
        </label>
      </div>
      <div class="cpField">
        <div class="cpSubhead">Filters (optional)</div>
        <label>types
          <input type="text" class="cpTypes" placeholder="metro, train" value="${esc((pair.filters?.includeTypes || []).join(", "))}" style="width:14em">
        </label>
      </div>

      <div class="cpField">
        <div class="cpSubhead">Matches: ${matches.length}</div>
        <div class="cpMatchList">${renderMatchList(matches)}</div>
      </div>

      <div class="cpField">
        <div class="cpSubhead">Canonical path: ${cp
          ? `${esc(cp.origin)}, ${vertexCount(cp)} vertices, ${fmtMeters(lengthMeters(cp))}`
          : "(none)"}</div>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <button class="cpDraw">${cp ? "redraw" : "draw on map"}</button>
          <button class="cpExemplar" ${matches.length ? "" : "disabled"}>use exemplar...</button>
          <button class="cpSnap" ${cp ? "" : "disabled"}>snap to OSM road</button>
        </div>
      </div>

      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:6px">
        <button class="cpApply primary" ${cp && matches.length ? "" : "disabled"}>apply (${matches.length})</button>
        <button class="cpUndo" ${hasAnyEdits ? "" : "disabled"}>undo last</button>
      </div>
      <div class="muted tiny cpEditNote">
        ${hasAnyEdits ? `${opsCount} op(s) for the first matched source via this pair.` : "&nbsp;"}
      </div>
    `;

    bindEditPanel(pair);
  }

  function renderMatchList(matches) {
    if (!matches.length) return `<span class="muted tiny">No matches yet. Set both anchors.</span>`;
    return matches.slice(0, 50).map(m => {
      const src = store.getSource(m.sourceId);
      const filename = src?.filename || m.sourceId;
      const t = formatTimeShort(m.robustStart.time);
      const dir = m.direction === "reverse" ? "<- reverse" : "-> forward";
      const chained = m.chained ? ` (chain x${m.trackIds.length})` : "";
      return `<div class="cpMatch tiny mono" data-source="${esc(m.sourceId)}" data-tracks="${esc(m.trackIds.join(","))}">
        ${esc(t || "(no time)")} ${esc(dir)}${esc(chained)}
        <span class="muted">${esc(filename)}</span>
      </div>`;
    }).join("") + (matches.length > 50 ? `<div class="muted tiny">+${matches.length - 50} more</div>` : "");
  }

  function bindEditPanel(pair) {
    rootEl.querySelector(".cpBack").addEventListener("click", () => {
      editingPairId = null;
      cachedMatches = [];
      render();
    });

    const $ = sel => rootEl.querySelector(sel);

    $(".cpLabel").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { label: e.target.value });
    });
    $(".cpStartR").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { start: { radiusMeters: Number(e.target.value) || 150 } });
    });
    $(".cpEndR").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { end: { radiusMeters: Number(e.target.value) || 150 } });
    });
    $(".cpStartLabel").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { start: { label: e.target.value } });
    });
    $(".cpEndLabel").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { end: { label: e.target.value } });
    });
    $(".cpBidir").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { bidirectional: e.target.checked });
    });
    $(".cpChain").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { chainFragments: e.target.checked });
    });
    $(".cpChainGapInput").addEventListener("change", e => {
      editing.updateAnchorPair(pair.id, { chainGapSec: Math.max(0, Number(e.target.value) || 180) });
    });
    $(".cpTypes").addEventListener("change", e => {
      const raw = (e.target.value || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      editing.updateAnchorPair(pair.id, {
        filters: raw.length ? { ...pair.filters, includeTypes: raw } : (pair.filters
          ? { ...pair.filters, includeTypes: undefined } : undefined),
      });
    });

    $(".cpPickStart").addEventListener("click", async () => {
      setStatus("Click the map to set the start anchor center.", "muted");
      const p = await mapPicker.pickPoint();
      if (p) {
        editing.updateAnchorPair(pair.id, { start: { lat: p.lat, lon: p.lon } });
        setStatus("Start anchor set.", "ok");
      } else {
        setStatus("Pick cancelled.", "muted");
      }
    });

    $(".cpPickEnd").addEventListener("click", async () => {
      setStatus("Click the map to set the end anchor center.", "muted");
      const p = await mapPicker.pickPoint();
      if (p) {
        editing.updateAnchorPair(pair.id, { end: { lat: p.lat, lon: p.lon } });
        setStatus("End anchor set.", "ok");
      } else {
        setStatus("Pick cancelled.", "muted");
      }
    });

    $(".cpDraw").addEventListener("click", () => {
      setStatus("Click to add vertex. u=undo, s=snap, Enter=commit, Esc=cancel.", "muted");
      const snapPolylines = matchPolylinesForSnap();
      const cp = editing.getCanonicalPath(pair.id);
      pathDrawer.start({
        initialVertices: cp?.vertices || [],
        snap: false,
        snapPolylines,
        colorHint: overlay.colorForPair(pair.id),
        onCommit: verts => {
          const cur = editing.getCanonicalPath(pair.id);
          const next = cur
            ? withVertices(cur, verts, "drawn")
            : fromVertices(verts, pair.id);
          editing.setCanonicalPath(pair.id, next);
          setStatus(`Canonical: ${verts.length} vertices, ${fmtMeters(lengthMeters(next))}.`, "ok");
        },
        onCancel: () => setStatus("Drawing cancelled.", "muted"),
        onUpdate: () => {
          // No-op; overlay handles render. Could update a live counter.
        },
      });
    });

    $(".cpExemplar").addEventListener("click", async () => {
      if (!cachedMatches.length) return;
      const candidates = cachedMatches.map(m => {
        const polys = effectivePolylinesForMatch(m, editing, store);
        const merged = polys.flat();
        return {
          id: `${m.sourceId}|${m.trackIds.join(",")}`,
          latlngs: merged,
          _m: m,
        };
      }).filter(c => c.latlngs.length >= 2);
      setStatus("Click a candidate track to adopt its geometry.", "muted");
      const picked = await mapPicker.pickTrack(candidates);
      if (!picked) { setStatus("Exemplar pick cancelled.", "muted"); return; }
      const c = candidates.find(x => x.id === picked);
      if (!c) return;
      const m = c._m;
      // Build canonical from the FIRST track in the chain (primary).
      const src = editing.effectiveSource(m.sourceId) || store.getSource(m.sourceId);
      const primary = src.tracks.find(t => t.id === m.trackIds[0]);
      if (!primary) return;
      const next = fromExemplarTrack(primary, pair.id);
      editing.setCanonicalPath(pair.id, next);
      setStatus(`Adopted ${primary.id} as canonical (${vertexCount(next)} vertices).`, "ok");
    });

    $(".cpSnap").addEventListener("click", async () => {
      if (pendingRoadSnap) return;
      const current = editing.getCanonicalPath(pair.id);
      if (!current) return;
      pendingRoadSnap = true;
      setStatus("Calling OSRM map-matching...", "muted");
      const profile = suggestedProfile(pair.filters?.includeTypes?.[0]) || "driving";
      const res = await snapToRoads(current.vertices, profile);
      pendingRoadSnap = false;
      if (res.ok) {
        const next = {
          ...current,
          vertices: res.vertices,
          origin: "road-snapped",
          preSnapVertices: current.preSnapVertices || current.vertices.slice(),
          updatedAt: Date.now(),
        };
        editing.setCanonicalPath(pair.id, next);
        setStatus(`Snapped to OSM ${profile} (${res.vertices.length} vertices).`, "ok");
      } else {
        setStatus(`OSM snap unavailable (${res.reason}). Keeping user-drawn path.`, "warn");
      }
    });

    $(".cpApply").addEventListener("click", () => {
      const cp = editing.getCanonicalPath(pair.id);
      const matches = recomputeMatches();
      if (!cp || !matches.length) return;
      const sourceById = new Map(store.listSources().map(s => [s.id, s]));
      const ops = planApplyAll(cp, matches, sourceById, { anchorPairId: pair.id });
      if (!ops.length) { setStatus("Nothing to apply.", "warn"); return; }
      editing.applyEdits(ops);
      setStatus(`Applied canonical to ${matches.length} trip(s) via ${ops.length} op(s).`, "ok");
    });

    $(".cpUndo").addEventListener("click", () => {
      if (editing.undoLast()) setStatus("Undid last apply.", "ok");
    });

    rootEl.querySelectorAll(".cpMatch").forEach(row => {
      row.addEventListener("click", () => {
        const sid = row.dataset.source;
        const tids = row.dataset.tracks.split(",");
        const eff = editing.effectiveSource(sid);
        if (!eff) return;
        const b = L.latLngBounds([]);
        for (const tid of tids) {
          const t = eff.tracks.find(x => x.id === tid);
          if (!t) continue;
          for (const seg of t.segments) for (const p of seg.points) b.extend([p.lat, p.lon]);
        }
        if (b.isValid()) {
          // Note: caller (main.js) drives the map; we use the leaflet object via overlay.
          // Reach for the same `mapView.raw` via the picker controller.
          // Cheap workaround: invoke a Leaflet method through any layer's map.
          const anyLayer = overlay.colorForPair && overlay; // typeof check; we use raw below.
          // Better: ask the map. We don't have a direct handle; just dispatch a CustomEvent.
          rootEl.dispatchEvent(new CustomEvent("cp:fit", { bubbles: true, detail: { bounds: b } }));
        }
      });
    });
  }

  function matchPolylinesForSnap() {
    if (!cachedMatches.length) return [];
    return cachedMatches.flatMap(m => effectivePolylinesForMatch(m, editing, store))
      .map(latlngs => latlngs.map(([lat, lon]) => L.latLng(lat, lon)));
  }

  // Subscribe to bus events. Anchor / canonical / edits changes => rerender.
  store.bus.on(store.EVT.anchorsChanged, () => { render(); refreshOverlay(); });
  store.bus.on(store.EVT.canonicalChanged, () => { render(); refreshOverlay(); });
  store.bus.on(store.EVT.editsChanged, () => { render(); refreshOverlay(); });
  store.bus.on(store.EVT.sourceAdded, () => { render(); refreshOverlay(); });
  store.bus.on(store.EVT.sourceRemoved, () => { render(); refreshOverlay(); });

  render();
  refreshOverlay();

  return { render, refreshOverlay };
}
