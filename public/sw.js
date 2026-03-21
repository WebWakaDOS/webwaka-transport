/**
 * WebWaka Transport — Service Worker
 * Strategy: Cache-First for shell, Network-First for API, Background Sync for mutations
 * Invariants: Offline-First, PWA-First
 */
const CACHE_NAME = 'webwaka-transport-v1';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];

// ============================================================
// Install: cache shell assets
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ============================================================
// Activate: clean old caches
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ============================================================
// Fetch: Cache-First for shell, Network-First for API
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Network-First for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => new Response(
          JSON.stringify({ success: false, error: 'Offline — request queued for sync' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // Cache-First for shell assets (HTML, JS, CSS, images)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback to index.html for navigation requests (SPA routing)
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ============================================================
// Background Sync: flush offline mutation queue
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === 'webwaka-transport-sync') {
    event.waitUntil(flushMutationQueue());
  }
});

async function flushMutationQueue() {
  // Notify clients that sync is running
  const clients = await self.clients.matchAll({ type: 'window' });
  let synced = 0;
  // The actual DB flush is handled by the app via Dexie
  // SW notifies the app to trigger sync
  clients.forEach(client => {
    client.postMessage({ type: 'TRIGGER_SYNC' });
    synced++;
  });
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_COMPLETE', count: synced });
  });
}
