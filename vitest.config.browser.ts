import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  resolve: {
    alias: {
      '@webwaka/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    name: 'components',
    environment: 'happy-dom',
    globals: true,
    include: ['src/components/**/*.test.tsx', 'src/components/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/components/**/*.tsx'],
      exclude: ['src/components/**/*.test.tsx'],
    },
  },
});
