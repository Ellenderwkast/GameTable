const CACHE = 'gametable-shell-v2';
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/','/manifest.webmanifest']))));
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))), self.clients.claim()])));
self.addEventListener('fetch', (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
	if (request.mode === 'navigate') event.respondWith(fetch(request).catch(() => caches.match('/')));
	else if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(request)) ?? fetch(request).then((response) => { cache.put(request, response.clone()); return response; })));
});