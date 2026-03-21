import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react';
            if (id.includes('node_modules/dexie')) return 'dexie';
          },
        },
      },
  },
  // Proxy API calls to the Worker during local development
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  define: {
    'import.meta.env.VITE_API_BASE': JSON.stringify(
      process.env.VITE_API_BASE || 'https://webwaka-transport-api-prod.webwaka.workers.dev'
    ),
  },
});
