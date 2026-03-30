import React from 'react';
import { createRoot } from 'react-dom/client';
import { TransportApp } from './app';
import { setupSyncMessageHandler } from './core/offline/sync';

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
        // Wire the sync message handler so SW background-sync events
        // trigger SyncEngine.flush() in this client context.
        setupSyncMessageHandler();
      })
      .catch(err => console.error('[SW] Registration failed:', err));
  });
}
