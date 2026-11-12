// Shared Playwright launcher: headless Chrome on the real GPU, WebGPU enabled.
//   import { launch } from './pw.mjs';
//   const { browser, page, logs } = await launch({ width: 1600, height: 900 });
import fs from 'node:fs';
import { chromium } from 'playwright-core';

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome found; set CHROME_PATH');
}

/** backend: 'webgpu' (default) or 'webgl' (disables WebGPU so the fallback path is exercised). */
export async function launch({ width = 1600, height = 900, headless = true, backend = 'webgpu', mobile = false, args = [] } = {}) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless,
    args: [
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--force_high_performance_gpu',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      ...(backend === 'webgpu' ? ['--enable-unsafe-webgpu', '--enable-features=WebGPU'] : ['--disable-features=WebGPU']),
      ...args,
    ],
  });
  // mobile: a phone held in landscape, with touch and a 2x pixel ratio. Pass width / height to
  // override the default 844 x 390.
  const context = await browser.newContext(
    mobile
      ? {
          viewport: { width: width === 1600 ? 844 : width, height: height === 900 ? 390 : height },
          deviceScaleFactor: 2,
          hasTouch: true,
          isMobile: true,
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        }
      : { viewport: { width, height }, deviceScaleFactor: 1 },
  );
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    const line = `[${t}] ${m.text()}`;
    logs.push(line);
    if (t === 'error' || t === 'warning' || process.env.PW_VERBOSE) console.log(line);
  });
  page.on('pageerror', (e) => {
    const line = `[pageerror] ${e.message}\n${e.stack || ''}`;
    logs.push(line);
    console.log(line);
  });
  return { browser, context, page, logs };
}
