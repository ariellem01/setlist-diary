// Setlist service worker.
// Its job: (1) lets Android/Chrome offer "Install app", and
// (2) keeps a copy of the app's files on the phone so it still opens with no signal.
// IMPORTANT: bump the CACHE name below every time you republish, so phones pick up the new version.
// It never sends your diary anywhere — it only stores the app's own files.

const CACHE = "setlist-v2"; // change this name (v2, v3…) each time you republish

// Files saved on first visit. Missing ones are skipped, so this is safe to keep as-is.
const CORE = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(CORE.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

// Remove copies left over from older versions.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // Pages: try the internet first so you see the newest version; fall back to the saved copy offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match("./")))
    );
    return;
  }

  // Everything else (scripts, styles, images): use the saved copy, and refresh it in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
