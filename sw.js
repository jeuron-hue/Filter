// filter service worker.
//
// What it does, in plain words:
// 1. On install it downloads the app shell (the page, manifest, icons, fonts)
//    into a cache, so the app opens with no network at all. MediaPipe and its
//    model (about 30 MB) go in a second cache named by their pinned version, so
//    an app release does not download them again; only a new pin does.
// 2. On every request for one of our own files it answers from that cache first.
//    It never touches any other website: requests to other origins are ignored.
//
// Release rule: bump CACHE_VERSION with every release. It must match APP_VERSION
// in filter.html (filter_checks.cjs fails if they differ). A new version makes
// the browser install a fresh worker, and the app shows "Update available".

const CACHE_VERSION = '0.0.2';
const CACHE = 'filter-v' + CACHE_VERSION;
// Must name the @mediapipe/tasks-vision version in the filter.html build notes
// (filter_checks.cjs enforces it). Change the suffix whenever a file below changes.
const VENDOR_CACHE = 'filter-mediapipe-0.10.35-1';

const SHELL = [
  './',
  'index.html',
  'filter.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-180.png',
  'vendor/fonts/barlow-semi-condensed-latin-400-normal.woff2',
  'vendor/fonts/barlow-semi-condensed-latin-600-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
];

const VENDOR = [
  'vendor/mediapipe/vision_bundle.js',
  'vendor/mediapipe/vision_wasm_internal.js',
  'vendor/mediapipe/vision_wasm_internal.wasm',
  'vendor/mediapipe/efficientnet_lite0.tflite',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new release never
  // caches a stale copy of a file.
  event.waitUntil(Promise.all([
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))
    ),
    caches.open(VENDOR_CACHE).then(async (cache) => {
      const have = await Promise.all(VENDOR.map((u) => cache.match(u)));
      const missing = VENDOR.filter((u, i) => !have[i]);
      await cache.addAll(missing.map((u) => new Request(u, { cache: 'reload' })));
    }),
  ]));
  // No skipWaiting here: an updated worker waits until the user taps
  // "Reload" in the app, so a run in progress is never swapped out.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => (k.startsWith('filter-v') && k !== CACHE) || (k.startsWith('filter-mediapipe-') && k !== VENDOR_CACHE))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never handle other origins
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
      await (await caches.open(VENDOR_CACHE)).match(req);
    if (hit) return hit;
    return fetch(req);
  })());
});
