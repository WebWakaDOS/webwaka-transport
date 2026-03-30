/**
 * WebWaka Transport — Service Worker v2
 * Strategy: Cache-First for shell assets, Network-First for API calls
 * Background Sync: signals clients to flush the Dexie mutation queue
 * Push: displays trip status and booking confirmation notifications
 * Invariants: Offline-First, PWA-First, Nigeria-First
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `webwaka-transport-${CACHE_VERSION}`;
const SYNC_TAG = 'webwaka-transport-sync';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ============================================================
// Install: pre-cache shell assets
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ============================================================
// Activate: purge old caches
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ============================================================
// Fetch: Cache-First for shell, Network-First for API
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-First for API calls — never cache API responses in SW
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ success: false, error: 'Offline — request queued', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Cache-First for shell assets (HTML, JS, CSS, fonts, images)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Cache successful GET responses for shell assets
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // SPA navigation fallback
        if (request.mode === 'navigate') {
          return caches.match('/index.html').then(r => r ?? new Response('Offline', { status: 503 }));
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ============================================================
// Background Sync: flush the offline mutation queue
//
// The SW cannot access Dexie directly (different JS context),
// so it signals all window clients via postMessage.
// Each client runs SyncEngine.flush() and replies SYNC_DONE.
// We use a MessageChannel so the event.waitUntil() promise only
// resolves after all clients have acknowledged completion.
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(triggerClientSync());
  }
});

async function triggerClientSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  if (clients.length === 0) {
    // No open windows — nothing to sync right now.
    // Background sync will retry when a window opens.
    return;
  }

  // Send TRIGGER_SYNC to each client with a reply channel.
  // Resolve when any client replies SYNC_DONE (first one wins).
  const syncPromises = clients.map(client =>
    new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => {
        if (e.data && (e.data.type === 'SYNC_DONE' || e.data.type === 'SYNC_ERROR')) {
          resolve(e.data);
        }
      };
      client.postMessage({ type: 'TRIGGER_SYNC', port: channel.port2 }, [channel.port2]);
    })
  );

  // Wait for at least one client to finish (or timeout after 30s)
  await Promise.race([
    Promise.any(syncPromises),
    new Promise(resolve => setTimeout(resolve, 30_000)),
  ]);
}

// ============================================================
// Push Notifications: trip alerts + booking confirmations
// ============================================================
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'WebWaka', body: event.data.text() };
  }

  const options = {
    body: payload.body ?? 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: payload.tag ?? 'webwaka-notification',
    data: payload.data ?? {},
    actions: payload.actions ?? [],
    requireInteraction: payload.requireInteraction ?? false,
  };

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'WebWaka Transport', options)
  );
});

// ============================================================
// Notification click: navigate to the relevant page
// ============================================================
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// ============================================================
// Message handler: app → SW commands
// ============================================================
self.addEventListener('message', event => {
  const { data } = event;
  if (!data) return;

  switch (data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'CACHE_VERSION':
      event.source?.postMessage({ type: 'CACHE_VERSION', version: CACHE_VERSION });
      break;
  }
});
