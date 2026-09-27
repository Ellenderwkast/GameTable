const CACHE = 'gametable-v1';
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/','/manifest.webmanifest']))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => { if (event.request.method === 'GET' && new URL(event.request.url).origin === self.location.origin) event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request))); });