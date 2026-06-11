const CACHE_VERSION = 'colectivou-v4';
const STATIC_ASSETS = [
  '/dev',
  '/static/style.css',
  '/static/app.js',
  '/static/icon-192.png',
  '/offline',
];

// Imágenes y fuentes: cache-first (pesados, cambian poco)
const CACHE_FIRST_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'];
// Código: network-first (siempre fresco tras un deploy, cache solo como fallback offline)
const NETWORK_FIRST_EXTENSIONS = ['.css', '.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, htmlFallback) {
  return fetch(request).then(response => {
    if (response.ok && request.method === 'GET') {
      const clone = response.clone();
      caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
    }
    return response;
  }).catch(err => {
    return caches.match(request).then(cached => {
      if (cached) return cached;
      if (htmlFallback) return caches.match('/offline');
      throw err;
    });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      if (response.ok && request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
      }
      return response;
    });
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.url.startsWith('ws') || url.origin !== self.location.origin) return;

  const isApi = ['/login', '/register', '/me', '/ws', '/forgot', '/reset',
                  '/trips', '/conductor', '/admin', '/zones', '/stats'].some(p =>
    url.pathname === p || url.pathname.startsWith(p + '/')
  );
  if (isApi) return;

  const isHtml = event.request.mode === 'navigate'
    || event.request.headers.get('accept')?.includes('text/html');
  const isCode = NETWORK_FIRST_EXTENSIONS.some(ext => url.pathname.endsWith(ext));
  const isAsset = CACHE_FIRST_EXTENSIONS.some(ext => url.pathname.endsWith(ext));

  if (isHtml) {
    event.respondWith(networkFirst(event.request, true));
  } else if (isCode) {
    event.respondWith(networkFirst(event.request, false));
  } else if (isAsset) {
    event.respondWith(cacheFirst(event.request));
  }
  // Todo lo demás pasa directo a la red sin intervención del SW
});
