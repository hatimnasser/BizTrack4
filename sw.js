// BizTrack Pro — Service Worker
// Strategy: Cache-first for app shell, network-first for API calls
// Designed for low-bandwidth environments in Uganda

const CACHE_NAME = 'biztrack-v3.1';
const STATIC_CACHE = 'biztrack-static-v3.1';

// App shell — files that make up the core UI
const APP_SHELL = [
  '/',
  '/index.html',
  '/src/utils/database.js',
  '/src/utils/pdfReceipt.js',
  '/src/utils/excelExport.js',
  '/src/utils/plEngine.js',
  '/src/utils/fileManager.js',
  '/manifest.json',
];

// External resources to cache (fonts, CDN libs)
const EXTERNAL_CACHE = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap',
];

// ── Install: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function(cache) {
      // Cache app shell files — fail silently on individual errors
      return Promise.allSettled(
        APP_SHELL.map(function(url) {
          return cache.add(url).catch(function(e) {
            console.warn('[SW] Failed to cache:', url, e.message);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) {
            return name !== STATIC_CACHE && name !== CACHE_NAME;
          })
          .map(function(name) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── Fetch: serve from cache, fall back to network ────────────────────────────
self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);

  // Don't intercept non-GET requests or Supabase API calls
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('googleapis.com') && url.pathname.includes('/maps')) return;

  // Network-first for navigation requests (ensures fresh content)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(function(response) {
          // Cache the fresh response
          var responseClone = response.clone();
          caches.open(STATIC_CACHE).then(function(cache) {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(function() {
          // Offline fallback: serve from cache
          return caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }

  // Cache-first for all other GET requests (fonts, scripts, icons)
  event.respondWith(
    caches.match(event.request).then(function(cachedResponse) {
      if (cachedResponse) {
        // Serve from cache, update in background (stale-while-revalidate)
        var fetchPromise = fetch(event.request).then(function(networkResponse) {
          caches.open(STATIC_CACHE).then(function(cache) {
            cache.put(event.request, networkResponse.clone());
          });
          return networkResponse;
        }).catch(function() {});
        return cachedResponse;
      }
      // Not in cache — fetch from network and cache it
      return fetch(event.request).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        var responseClone = response.clone();
        caches.open(STATIC_CACHE).then(function(cache) {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(function(e) {
        console.warn('[SW] Fetch failed for', event.request.url, e.message);
      });
    })
  );
});

// ── Background sync (if supported) ───────────────────────────────────────────
self.addEventListener('sync', function(event) {
  if (event.tag === 'biztrack-sync') {
    // Notify the client to run cloud sync
    event.waitUntil(
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'BACKGROUND_SYNC' });
        });
      })
    );
  }
});

// ── Push notifications (future use) ──────────────────────────────────────────
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'BizTrack', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'BizTrack Pro', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
