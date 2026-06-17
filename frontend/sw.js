const CACHE_NAME = 'oneart-photo-v5.2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './processor.js',
  './icon.svg',
  './manifest.json'
];

// Cache core assets on install
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Stale-while-revalidate strategy for same-origin, Network-first fallback for cross-origin
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only handle GET requests
  if (e.request.method !== 'GET') {
    return;
  }

  // Check if same-origin (local assets)
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Serve from cache, but update cache in the background
          fetch(e.request).then((networkResponse) => {
            if (networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(e.request, networkResponse);
              });
            }
          }).catch(() => {/* Ignore network errors */});
          return cachedResponse;
        }
        return fetch(e.request);
      })
    );
  } else {
    // Cross-origin (e.g. Google Fonts)
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(e.request).then((networkResponse) => {
          // Cache fonts dynamically
          if (networkResponse.status === 200 && (url.host.includes('fonts.googleapis') || url.host.includes('fonts.gstatic'))) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(e.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Silent catch for network failure
        });
      })
    );
  }
});
