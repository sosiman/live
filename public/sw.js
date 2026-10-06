/* Onda Live — service worker: red primero, caché como respaldo sin conexión. */
const CACHE = 'onda-v40';
const SHELL = ['./?v=3.3.3', 'index.html?v=3.3.3', 'styles.css?v=3.3.3', 'app.js?v=3.3.3', 'audio.js?v=3.3.3', 'live.js?v=3.3.3', 'tools.js?v=3.3.3', 'pcm-worklet.js?v=3.3.3', 'pcm-player-worklet.js?v=3.3.3', 'manifest.webmanifest?v=3.3.3'];
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
