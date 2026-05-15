// Color palette for activity types. Unknown types get a deterministic hashed color
// so future ARC type additions still render distinctively without code changes.

const BASE_COLORS = {
  walking: "#7EC850",
  hiking: "#5FAD41",
  running: "#98D77E",
  cycling: "#FFD27F",
  bus: "#FFA552",
  train: "#FFD66B",
  tram: "#FFCC4D",
  metro: "#FFE084",
  cablecar: "#FF7B32",
  funicular: "#FF8F66",
  skilift: "#FF9C70",
  airplane: "#A371E8",
  car: "#5A5A5A",
  taxi: "#6C6C6C",
  inlineskating: "#E07D8D",
  kayaking: "#76B7E0",
  swimming: "#5BA4C7",
  skiing: "#7FA2F3",
  boat: "#569AFF",
  stationary: "#9AA0A6",
};
const DEFAULT_COLOR = "#A8A8A8";

function hashColor(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = (h >>> 16) & 255, g = (h >>> 8) & 255, b = h & 255;
  const mix = v => Math.floor((v + 128) / 2).toString(16).padStart(2, "0");
  return "#" + mix(r) + mix(g) + mix(b);
}

export function colorForType(type) {
  const k = (type || "").toLowerCase();
  if (BASE_COLORS[k]) return BASE_COLORS[k];
  return k ? hashColor(k) : DEFAULT_COLOR;
}
