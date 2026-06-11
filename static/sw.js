const CACHE_VERSION = 'colectivou-v3';
const STATIC_ASSETS = [
  '/dev',
  '/static/style.css',
  '/static/app.js',
  '/static/icon-192.png',
  '/offline',
];

// Static file extensions eligible for runtime caching
const CACHEABLE_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'];

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

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.url.startsWith('ws') || url.origin !== self.location.origin) return;

  const isApi = ['/login', '/register', '/me', '/ws', '/forgot', '/reset',
                  '/trips', '/conductor', '/admin', '/zones', '/stats'].some(p =>
    url.pathname === p || url.pathname.startsWith(p + '/')
  );
  if (isApi) return;

  const isCacheable = CACHEABLE_EXTENSIONS.some(ext => url.pathname.endsWith(ext))
    || url.pathname === '/dev'
    || url.pathname === '/offline';

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET' && isCacheable) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(err => {
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/offline');
        }
        throw err;
      });
    })
  );
});
