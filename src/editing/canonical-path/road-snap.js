// Optional map-matching against the OpenStreetMap road network via the
// public OSRM demo. Used to refine a user-drawn canonical path so it
// follows real roads instead of straight click-to-click lines.
//
// Behavioural contract:
// - Caller decides whether to snap (button in the canonical-card UI). For
//   subway / metro / boat / airplane canonicals snapping makes no sense -
//   there is no road - so the user just doesn't press the button.
// - On any failure (HTTP error, "NoMatch", abort, exception) we return
//   `{ ok: false, vertices: <input verbatim>, reason }`. The caller then
//   keeps the user-drawn polyline.
// - The public OSRM demo is rate-limited and meant for development. Heavy
//   users would point this at their own OSRM instance via OSRM_BASE_URL.

const OSRM_BASE_URL = "https://router.project-osrm.org/match/v1";
const MAX_COORDS = 100; // OSRM demo limit

const PROFILE_FOR_TYPE = {
  walking: "walking",
  running: "walking",
  hiking: "walking",
  cycling: "cycling",
  car: "driving",
  taxi: "driving",
  bus: "driving",
};

/**
 * Best-guess OSRM profile for a given activity type. Returns null if no
 * profile is sensible (subway, train, tram, metro, boat, airplane, ...).
 */
export function suggestedProfile(type) {
  return PROFILE_FOR_TYPE[type] || null;
}

function downsample(arr, target) {
  if (arr.length <= target) return arr;
  const step = (arr.length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Snap a polyline to the OSM road network.
 *
 * @param {[number,number][]} vertices ordered (lat, lon)
 * @param {"driving"|"walking"|"cycling"} [profile="driving"]
 * @param {{signal?: AbortSignal, baseUrl?: string}} [opts]
 * @returns {Promise<{ok: boolean, vertices: [number,number][], reason?: string}>}
 */
export async function snapToRoads(vertices, profile = "driving", opts = {}) {
  if (!Array.isArray(vertices) || vertices.length < 2) {
    return { ok: false, vertices: vertices || [], reason: "need-2-vertices" };
  }
  let input = vertices;
  if (input.length > MAX_COORDS) input = downsample(input, MAX_COORDS);

  const coords = input.map(([lat, lon]) => `${lon},${lat}`).join(";");
  const base = opts.baseUrl || OSRM_BASE_URL;
  const url = `${base}/${encodeURIComponent(profile)}/${coords}`
    + `?geometries=geojson&overview=full&tidy=true&gaps=ignore`;

  try {
    const res = await fetch(url, { signal: opts.signal, credentials: "omit" });
    if (!res.ok) return { ok: false, vertices, reason: `http-${res.status}` };
    const data = await res.json();
    if (data.code !== "Ok" || !Array.isArray(data.matchings) || !data.matchings.length) {
      return { ok: false, vertices, reason: data.code || "no-matching" };
    }
    /** @type {[number,number][]} */
    const out = [];
    for (const m of data.matchings) {
      const c = m?.geometry?.coordinates;
      if (!Array.isArray(c)) continue;
      for (const [lon, lat] of c) out.push([lat, lon]);
    }
    if (out.length < 2) return { ok: false, vertices, reason: "empty-geom" };
    return { ok: true, vertices: out };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "abort" : "fetch-failed";
    return { ok: false, vertices, reason };
  }
}
