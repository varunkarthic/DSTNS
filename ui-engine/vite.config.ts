import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1300 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090' },
      '/health': { target: 'http://127.0.0.1:8090' },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] },
});
