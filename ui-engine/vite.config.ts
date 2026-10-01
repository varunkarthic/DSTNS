// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// Minimal ambient declaration: @types/node is not a dependency of the browser
// bundle, and the config only ever reads one optional port override.
declare const process: { env: Record<string, string | undefined> };
const apiTarget = `http://127.0.0.1:${process.env.DSTNS_API_PORT || '8090'}`;
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1300 },
  server: {
    port: 5173,
    // The UI and its tests read the operator defaults in ../config.
    fs: { allow: ['.', '../config'] },
    proxy: {
      '/api': { target: apiTarget },
      '/health': { target: apiTarget },
      '/media': { target: apiTarget },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] },
});
