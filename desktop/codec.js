// Binary encoders/decoders for segment point lists.
//
// Storing each trkpt as its own SQLite row costs ~60-80 bytes/point in
// overhead. For a 500MB GPX corpus that's tens of GB. Packed blobs cut
// the cost to ~16 bytes/point (lat + lon as Float64) and let us decode
// directly into typed arrays the client can render.

/**
 * @param {{lat:number, lon:number, ele?:number, time?:string}[]} points
 * @returns {{ coords: Buffer, times: Buffer|null, eles: Buffer|null, hasTimes:boolean, hasEles:boolean }}
 */
export function encodePoints(points) {
  const n = points.length;
  const coords = new Float64Array(n * 2);
  let hasTimes = false;
  let hasEles = false;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    coords[i * 2] = p.lat;
    coords[i * 2 + 1] = p.lon;
    if (p.time) hasTimes = true;
    if (typeof p.ele === "number") hasEles = true;
  }
  let times = null;
  if (hasTimes) {
    const b = new BigInt64Array(n);
    for (let i = 0; i < n; i++) {
      const t = points[i].time;
      if (!t) { b[i] = -1n; continue; }
      const ms = Date.parse(t);
      b[i] = Number.isFinite(ms) ? BigInt(ms) : -1n;
    }
    times = Buffer.from(b.buffer);
  }
  let eles = null;
  if (hasEles) {
    const f = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const e = points[i].ele;
      f[i] = typeof e === "number" ? e : Number.NaN;
    }
    eles = Buffer.from(f.buffer);
  }
  return {
    coords: Buffer.from(coords.buffer),
    times,
    eles,
    hasTimes,
    hasEles,
  };
}

/**
 * @param {Buffer|Uint8Array} coords
 * @param {Buffer|Uint8Array|null} times
 * @param {Buffer|Uint8Array|null} eles
 * @returns {{lat:number, lon:number, ele?:number, time?:string}[]}
 */
export function decodePoints(coords, times, eles) {
  if (!coords || !coords.length) return [];
  // Buffers may not be 8-byte aligned; slice into a fresh ArrayBuffer first.
  const c = new Float64Array(coords.buffer.slice(coords.byteOffset, coords.byteOffset + coords.byteLength));
  const n = c.length / 2;
  const tArr = times
    ? new BigInt64Array(times.buffer.slice(times.byteOffset, times.byteOffset + times.byteLength))
    : null;
  const eArr = eles
    ? new Float64Array(eles.buffer.slice(eles.byteOffset, eles.byteOffset + eles.byteLength))
    : null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = { lat: c[i * 2], lon: c[i * 2 + 1] };
    if (tArr && tArr[i] >= 0n) {
      p.time = new Date(Number(tArr[i])).toISOString();
    }
    if (eArr && !Number.isNaN(eArr[i])) {
      p.ele = eArr[i];
    }
    out[i] = p;
  }
  return out;
}

/**
 * Cheap summary without allocating the full point array. Used during
 * ingest to populate the per-track summary columns.
 */
export function summarizePoints(points) {
  let first = null, last = null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (!first) first = p;
    last = p;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return {
    count: points.length,
    first, last,
    bbox: first
      ? { minLat, minLon, maxLat, maxLon }
      : null,
  };
}
