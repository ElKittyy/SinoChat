"use strict";

const CACHE_PREFIX = "sinochat-shell-";
const CACHE_NAME = `${CACHE_PREFIX}2026-07-26-1`;
const OFFLINE_URL = "/offline.html";
const STATIC_PATHS = new Set([
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/assets/sinochat-logo.png",
  "/assets/pwa-icon-192.png",
  "/assets/pwa-icon-512.png",
  "/assets/pwa-icon-maskable-512.png",
  "/assets/apple-touch-icon-180.png",
  "/assets/favicon-32.png",
]);
const VERSIONED_ASSET =
  /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:css|js|woff|woff2)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(installPublicShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Estas rutas siempre pasan directamente a la red y nunca tocan CacheStorage.
  if (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, url));
    return;
  }

  if (STATIC_PATHS.has(url.pathname) || VERSIONED_ASSET.test(url.pathname)) {
    event.respondWith(cacheFirstPublicAsset(url));
  }
});

async function installPublicShell() {
  const cache = await caches.open(CACHE_NAME);
  const precacheRequests = [...STATIC_PATHS].map(
    (path) =>
      new Request(new URL(path, self.location.origin), {
        cache: "reload",
        credentials: "omit",
      }),
  );
  await cache.addAll(precacheRequests);

  // La raíz se obtiene sin cookies para que jamás se almacene HTML autenticado.
  const shellResponse = await fetch("/", {
    cache: "no-store",
    credentials: "omit",
  });
  if (!isPublicResponse(shellResponse)) return;

  const shellHtml = await shellResponse.clone().text();
  await cache.put("/", shellResponse);

  const assetPaths = extractVersionedAssets(shellHtml);
  await Promise.all(assetPaths.map((path) => cachePublicAsset(path, cache)));
}

async function handleNavigation(request, url) {
  try {
    // Las navegaciones siempre usan red y sus respuestas nunca se almacenan.
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    if (url.pathname === "/") {
      const publicShell = await cache.match("/");
      if (publicShell) return publicShell;
    }
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

async function cacheFirstPublicAsset(url) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = url.pathname;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  return cachePublicAsset(cacheKey, cache);
}

async function cachePublicAsset(path, cache) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "omit",
  });
  if (!isPublicResponse(response)) return response;

  await cache.put(path, response.clone());
  return response;
}

function extractVersionedAssets(html) {
  const paths = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attributePattern)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && VERSIONED_ASSET.test(url.pathname)) {
      paths.add(url.pathname);
    }
  }
  return [...paths];
}

function isPublicResponse(response) {
  return response.ok && response.type === "basic";
}
