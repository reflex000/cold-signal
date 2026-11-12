# UI — handoff note

Module: all DOM interface. Owner files: `src/ui/**` except `src/ui/api.ts` (frozen; an optional
`UiGame.sfx` was added earlier), `dev/ui.html`, `dev/ui.ts`, `tools/ui-shots.mjs`.

## State (update after every step)

- [x] dom.ts, icons.ts, text.ts, css.ts, nav.ts (first engineer; kept, small fixes)
- [x] model.ts: pure helpers (cold stage, trend, tool readout, bearings, projection)
- [x] hud.ts, title.ts (loading + title), menu.ts (pause/status, settings, controls, how, credits),
      inventory.ts (pack + map + fire help), end.ts (death + ending), touch.ts, index.ts (createUI)
- [x] all type-check (`npx tsc --noEmit -p . | grep src/ui`)
- [x] dev/ui.html + dev/ui.ts bench (fake View, every switch from the brief + page/sel/held/down/age/bg)
- [x] tools/ui-shots.mjs (20 screens x 1600 / 1280 / phone + portrait rotate; optional 4k)
- [x] model.test.ts (vitest, 7 pass)
- [x] first two review passes: fixed .dn class collision (downed block is now .dw), compass label
      positions (em on smaller type), label overlap priority, trend chevron moved onto the arc,
      legibility over snow (halo, soft smudges, toasts moved into the bottom band, words off-white,
      amber/red only for marks), phone layout (left column, narrow compass, place card yields to toasts)
- [ ] next: re-shoot all sizes, check 1280 and phone again, 4k once, touch multi-touch test in page

## Decisions / API facts

- createUI(game) mounts `.cs` under #ui (creates #ui if missing), injects one <style>.
- Screen order bottom->top: hud, touch, title, menu overlay, pack, end, loading, rotate notice.
- Keyboard: in modes title/pause/inventory/dead/won the UI listens on window keydown (capture),
  ignores the key whose timestamp is older than the mode change, and stops propagation of keys it
  uses. In play the UI handles no keys (game input does 1-5, Tab, Esc...).
- Toasts: only bus 'toast' is shown (game forwards sim toasts for me). Lore kind -> centred italic line.
- Death cause: last sim 'hurt' event for myId; else swim -> water, core <= 31 -> cold.
- Bench opens sub pages by clicking `[data-id=...]` elements (no contract change needed).

## Test commands

- type-check: `npx tsc --noEmit -p .` (filter: `| grep src/ui`)
- bench: `node tools/shot.mjs "dev/ui.html?mode=play&still=1" --out ui_test`
- all shots: `node tools/ui-shots.mjs`
