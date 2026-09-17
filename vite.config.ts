import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  // The API port the dev proxy forwards to. Must match the server's PORT.
  const apiTarget = env.VITE_DEV_API_TARGET || `http://127.0.0.1:${env.PORT || 3234}`;

  return {
    server: {
      port: 3233,
      host: '0.0.0.0',
      // Proxy API calls in development so the browser uses same-origin relative
      // paths (`/api/...`) in every environment. In production the API and the
      // built assets are served from one origin, so no proxy is needed.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    plugins: [react()],

    // NOTE: there is deliberately NO `define` block here.
    //
    // This file previously inlined GEMINI_API_KEY, OPENROUTER_API_KEY, and
    // API_KEY into the client bundle via `define`, which shipped live
    // credentials to every visitor — they were recoverable from dist/ with a
    // plain text search. All provider calls now go through the server BFF
    // (`/api/ai/*`), which is the only place those keys are read.
    //
    // Only `VITE_`-prefixed variables may reach the browser, and they must
    // never be secret. `scripts/assert-no-secrets-in-bundle.mjs` enforces this
    // and runs in CI.

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@features': path.resolve(__dirname, './src/features'),
        '@shared': path.resolve(__dirname, './src/shared'),
        '@config': path.resolve(__dirname, './src/config'),
      },
    },
  };
});
