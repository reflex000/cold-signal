// A private Vite dev server for one tool run: free port, no file watching, no HMR, its own
// cache directory. Several people edit files in this folder at the same time; a watcher would
// reload the page in the middle of a capture.
//   import { startServer } from './serve.mjs';
//   const { url, close } = await startServer();
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}

export async function startServer({ port = 0 } = {}) {
  const p = port || (await freePort());
  const cacheDir = path.join(os.tmpdir(), 'cold-signal-vite', String(p));
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    cacheDir,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port: p, strictPort: true, watch: null, hmr: false },
  });
  await server.listen();
  return {
    url: `http://localhost:${p}`,
    port: p,
    async close() {
      await server.close();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

// Run directly to keep a server up: node tools/serve.mjs [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer({ port: Number(process.argv[2]) || 0 });
  console.log(s.url);
}
