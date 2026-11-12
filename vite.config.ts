import { defineConfig } from 'vite';

// Release build: one page (index.html) with relative asset paths so it runs from any
// GitHub Pages sub-path. Dev pages under dev/ are served by the dev server only.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', strictPort: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
