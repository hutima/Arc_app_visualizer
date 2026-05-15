// Registers the service worker if the runtime supports it. Failure is non-fatal:
// the app works fully as a regular web page without offline caching.

export function registerServiceWorker(swUrl = "./sw.js") {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(swUrl).catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
