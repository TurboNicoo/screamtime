const CACHE = "screamtime-v3";
const ASSETS = ["./", "index.html", "app.js", "engine.js", "sources.js", "manifest.json", "icon-192.png", "icon-512.png", "icon-512-maskable.png",
  "img/car-hood-purple.jpg", "img/car-burnout-smoke.jpg", "img/car-angle-crowd.jpg"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) { // lettertypes: cache-first, zodat de app offline mooi blijft
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // netwerk eerst voor code en pagina (updates komen direct door), cache als fallback
  if (req.mode === "navigate" || /\.(js|json|html)$/.test(url.pathname)) {
    e.respondWith(fetch(req).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; }).catch(() => hit);
    return hit || net;
  }));
});
