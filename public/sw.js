// Suraksha Setu service worker.
//  - On install, caches the app's pages AND the JavaScript/CSS they need, so
//    the Offline tab and the QR relay scanner work even if they were never
//    opened while online.
//  - Pages: network first, falling back to the cached copy, then /offline.
//  - Hashed build assets (/_next/static): cache first — they never change.
//  - /api/*: never cached here; the dashboard keeps its own last snapshot.
const CACHE = "suraksha-v5";
const SHELL = ["/dashboard", "/offline", "/help", "/relay", "/settings", "/onboarding", "/manifest.json"];

async function precache() {
  const cache = await caches.open(CACHE);
  const assets = new Set();
  await Promise.all(SHELL.map(async (path) => {
    try {
      const res = await fetch(path, { cache: "reload" });
      if (!res.ok) return;
      await cache.put(path, res.clone());
      if (!(res.headers.get("content-type") || "").includes("text/html")) return;
      const html = await res.text();
      for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) assets.add(m[1]);
    } catch {
      // offline during install — the runtime handler will fill the cache later
    }
  }));
  await Promise.all([...assets].map((a) => cache.add(a).catch(() => {})));
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // the dashboard handles API failures itself

  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Next.js client-side navigation fetches a data payload for the page; if
  // that fails offline, erroring makes Next fall back to a full page load,
  // which the navigate branch below then serves from the cache.
  const isRsc = req.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
  if (isRsc) {
    e.respondWith(fetch(req).catch(() => Response.error()));
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname === "/" ? req : url.pathname, copy));
        }
        return res;
      })
      .catch(async () =>
        (await caches.match(url.pathname)) ||
        (await caches.match(req)) ||
        (req.mode === "navigate" ? caches.match("/offline") : Response.error())
      )
  );
});

// Tapping an alert notification opens the dashboard.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).pathname === "/dashboard");
      return open ? open.focus() : self.clients.openWindow("/dashboard");
    })
  );
});
