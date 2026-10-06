/* Onda Live — service worker: red primero, caché como respaldo sin conexión. */
const CACHE = 'onda-v32';
const SHELL = ['./?v=3.0.1', 'index.html?v=3.0.1', 'styles.css?v=3.0.1', 'app.js?v=3.0.1', 'audio.js?v=3.0.1', 'live.js?v=3.0.1', 'tools.js?v=3.0.1', 'pcm-worklet.js?v=3.0.1', 'pcm-player-worklet.js?v=3.0.1', 'manifest.webmanifest?v=3.0.1'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch {
      return (await cache.match(event.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
