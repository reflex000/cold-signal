// CONTRACT for the interface: DOM and CSS over the canvas. The UI never touches three.js or the
// simulation. It reads `game.view`, listens to `game.view.bus` and calls `game.actions`.
// Owner: MAIN (interface); UI implements src/ui/index.ts `createUI(game): UiApi`.
import type { GameActions, TouchSink, View } from '../game/view';
import type { ItemId } from '../sim/types';

export interface UiGame {
  view: View;
  actions: GameActions;
  /** Where the on-screen touch controls report (only used when view.touch is true). */
  touch: TouchSink;
  /** 128 px icon for an item, drawn in code (canvas), or null while not ready. */
  icon(item: ItemId): HTMLCanvasElement | null;
  /** Top-down map of the mountain drawn from the world data (lazy), and world->uv. */
  map(): { canvas: HTMLCanvasElement; toUV(x: number, z: number): [number, number] } | null;
  /** Info for the settings screen. */
  gpu: { backend: 'webgpu' | 'webgl2'; adapter: string };
  /** Optional: interface sounds (menu move, select, open, close). Wire to AudioApi.sfx. */
  sfx?(name: 'ui_hover' | 'ui_click' | 'ui_open' | 'ui_close'): void;
}

export interface UiApi {
  /** Once per rendered frame. Cheap: touches the DOM only when a value changed. */
  update(dt: number): void;
  /** True while a UI screen wants the mouse (pointer lock must be released). */
  wantsPointer(): boolean;
  dispose(): void;
}
