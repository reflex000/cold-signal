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
    // the licences of everything bundled (three.js, MIT) go out with the game: dist/THIRD-PARTY-LICENSES.md
    license: { fileName: 'THIRD-PARTY-LICENSES.md' },
  },
  // The suite runs its files in parallel on a shared machine: long behavioural traces get room
  // (cost tests scale their budgets with the measured machine speed, see src/sim/timing.ts).
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 30000, hookTimeout: 120000 },
});
