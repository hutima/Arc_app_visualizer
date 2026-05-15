// Pure geo helpers for the canonical-path module. Haversine + a few polyline
// primitives. No projections, no turf - everything we need fits in ~80 lines.

const R = 6371000; // mean Earth radius, meters

function toRad(deg) { return deg * Math.PI / 180; }

/**
 * Great-circle distance between two {lat, lon} points, in meters.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 */
export function distMeters(a, b) {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dphi = toRad(b.lat - a.lat);
  const dlam = toRad(b.lon - a.lon);
  const s = Math.sin(dphi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Is `point` within `radiusMeters` of `center`?
 * @param {{lat:number, lon:number}} point
 * @param {{lat:number, lon:number}} center
 * @param {number} radiusMeters
 */
export function inCircle(point, center, radiusMeters) {
  return distMeters(point, center) <= radiusMeters;
}

/**
 * @param {[number,number][]|{lat:number,lon:number}[]} vertices
 */
function asLL(v) {
  if (Array.isArray(v)) return { lat: v[0], lon: v[1] };
  return v;
}

/**
 * Cumulative along-path distances, in meters. Returns an array of the same
 * length as `vertices`; `cum[0] = 0`.
 * @param {([number,number]|{lat:number,lon:number})[]} vertices
 */
export function cumulativeDistances(vertices) {
  const cum = new Array(vertices.length);
  cum[0] = 0;
  for (let i = 1; i < vertices.length; i++) {
    cum[i] = cum[i - 1] + distMeters(asLL(vertices[i - 1]), asLL(vertices[i]));
  }
  return cum;
}

export function polylineLengthMeters(vertices) {
  if (!vertices || vertices.length < 2) return 0;
  const cum = cumulativeDistances(vertices);
  return cum[cum.length - 1];
}

/**
 * Bounding box of a list of points or [lat,lon] pairs.
 * @returns {[number,number,number,number]} [minLat, minLon, maxLat, maxLon]
 */
export function bboxOf(points) {
  if (!points || !points.length) return [0, 0, 0, 0];
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lon = Array.isArray(p) ? p[1] : p.lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [minLat, minLon, maxLat, maxLon];
}

/**
 * Union of two bboxes.
 */
export function bboxUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Cheap "could this bbox possibly contain a point inside the circle?" test.
 * We inflate the bbox by the radius converted to degrees (using a rough
 * factor for latitude; longitude is fine for a generous prefilter).
 */
export function bboxIntersectsCircle(bbox, center, radiusMeters) {
  if (!bbox) return false;
  const degPad = radiusMeters / 111000 + 0.0005; // ~111 km / degree latitude
  return center.lat >= bbox[0] - degPad
    && center.lat <= bbox[2] + degPad
    && center.lon >= bbox[1] - degPad
    && center.lon <= bbox[3] + degPad;
}
