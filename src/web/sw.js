const CACHE_NAME = "hnd-app-shell-v29";
const APP_DOCUMENT = "/app";
const APP_ASSETS = Object.freeze([
  APP_DOCUMENT,
  "/web/styles.css",
  "/web/api.js",
  "/web/i18n.js",
  "/web/webauthn.js",
  "/web/vault.js",
  "/web/ui.js",
  "/web/app.js",
  "/web/connector-release.js",
  "/web/snapshot-data.js",
  "/web/hnd-icon.png",
  "/site.webmanifest",
  "/browser/index.mjs",
  "/browser/crypto.mjs",
  "/browser/storage.mjs",
  "/browser/vault.mjs",
]);
const APP_ASSET_PATHS = new Set(APP_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("hnd-app-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function appNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(APP_DOCUMENT, response.clone());
      return response;
    }
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      const cached = await caches.match(APP_DOCUMENT);
      if (cached) return cached;
    }
    return response;
  } catch {
    const cached = await caches.match(APP_DOCUMENT);
    return cached || Response.error();
  }
}

async function staticAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
      return response;
    }
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && /^\/app(?:\/|$)/.test(url.pathname)) {
    event.respondWith(appNavigation(request));
    return;
  }
  if (APP_ASSET_PATHS.has(url.pathname)) {
    event.respondWith(staticAsset(request));
  }
});

self.addEventListener("message", (event) => {
  if (
    event.data?.type !== "hnd-vault-reset" ||
    typeof event.data?.tenantId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(event.data.tenantId)
  ) {
    return;
  }
  const sourceId = event.source?.id || null;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) =>
        Promise.all(
          clients
            .filter((client) => {
              if (client.id === sourceId) return false;
              const url = new URL(client.url);
              return (
                url.origin === self.location.origin &&
                /^\/app(?:\/|$)/.test(url.pathname)
              );
            })
            .map((client) => client.navigate(client.url)),
        ),
      ),
  );
});
