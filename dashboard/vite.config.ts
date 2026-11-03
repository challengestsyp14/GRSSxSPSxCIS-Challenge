import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js + post-processing live in a lazily loaded chunk behind the dashboard.
    chunkSizeWarningLimit: 1300,
    // The shell (shared top bar, the testbed fitted in a frame), the testbed in that frame, and
    // pages.html behind /signal, /attacks, /protection and /slides.
    rollupOptions: {
      input: { main: page('index.html'), testbed: page('testbed.html'), pages: page('pages.html') },
    },
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
