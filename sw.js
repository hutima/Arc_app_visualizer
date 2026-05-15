// Minimal app-shell service worker. Network-first for HTML, cache-first for static
// assets and the Leaflet CDN (which is content-addressed by version).
//
// Tile caching is intentionally opt-out: we never cache map tiles by default to
// avoid silently caching gigabytes. The app works offline only for the shell;
// loaded GPX data lives in memory.

const CACHE = "arc-gpx-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles/app.css",
  "./manifest.webmanifest",
  "./src/main.js",
  "./src/core/event-bus.js",
  "./src/core/id.js",
  "./src/model/types.js",
  "./src/model/store.js",
  "./src/parser/gpx-parser.js",
  "./src/serializer/gpx-serializer.js",
  "./src/io/file-import.js",
  "./src/io/file-export.js",
  "./src/map/map-view.js",
  "./src/map/layer-manager.js",
  "./src/map/palette.js",
  "./src/filtering/visibility.js",
  "./src/ui/source-list.js",
  "./src/ui/type-filters.js",
  "./src/ui/status-bar.js",
  "./src/pwa/register-sw.js",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Don't intercept tile requests - let the browser handle them.
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap|tiles\./.test(url.hostname)) return;

  // Leaflet CDN: cache-first.
  if (url.hostname === "unpkg.com") {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return resp;
    })));
    return;
  }

  // Same-origin: network-first with cache fallback.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(req)));
  }
});
