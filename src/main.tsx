import React from 'react';
import { createRoot } from 'react-dom/client';
import { TransportApp } from './app';

// Mount React app
const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');
const root = createRoot(container);
root.render(React.createElement(React.StrictMode, null, React.createElement(TransportApp)));

// Register service worker (PWA-First, Offline-First)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[SW] Registered:', reg.scope);
        // Listen for background sync messages
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data?.type === 'SYNC_COMPLETE') {
            console.log('[SW] Background sync complete:', event.data.count, 'mutations synced');
          }
        });
      })
      .catch(err => console.error('[SW] Registration failed:', err));
  });
}
