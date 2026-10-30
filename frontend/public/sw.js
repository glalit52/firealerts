/* Firealerts service worker (hand-written, no build step).
 * - App shell cached for offline start; navigations are network-first with the cached shell as fallback.
 * - Hashed build assets (/assets/*) are cache-first (immutable).
 * - /api/* is never cached (always network; responses may carry auth).
 * - Web Push: payload JSON {title, body, url, severity, tag} → notification; click focuses/opens the URL. */
const VERSION = "fa-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles, CDNs: browser default
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return; // never cache the API

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/index.html", copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/"))),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (SHELL_URLS.includes(url.pathname) || url.pathname.startsWith("/icons/")) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});

// ------------------------------------------------------------------ push
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Firealerts";
  const severity = data.severity || "info";
  const urgent = severity === "critical" || severity === "high";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: urgent,
    vibrate: urgent ? [200, 100, 200, 100, 200] : [100],
    timestamp: Date.now(),
    data: { url: data.url || "/app/alerts", severity },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/app", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url === target && "focus" in w) return w.focus();
      }
      const same = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (same && "navigate" in same) return same.focus().then(() => same.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});
