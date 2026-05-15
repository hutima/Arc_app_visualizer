// Internal data model typedefs (JSDoc; no runtime classes so modules stay simple).
//
// Three logical state layers - the parser owns the first, the store owns the second,
// the map's layer-manager owns the third. They share these shapes.

/**
 * @typedef {Object} Point
 * @property {number} lat
 * @property {number} lon
 * @property {number} [ele]            meters; ARC may emit negative values
 * @property {string} [time]           ISO-8601 UTC string as written in GPX
 * @property {Date}   [timeDate]       lazy-parsed Date, may be set by consumers
 */

/**
 * @typedef {Object} Segment
 * @property {string} id
 * @property {string} trackId
 * @property {Point[]} points
 * @property {Element[]} [extras]      unknown child nodes preserved verbatim for round-trip
 */

/**
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} sourceId
 * @property {string} [name]
 * @property {string} type             canonical key, lowercased, "" if absent
 * @property {string} [rawType]        original cased value as written
 * @property {Segment[]} segments
 * @property {Element[]} [extras]
 */

/**
 * @typedef {Object} Waypoint
 * @property {string} id
 * @property {string} sourceId
 * @property {number} lat
 * @property {number} lon
 * @property {string} [name]
 * @property {string} [time]
 * @property {Element[]} [extras]
 */

/**
 * @typedef {Object} Source
 * @property {string} id               stable per-import id
 * @property {string} filename
 * @property {number} importedAt       epoch ms
 * @property {string} [creator]        value of <gpx creator="...">
 * @property {Object<string,string>} [rootAttrs]
 * @property {Track[]} tracks
 * @property {Waypoint[]} waypoints
 * @property {Element[]} [extras]      unknown top-level <gpx> children (metadata, rte, ...)
 */

/**
 * @typedef {Object} Trip
 * Derived view used by the future canonical-path module. Computed on demand.
 * @property {string} trackId
 * @property {string} sourceId
 * @property {string} type
 * @property {Point} start
 * @property {Point} end
 * @property {[number,number,number,number]} bbox  [minLat,minLon,maxLat,maxLon]
 */

export const _doc = true; // module marker; importing for side-effect-free typedefs
