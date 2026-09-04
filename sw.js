/**
 * Offline cache.
 *
 * Everything the app needs is precached on install, so after one visit with
 * signal it runs with the radio off. Assets are served cache-first because none
 * of them change without a version bump: there is no live data to go stale, and
 * a boat 30 miles offshore must never wait on a network round trip.
 *
 * Bump CACHE when any file below changes, or phones will keep the old copy.
 */
const CACHE = "rarnav-v3";

const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "js/app.js",
  "js/nav.js",
  "js/course.js",
  "js/map.js",
  "js/gps.js",
  "js/charts.js",
  "js/ui.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "data/aeolian_coast.geojson",
  "data/course.json",
  "data/polar_dufour40.json",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request)
        .then((res) => {
          // Cache same-origin successes so a first visit that missed the
          // precache list still works offline afterwards.
          if (res.ok && new URL(e.request.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match("index.html"));
    })
  );
});
