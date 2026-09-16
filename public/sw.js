/* Onda Live — service worker: red primero, caché como respaldo sin conexión. */
const CACHE = 'onda-v29';
const SHELL = ['./?v=2.9.6', 'index.html?v=2.9.6', 'styles.css?v=2.9.6', 'app.js?v=2.9.6', 'audio.js?v=2.9.6', 'live.js?v=2.9.6', 'tools.js?v=2.9.6', 'pcm-worklet.js?v=2.9.6', 'pcm-player-worklet.js?v=2.9.6', 'manifest.webmanifest?v=2.9.6'];
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
