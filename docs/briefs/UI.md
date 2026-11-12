# Brief: UI
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: UI. Files you own: src/ui/** except src/ui/api.ts (frozen contract), dev/ui.html, dev/ui.ts,
tools/ui-shots.mjs.

Build export function createUI(game: UiGame): UiApi in src/ui/index.ts per src/ui/api.ts: all DOM and CSS under
document.getElementById('ui'), reading game.view (src/game/view.ts: View, Hud, Settings, Mode, bus), calling
game.actions and reporting touch controls to game.touch. The UI never imports three or the simulation code
(types only). CSS is a string injected by the module. Fonts: system stacks only (a clean grotesque for text,
e.g. "Inter", "Segoe UI", "Helvetica Neue", system-ui; a condensed face for numbers and titles, e.g.
"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow"). Icons are inline SVG paths written in code
(tools, items, parts, status). Art direction: DESIGN.md section 2: sparse, quiet, thin type, off-white on
near-black, one amber accent, no cards, chips or badges, nothing that looks like a web app. It should feel
like a film title sequence and a mountaineer's instrument, not a dashboard.

Screens and elements:
- Loading (bus 'loading': a thin line and one label), then Title: the name COLD SIGNAL set large and airy over
  the live scene (the game renders behind it), New game / Continue (if actions.hasSave()) / Settings / How to
  play / a line of credits; keyboard, mouse, gamepad-friendly and touch.
- HUD in 'play' (pointer is locked on desktop: nothing needs the mouse): body temperature as the central
  instrument (core in degrees with a trend arrow from me.trend, a slim arc or bar that changes character through
  the stages healthy / cold / freezing / severe; shelter, fire warmth, wet and wind-chill shown as small quiet
  marks only when they matter), health and stamina that fade out when full, a compass strip with marks
  (hud.marks), the held tool with ammunition / charge, a tool belt (1 to 5 keys; touch: a tool wheel), the focus
  prompt with a hold ring (hud.focus), the objective line, the five radio-part slots, toasts (bus 'toast'), a
  place card when entering a POI (bus 'place'), hints (hud.hint), teammates (name, state, core, distance, a
  marker when downed), crosshair per hud.crosshair, the downed state (bleed timer, crawl hint, "a teammate can
  revive you"), and reviving progress. Everything fades or hides when not needed; in a clear calm moment
  almost nothing is on screen.
- Inventory (mode 'inventory'): the pack laid out as a grid of drawn icons with counts, tools, parts, actions
  (use, drop, give to a nearby teammate), fire-making help (what is needed to build and light a fire).
- Pause and Settings: quality (auto / mobile / low / medium / high / ultra), render scale, field of view,
  sensitivity, invert Y, volumes, camera shake, film grain, hints, companions (bots 0..3), show FPS; shows
  game.gpu. Controls reference for keyboard / mouse, gamepad and touch.
- Death (what killed you, time survived, Respawn / Quit) and the ending (stats from view.stats, credits).
- Touch (view.touch): a left thumb stick that appears where the thumb lands, look by dragging on the right
  half, buttons sized and placed for thumbs (primary / fire, aim, use (shows the focus verb), jump, crouch,
  sprint lock, tool wheel, pack, pause), multi-touch correct (move and look and a button at once), reporting
  through game.touch (move, look, button with BTN bits from src/sim/types.ts) and game.actions. Respect
  safe-area insets and landscape; a "rotate your phone" notice in portrait. Tap targets at least 44 CSS px.
- Layout: position fixed over the canvas, sized with clamp(), vmin and %, reads from 844 x 390 (phone) through
  1280 x 720 to 3840 x 2160. Animations are short and calm. update(dt) writes to the DOM only when a value changed.
- dev/ui.html + dev/ui.ts: a bench that builds a complete fake View (every field) over a still, snowy
  placeholder background (a CSS gradient that resembles a dusk snow slope so contrast can be judged), with
  query switches: ?mode=title|play|pause|inventory|dead|won&cold=0..1&hurt=0..1&touch=1&focus=1&team=3&
  toasts=1&storm=1 and fake values animating slowly. tools/ui-shots.mjs: shoot every screen at 1600 x 900,
  1280 x 720 and on --mobile (844 x 390, touch=1) into shots/ui_*.jpg. Read them all. Judge harshly: alignment,
  rhythm, legibility over a bright snow background, whether it looks designed. Iterate.


STATE ON DISK (handoff note: docs/status/UI.md): src/ui/dom.ts, icons.ts (7 KB), text.ts (8 KB), css.ts (38 KB),
nav.ts (9 KB). An optional UiGame.sfx was added to api.ts. MISSING: src/ui/index.ts (createUI) and every screen
module (HUD, title, pause and settings, inventory, death and ending, touch controls), dev/ui.html, dev/ui.ts,
tools/ui-shots.mjs. Nothing has been rendered yet.
