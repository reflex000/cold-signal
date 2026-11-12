# UI — handoff note

Module: all DOM interface. Owner files: `src/ui/**` except `src/ui/api.ts` (frozen; an optional
`UiGame.sfx` was added earlier), `dev/ui.html`, `dev/ui.ts`, `tools/ui-shots.mjs`.

## State

Complete. Everything type-checks, `npx vitest run src/ui` passes (7), every screen captured at
1600 x 900, 1280 x 720, phone 844 x 390 (+ portrait rotate notice) and once at 4K, read and iterated;
console clean. Multi-touch, latches, aim toggle, tool wheel (tap and slide), keyboard menu flows and
slider drag verified in page (scratch scripts, not kept).

Files: index.ts (createUI, modes, keyboard routing), hud.ts, title.ts (loading + title), menu.ts
(pause/status, settings, controls, how to play, credits), inventory.ts (pack, actions, fire help, map),
end.ts (death, ending), touch.ts, model.ts (+ model.test.ts), css.ts, nav.ts, dom.ts, icons.ts, text.ts.

## Decisions / API facts

- createUI(game) mounts `.cs` under #ui (creates #ui if missing) and injects one <style>.
  Paint order bottom->top: hud, touch, title, menu overlay, pack, end, loading, rotate notice.
- Keyboard: in title/pause/inventory/dead/won the UI listens on window keydown (capture), ignores a
  key older than the last mode change, stops propagation of keys it uses. In play it handles no keys.
- Menus have two nav scopes (column / page rows): Enter or right goes in, Esc comes out.
- Toasts: only bus 'toast'; 'lore' -> centred italic line. Desktop toasts sit bottom-left in the
  shaded band; on phones they sit top centre and the place card yields to them.
- Colour rule: words off-white; amber / red only for marks, rings, icons, state words.
- Text over snow: --halo text-shadow + --smudge soft radial shades (stronger when hud.whiteout > .5).
- Trend arrow: a chevron riding the arc ahead of the needle (double when |trend| >= 0.9 C/min).
- Death cause: last sim 'hurt' for myId; else swim -> water, core <= 31 -> cold.
- Bench opens sub pages by clicking `[data-id=...]`; `&age=N` advances UI time (fades).

## Test commands

- type-check: `npx tsc --noEmit -p .` (filter `| grep src/ui`); tests: `npx vitest run src/ui`
- one screen: `node tools/shot.mjs "dev/ui.html?mode=play&team=3&focus=1&still=1" --out ui_test`
- all shots: `node tools/ui-shots.mjs [--only play,pack] [--sizes 1600,1280,phone,4k]`

## Final report

**Files (type-check, console clean):** `src/ui/index.ts` (createUI, modes, key routing), `hud.ts`, `title.ts` (loading, title), `menu.ts` (pause status, settings, controls, how to play, credits), `inventory.ts` (pack grid, use/load/drop/give, fire help, map), `end.ts` (death, ending), `touch.ts`, `model.ts` + `model.test.ts` (7 pass); inherited `css.ts`, `nav.ts`, `dom.ts`, `icons.ts`, `text.ts` kept and fixed. Bench `dev/ui.html` + `dev/ui.ts` (all brief switches plus page, sel, held, down, age, bg). `tools/ui-shots.mjs`: 20 screens x 1600 / 1280 / phone + portrait, optional 4k. All shots read and iterated; multi-touch, wheel, latches, keyboard flows and slider drag verified in page.

**API:** `createUI(game: UiGame): UiApi` from `src/ui/index`. Call `ui.update(dt)` every frame; release pointer lock while `ui.wantsPointer()` (title, pause, inventory, dead, won). No contract changes by me (optional `UiGame.sfx` predates me).

**The game must:**
- emit bus `mode` (UI also polls `view.mode`), `loading` {progress, -1 = indeterminate, label} during boot, `place`, and forward sim toasts for the local player as bus `toast` (UI shows only bus `toast`; kind `lore` is a centred line);
- give `hud.heading` and `hud.marks[].bearing` in radians, 0 = north, clockwise;
- ignore keys and pad while `wantsPointer()`: the UI owns menu keys (window keydown, capture, stops propagation, ignores the key that changed mode) and polls the pad itself.
- Death cause = last sim `hurt` for myId. Pack "Load" sends `equip(tool)` then `act({t:'reload'})`. `game.icon()` canvases are copied into cells when they appear; the `game.map()` canvas is moved into the map page.

**Fixed in inherited CSS:** `.dn` class collision (downed block hid the trend arrow and pressed touch buttons); compass labels misplaced (em on smaller type).

**Unsure / not done:** solo self-revive has no dedicated control (hint points to the pack's bandage "Use"); touch aim is tap to toggle, hold for momentary; gamepad navigation untested on real hardware; legibility judged on the CSS placeholder scene, so re-check over the real renderer.
