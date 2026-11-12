// Confirms the headless browser renders on the real GPU and reports WebGPU / WebGL2 support.
//   node tools/gpucheck.mjs [webgpu|webgl]
import http from 'node:http';
import { launch } from './pw.mjs';
const backend = process.argv[2] || 'webgpu';
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>gpu</title>'); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const { browser, page } = await launch({ width: 640, height: 360, backend });
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
const info = await page.evaluate(async () => {
  const out = { secure: isSecureContext, hasGpu: !!navigator.gpu };
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      out.adapter = a ? { vendor: a.info?.vendor, arch: a.info?.architecture, device: a.info?.device, desc: a.info?.description, fallback: a.info?.isFallbackAdapter, maxTex: a.limits.maxTextureDimension2D, features: [...a.features] } : null;
    } catch (e) { out.adapterError = String(e); }
  }
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl2 = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), floatBuf: !!gl.getExtension('EXT_color_buffer_float') };
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
server.close();
