// Internal model -> GPX 1.1 XML string.
// Round-trip-safe: any preserved `extras` elements are re-emitted verbatim.

const NS = "http://www.topografix.com/GPX/1/1";

function el(doc, name, attrs, children) {
  const e = doc.createElementNS(NS, name);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  if (children) for (const c of children) if (c != null) e.appendChild(c);
  return e;
}
function textEl(doc, name, text) {
  const e = doc.createElementNS(NS, name);
  e.appendChild(doc.createTextNode(String(text)));
  return e;
}

function importExtras(doc, extras) {
  if (!extras) return [];
  return extras.map(node => doc.importNode(node, true));
}

/**
 * @param {import("../model/types.js").Source} source
 * @returns {string} pretty-ish XML string with leading <?xml prolog
 */
export function serializeSource(source) {
  // Build the doc via DOMParser so we don't depend on `document.implementation`
  // (keeps the module testable in non-browser environments).
  const doc = new DOMParser().parseFromString(
    `<gpx xmlns="${NS}"></gpx>`,
    "application/xml"
  );
  const gpx = doc.documentElement;

  // Restore root attributes, defaulting to a sane minimum.
  const attrs = source.rootAttrs || {};
  if (!attrs.version) gpx.setAttribute("version", "1.1");
  if (!attrs["xmlns:xsi"]) gpx.setAttribute("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance");
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "xmlns") continue; // already on the element via createDocument
    gpx.setAttribute(k, v);
  }
  if (source.creator && !gpx.getAttribute("creator")) gpx.setAttribute("creator", source.creator);

  for (const node of importExtras(doc, source.extras)) gpx.appendChild(node);

  for (const w of source.waypoints) {
    const wpt = el(doc, "wpt", { lat: w.lat, lon: w.lon });
    if (w.time) wpt.appendChild(textEl(doc, "time", w.time));
    if (w.name) wpt.appendChild(textEl(doc, "name", w.name));
    for (const x of importExtras(doc, w.extras)) wpt.appendChild(x);
    gpx.appendChild(wpt);
  }

  for (const t of source.tracks) {
    const trk = el(doc, "trk");
    if (t.name) trk.appendChild(textEl(doc, "name", t.name));
    const typeStr = t.rawType ?? t.type;
    if (typeStr) trk.appendChild(textEl(doc, "type", typeStr));
    for (const x of importExtras(doc, t.extras)) trk.appendChild(x);
    for (const s of t.segments) {
      const seg = el(doc, "trkseg");
      for (const p of s.points) {
        const pt = el(doc, "trkpt", { lat: p.lat, lon: p.lon });
        if (p.ele != null) pt.appendChild(textEl(doc, "ele", p.ele));
        if (p.time) pt.appendChild(textEl(doc, "time", p.time));
        seg.appendChild(pt);
      }
      for (const x of importExtras(doc, s.extras)) seg.appendChild(x);
      trk.appendChild(seg);
    }
    gpx.appendChild(trk);
  }

  // XMLSerializer exists in every browser; linkedom (used in tests) exposes
  // `.toString()` on Document instead, so fall back to that for portability.
  const body = (typeof XMLSerializer !== "undefined")
    ? new XMLSerializer().serializeToString(doc)
    : doc.toString().replace(/^<\?xml[^?]*\?>\s*/i, "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

/**
 * Combine multiple sources into a single GPX file. Tracks are emitted as separate
 * <trk> nodes (never flattened) so importers can keep them apart.
 * @param {import("../model/types.js").Source[]} sources
 */
export function serializeMerged(sources) {
  if (!sources.length) throw new Error("No sources to merge.");
  const merged = {
    id: "merged",
    filename: "merged.gpx",
    importedAt: Date.now(),
    creator: sources[0].creator,
    rootAttrs: sources[0].rootAttrs,
    tracks: sources.flatMap(s => s.tracks),
    waypoints: sources.flatMap(s => s.waypoints),
    extras: sources[0].extras,
  };
  return serializeSource(merged);
}
