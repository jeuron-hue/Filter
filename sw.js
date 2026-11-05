// filter service worker.
//
// What it does, in plain words:
// 1. On install it downloads the app shell (the page, manifest, icons, fonts)
//    into a cache, so the app opens with no network at all. MediaPipe and its
//    models (about 35 MB) go in a second cache named by their pinned version, so
//    an app release does not download them again; only a new pin does.
//    TinyCLIP and onnxruntime-web (about 99 MB, for Gary's typed folders) go in
//    a third cache, named the same way, but only when first asked for: most
//    runs never need them, so installing does not download them.
// 2. On every request for one of our own files it answers from that cache first.
//    It never touches any other website: requests to other origins are ignored.
//
// Release rule: bump CACHE_VERSION with every release. It must match APP_VERSION
// in filter.html (filter_checks.cjs fails if they differ). A new version makes
// the browser install a fresh worker, and the app shows "Update available".

const CACHE_VERSION = '0.5.0';
const CACHE = 'filter-v' + CACHE_VERSION;
// Must name the @mediapipe/tasks-vision version in the filter.html build notes
// (filter_checks.cjs enforces it). Change the suffix whenever a file below changes.
const VENDOR_CACHE = 'filter-mediapipe-0.10.35-4';

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

// Must name the onnxruntime-web version in the filter.html build notes
// (filter_checks.cjs enforces it). Change the suffix whenever a file below changes.
const CLIP_CACHE = 'filter-clip-1.30.0-1';
const CLIP_FILES = [
  'vendor/ort/ort.wasm.bundle.min.js',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/clip/tinyclip_vision_int8.onnx',
  'vendor/clip/tinyclip_text_int8.onnx',
  'vendor/clip/vocab.json',
  'vendor/clip/merges.txt',
];

const VENDOR = [
  'vendor/mediapipe/vision_bundle.js',
  'vendor/mediapipe/vision_wasm_internal.js',
  'vendor/mediapipe/vision_wasm_internal.wasm',
  'vendor/mediapipe/efficientnet_lite0.tflite',
  'vendor/mediapipe/blaze_face_short_range.tflite',
  'vendor/mediapipe/efficientdet_lite0.tflite',
  'vendor/mediapipe/mobilenet_v3_large.tflite',
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
      .filter((k) => (k.startsWith('filter-v') && k !== CACHE) || (k.startsWith('filter-mediapipe-') && k !== VENDOR_CACHE) ||
        (k.startsWith('filter-clip-') && k !== CLIP_CACHE))
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

  // TinyCLIP's files: from their cache, or fetched once and kept there.
  if (CLIP_FILES.some((f) => url.pathname.endsWith('/' + f))) {
    event.respondWith((async () => {
      const clip = await caches.open(CLIP_CACHE);
      const hit = await clip.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await clip.put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
      await (await caches.open(VENDOR_CACHE)).match(req);
    if (hit) return hit;
    return fetch(req);
  })());
});
