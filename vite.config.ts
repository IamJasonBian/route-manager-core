import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  /** When set (e.g. http://127.0.0.1:9999), forward /.netlify/functions to a local Netlify functions server. Plain `vite` does not run functions — use `netlify dev` (see netlify.toml port) or this proxy. */
  const functionsProxy = env.VITE_FUNCTIONS_PROXY?.trim();

  return {
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Mock Node.js modules that might be required by dependencies
      'node:buffer': 'buffer',
      'node:stream': 'stream-browserify',
      'node:util': 'util',
      'node:path': 'path-browserify',
    },
  },
  optimizeDeps: {
    exclude: [
      'pg',
      'pg-cloudflare',
      'pg-native',
      'pg-connection-string',
      'pg-pool',
      'pg-protocol',
      'pg-types',
      'pgpass',
    ],
  },
  ssr: {
    noExternal: ['pg'],
    // Ensure these are treated as external in SSR
    external: ['pg-cloudflare', 'cloudflare:sockets'],
  },
  build: {
    rollupOptions: {
      external: [
        'pg-cloudflare',
        'cloudflare:sockets',
        'pg-native',
        'node:buffer',
        'node:stream',
        'node:util',
        'node:path',
      ],
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    ...(functionsProxy
      ? {
          proxy: {
            '/.netlify/functions': {
              target: functionsProxy,
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  define: {
    'process.env.NODE_ENV': `"${process.env.NODE_ENV || 'development'}"`,
    global: 'globalThis',
  },
};
});
