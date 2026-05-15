// GPX DOM -> internal model.
//
// Design notes:
// - We use getElementsByTagNameNS("*", ...) so the same code works for unprefixed and
//   prefixed GPX documents.
// - Unknown child elements are preserved on the model object's `extras` slot. The
//   serializer re-emits them verbatim, so this parser is round-trip-safe for any GPX
//   we don't explicitly understand (e.g. <extensions>, <link>, <metadata>, <rte>).
// - The parser is pure: same input -> same output, no IO, no globals besides id counter.

import { nextId } from "../core/id.js";

const KNOWN_GPX_CHILDREN = new Set(["wpt", "trk", "metadata"]); // metadata kept under source.extras
const KNOWN_TRK_CHILDREN = new Set(["name", "type", "trkseg"]);
const KNOWN_TRKSEG_CHILDREN = new Set(["trkpt"]);
const KNOWN_TRKPT_CHILDREN = new Set(["ele", "time"]);
const KNOWN_WPT_CHILDREN = new Set(["name", "time"]);

function directChildElements(parent) {
  const out = [];
  for (const n of parent.childNodes) if (n.nodeType === 1) out.push(n);
  return out;
}

function childByLocalName(parent, localName) {
  for (const n of parent.childNodes) {
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

function textOfChild(parent, localName) {
  const el = childByLocalName(parent, localName);
  return el ? (el.textContent || "").trim() : "";
}

function collectExtras(parent, knownSet) {
  const extras = [];
  for (const n of parent.childNodes) {
    if (n.nodeType === 1 && !knownSet.has(n.localName)) extras.push(n);
  }
  return extras.length ? extras : undefined;
}

export class GpxParseError extends Error {
  constructor(msg, file) { super(msg); this.file = file; }
}

/**
 * Parse a GPX XML string into a Source object.
 * @param {string} xmlText
 * @param {string} filename
 * @returns {import("../model/types.js").Source}
 */
export function parseGpx(xmlText, filename) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const perr = doc.getElementsByTagName("parsererror")[0];
  if (perr) throw new GpxParseError(perr.textContent.trim(), filename);

  const gpx = doc.documentElement;
  if (!gpx || gpx.localName !== "gpx") {
    throw new GpxParseError("Root element is not <gpx>.", filename);
  }

  const rootAttrs = {};
  for (const a of gpx.attributes) rootAttrs[a.name] = a.value;
  const creator = gpx.getAttribute("creator") || undefined;

  const sourceId = nextId("src");

  /** @type {import("../model/types.js").Waypoint[]} */
  const waypoints = [];
  for (const wpt of gpx.getElementsByTagNameNS("*", "wpt")) {
    // Skip waypoints that aren't direct children of <gpx>; ARC only emits them at top level
    // but a malformed merge could nest them. We still take all to be lenient.
    const lat = Number(wpt.getAttribute("lat"));
    const lon = Number(wpt.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    waypoints.push({
      id: nextId("wpt"),
      sourceId,
      lat,
      lon,
      name: textOfChild(wpt, "name") || undefined,
      time: textOfChild(wpt, "time") || undefined,
      extras: collectExtras(wpt, KNOWN_WPT_CHILDREN),
    });
  }

  /** @type {import("../model/types.js").Track[]} */
  const tracks = [];
  for (const trk of gpx.getElementsByTagNameNS("*", "trk")) {
    const trackId = nextId("trk");
    const rawType = textOfChild(trk, "type");
    /** @type {import("../model/types.js").Segment[]} */
    const segments = [];
    for (const seg of trk.getElementsByTagNameNS("*", "trkseg")) {
      const segId = nextId("seg");
      /** @type {import("../model/types.js").Point[]} */
      const points = [];
      for (const pt of seg.getElementsByTagNameNS("*", "trkpt")) {
        const lat = Number(pt.getAttribute("lat"));
        const lon = Number(pt.getAttribute("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const eleText = textOfChild(pt, "ele");
        const time = textOfChild(pt, "time") || undefined;
        const p = { lat, lon };
        if (eleText) {
          const ele = Number(eleText);
          if (Number.isFinite(ele)) p.ele = ele;
        }
        if (time) p.time = time;
        points.push(p);
      }
      segments.push({
        id: segId,
        trackId,
        points,
        extras: collectExtras(seg, KNOWN_TRKSEG_CHILDREN),
      });
    }
    tracks.push({
      id: trackId,
      sourceId,
      name: textOfChild(trk, "name") || undefined,
      type: rawType.toLowerCase(),
      rawType: rawType || undefined,
      segments,
      extras: collectExtras(trk, KNOWN_TRK_CHILDREN),
    });
  }

  return {
    id: sourceId,
    filename,
    importedAt: Date.now(),
    creator,
    rootAttrs,
    tracks,
    waypoints,
    extras: collectExtras(gpx, KNOWN_GPX_CHILDREN),
  };
}
