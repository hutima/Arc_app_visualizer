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

/**
 * @typedef {Object} Anchor
 * @property {number} lat
 * @property {number} lon
 * @property {number} radiusMeters
 * @property {string} [label]
 */

/**
 * @typedef {Object} TripFilters
 * @property {string[]} [includeTypes]
 * @property {number[]} [weekdays]                  0..6 (Sun..Sat)
 * @property {[number,number]} [hourRange]          [startHour, endHourExclusive] local time
 */

/**
 * @typedef {Object} AnchorPair
 * @property {string} id
 * @property {string} [label]
 * @property {Anchor} start
 * @property {Anchor} end
 * @property {boolean} bidirectional
 * @property {boolean} chainFragments
 * @property {number} [chainGapSec]
 * @property {TripFilters} [filters]
 * @property {string} [canonicalPathId]
 * @property {boolean} enabled
 * @property {number} createdAt
 */

/**
 * @typedef {Object} CanonicalPath
 * @property {string} id
 * @property {string} anchorPairId
 * @property {[number,number][]} vertices            ordered (lat, lon)
 * @property {"drawn"|"exemplar"|"imported"|"road-snapped"} origin
 * @property {string} [exemplarSourceId]
 * @property {string} [exemplarTrackId]
 * @property {[number,number][]} [preSnapVertices]   user-drawn copy preserved when snapped
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} MatchCandidate
 * @property {string} sourceId
 * @property {string[]} trackIds                     1 for normal match, N for chains
 * @property {Point} robustStart
 * @property {Point} robustEnd
 * @property {"forward"|"reverse"} direction
 * @property {boolean} chained
 * @property {number} startDistMeters
 * @property {number} endDistMeters
 * @property {string} [reason]
 */

/**
 * @typedef {Object} TrackSnapshot
 * @property {string} trackId
 * @property {string} [name]
 * @property {string} type
 * @property {string} [rawType]
 * @property {Segment[]} segments
 * @property {Element[]} [extras]
 * @property {number} [originalIndex]                position in source.tracks before edit
 */

/**
 * @typedef {Object} EditOp
 * @property {string} id
 * @property {number} appliedAt
 * @property {string} groupId
 * @property {string} [anchorPairId]
 * @property {string} [canonicalPathId]
 * @property {"replaceTrackPoints"|"deleteTrack"|"insertTrack"} type
 * @property {string} sourceId
 * @property {string} [trackId]
 * @property {Segment[]} [newSegments]
 * @property {TrackSnapshot} [snapshot]
 * @property {Track} [newTrack]
 * @property {number} [insertAfterIndex]
 */

export const _doc = true; // module marker; importing for side-effect-free typedefs
