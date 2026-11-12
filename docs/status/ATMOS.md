# ATMOS status (sky, light, weather)

## State
- Done: src/gfx/sky/astro.ts (+ astro.test.ts, passes), atmosphere.ts (+ atmosphere.test.ts, passes),
  common.ts (shared SKY/AIR uniforms, LUT sampling, fog model), textures.ts (2D/3D noise).
- In progress: sky nodes (dome + env materials), env.ts (custom PMREM), sky/index.ts.
- Not started: weather, benches.

## Remaining (priority order)
1. src/gfx/sky: nodes.ts (stars, discs, clouds, aurora, dome + env material), env.ts, index.ts
2. src/gfx/weather: fog node, whiteout overlay, snow particles, volumetric HDR stage, spindrift
3. dev/sky.html + dev/sky.ts, dev/weather.html + dev/weather.ts
4. Shots on WebGPU / webgl / mobile + polish

## Decisions / API facts
- Sky computed on the CPU (atmosphere.ts): transmittance + multiple-scattering tables at load
  (~100 ms), sky-view tables per light (sun 32x48x20 steps ~7.5 ms, built a few rows per frame
  when the light moved). Phase functions are applied per pixel (Mie stays sharp). Same numbers feed
  ambient, fog colour, sun colour. Mobile uses smaller tables (no GPU LUT passes anywhere).
- Sky dome = own mesh at the far plane, depthTest on, depthWrite off, renderOrder last among
  opaques, so only visible sky pixels are shaded (scene.backgroundNode would shade every pixel).
  post `isSky` still works (no depth written).
- Ambient = scene.environment: custom small PMREM (cube 64, three's ggxConvolution/ggxIntegration
  TSL helpers), refreshed over 3 frames when the sky changes. Fallback (no half-float targets):
  HemisphereLight.
- One shadow-casting key DirectionalLight (CSMShadowNode): the sun by day, the moon at night
  (switch at zero intensity below the horizon). U.sunColor / U.moonColor stay separate.
- Units follow ENGINE's bench: noon sun ~[10.5,8.9,6.9], exposure ~0.65 by day, moonlight ~0.1-0.2.
  Twilight sky is "lifted" (exp(0.5 * depression deg)) so blue hour bridges into the art-directed night.
- astro: lat 46N, sun dec -22 deg, solar noon 12:24 -> noon elevation 22, sunset 16:45; moon
  waxing gibbous on day 0 (elongation 112 deg at 00:00 day 0), sidereal star frame.

## Issues found in other modules (for the report)
- ENGINE post.ts GTAO: far ground seen at grazing angles (about 150 m to 2 km) turns near black at
  dusk/night (AO is only faded on bright pixels). Reproduce: dev/sky.html?clock=16.75&el=2&ty=6&dist=10
  vs the same with &noao=1. Suggested fix: also fade AO with view depth (e.g. 1 - smoothstep(40, 120, viewDepth)).

## Test commands
- npx vitest run src/gfx/sky   (ATMOS_VERBOSE=1 ... --silent=false prints numbers)
