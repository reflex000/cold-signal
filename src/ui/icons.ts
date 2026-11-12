// Every icon in the interface, drawn here as thin line work on a 24 x 24 grid. Stroke colour is
// the text colour of the element they sit in (see `.ic` in css.ts).
import type { ItemId, PartId, ToolId } from '../sim/types';
import { svgEl } from './dom';

const P = (d: string, a = '') => `<path d="${d}"${a}/>`;
const C = (cx: number, cy: number, r: number, a = '') => `<circle cx="${cx}" cy="${cy}" r="${r}"${a}/>`;
const R = (deg: number, inner: string) => `<g transform="rotate(${deg} 12 12)">${inner}</g>`;
const F = ' class="f"'; // filled detail

export const ICONS = {
  // --- tools
  hands: P('M8.5 20.5H16.2V15.4C17.3 14.2 17.8 12.7 17.8 11V7.6C17.8 5.6 16.2 4 14.2 4H13.2C11.2 4 9.6 5.6 9.6 7.6V10.6L8.2 9.4C7.2 8.5 5.6 9.8 6.5 11L8.5 13.8Z') + P('M8.5 17.8H16.2'),
  axe: R(32, P('M12 8.6V21.6') + P('M10.6 5H13.5C15.2 5 16.9 4.4 18.2 3.4C19 5.3 19 8.2 18.2 10.1C16.9 9.1 15.2 8.6 13.5 8.6H10.6Z')),
  flashlight: R(-28, P('M3.2 10.2H12.8L16.8 7.9V16.1L12.8 13.8H3.2Z') + P('M6.6 10.2V9H9V10.2') + P('M19.4 12H22M19.1 9.2L21.2 8M19.1 14.8L21.2 16')),
  flaregun: P('M3.8 7H19.4V11.4H3.8Z') + P('M19.4 7.7H20.9V10.7H19.4') + P('M6.2 11.4L4.5 19.1L8.7 19.8L10.3 11.4') + P('M10.6 11.4C10.6 15 14.2 15 14.2 11.4') + P('M12.2 11.4V13.2') + P('M3.8 7L3 5.6'),
  rifle: R(-24, P('M1.6 11.2H15.4V12.9H8.2L2.2 15.6Z') + P('M15.4 11.7H23') + P('M9 12.9C9 14.6 11.4 14.6 11.4 12.9') + P('M10.6 11.2L11.9 9.8') + P('M22 11.7V10.8')),
  radio: P('M5 8.2H19V20H5Z') + P('M8 8.2V2.8') + C(15.4, 12.2, 1.7) + P('M7.4 11.2H11.4M7.4 13.4H11.4M7.4 15.6H11.4') + P('M19 15.6H21.4V18.2') + P('M14 16.8H17'),
  // --- fire making
  stick: P('M3.6 18.4L19.4 6.2') + P('M9.4 13.9L8.2 9.8') + P('M13.6 10.7L17.6 11.7') + P('M5.2 8.2L18.8 17.6') + P('M11.2 12.4L12.2 16.2'),
  log: R(-16, P('M5.2 8.6C3.2 8.6 3.2 16.4 5.2 16.4H18.6C20.6 16.4 20.6 8.6 18.6 8.6Z') + P('M5.2 8.6C7.2 8.6 7.2 16.4 5.2 16.4') + P('M10 11H15M11.6 13.8H17.6')),
  tinder: P('M12 20C12 14 9.2 10 6 7.4') + P('M12 20C12 13.4 13 8.8 15.6 4.8') + P('M12 20C12.6 15.4 15.6 12.6 19.2 11.6') + P('M12 20C11 16 8 14.2 4.8 14') + P('M8.4 20.4H15.6'),
  matches: P('M3.8 10.6H16.4V19.2H3.8Z') + P('M3.8 13.2H16.4') + P('M12.4 10.6L18.4 5') + C(19.2, 4.3, 1.15, F),
  // --- ammunition and cells
  flare: R(18, P('M8.6 4.4H15.4V16.4H8.6Z') + P('M7.6 16.4H16.4V19.8H7.6Z') + P('M8.6 7.4H15.4')),
  ammo: P('M6.4 20V10.6C6.4 8.2 7.4 5.6 8.2 4C9 5.6 10 8.2 10 10.6V20Z') + P('M6.4 17.4H10') + P('M13.6 20V12C13.6 9.8 14.6 7.4 15.4 6C16.2 7.4 17.2 9.8 17.2 12V20Z') + P('M13.6 17.4H17.2'),
  cell: P('M8.4 6.6H15.6V20.2H8.4Z') + P('M10.4 6.6V4.4H13.6V6.6') + P('M10.6 11H13.4M12 9.6V12.4') + P('M10.6 16.6H13.4'),
  // --- body
  bandage: C(9.8, 12, 5.6) + C(9.8, 12, 1.7) + P('M9.8 17.6H20.2V13.4H15.2'),
  ration: P('M6.4 5.4H17.6L16.6 20H7.4Z') + P('M6.9 8.4H17.1') + P('M10 12.6H14M10 15.2H14'),
  thermos: P('M8.8 7.6H15.2V20.6H8.8Z') + P('M9.8 7.6V5.4H14.2V7.6') + P('M10.8 5.4V3.4H13.2V5.4') + P('M8.8 11.2H15.2'),
  // --- radio parts
  part_battery: P('M4 9.2H20V19.2H4Z') + P('M6.6 9.2V7H9.6V9.2M14.4 9.2V7H17.4V9.2') + P('M6.6 13.8H9.6M8.1 12.3V15.3M14.4 13.8H17.4'),
  part_handset: P('M5.2 8.6C4.3 7.3 5.6 5.2 7.2 4.6L9.6 7.4L8.4 9.2C9.8 11.8 12.2 14.2 14.8 15.6L16.6 14.4L19.4 16.8C18.8 18.4 16.7 19.7 15.4 18.8C11 16.6 7.4 13 5.2 8.6Z'),
  part_coil: P('M8 5.2V18.8M16 5.2V18.8') + P('M8 8.2L16 6.6M8 10.8L16 9.2M8 13.4L16 11.8M8 16L16 14.4M8 18.6L16 17') + P('M16 6.6H19.8M8 18.6H4.2'),
  part_tube: P('M8.6 16V8.4C8.6 5.4 10.1 3.4 12 3.4C13.9 3.4 15.4 5.4 15.4 8.4V16Z') + P('M7.8 16H16.2V18.4H7.8Z') + P('M9.6 18.4V21M12 18.4V21M14.4 18.4V21') + P('M10.6 8.6H13.4V13H10.6Z'),
  part_fuse: R(-20, P('M3.2 9.2H7.4V14.8H3.2ZM16.6 9.2H20.8V14.8H16.6Z') + P('M7.4 10H16.6M7.4 14H16.6') + P('M7.4 12C9.4 10.4 10.4 13.6 12 12C13.6 10.4 14.6 13.6 16.6 12')),
  // --- what the body feels
  shelter: P('M3.6 13.4L12 6.2L20.4 13.4') + P('M6.8 11.4V18.6M17.2 11.4V18.6'),
  fire: P('M12 3.4C12.6 7 16.8 9.2 16.8 14C16.8 17.4 14.6 20.2 12 20.2C9.4 20.2 7.2 17.4 7.2 14C7.2 12 8.2 10.4 9.4 9.4C9.5 11 10.2 11.8 11 12.2C10.4 9 11 5.6 12 3.4Z'),
  wet: P('M12 3.8C14.5 7.9 17 11 17 14.5C17 17.6 14.8 20.2 12 20.2C9.2 20.2 7 17.6 7 14.5C7 11 9.5 7.9 12 3.8Z'),
  wind: P('M3.4 9H13.4C16.6 9 16.6 4.8 13.8 4.8C12.6 4.8 12 5.7 12 6.6') + P('M3.4 12.6H18C21.2 12.6 21.2 17 18 17C17 17 16.4 16.3 16.3 15.5') + P('M3.4 16.2H11.4C13.8 16.2 13.8 19.6 11.6 19.6'),
  huddle: C(8.4, 8, 2.3) + C(15.6, 8, 2.3) + P('M4.4 19.2C4.4 15 6 12.8 8.4 12.8C10.1 12.8 11.4 13.8 12 15.2C12.6 13.8 13.9 12.8 15.6 12.8C18 12.8 19.6 15 19.6 19.2'),
  health: P('M2.8 12.4H8L10 7.4L13.6 17.2L15.6 12.4H21.2'),
  stamina: P('M4 15.5C7 15.5 7.5 8.5 11 8.5C14 8.5 13.5 13 16 13C18 13 18.5 11 20 11'),
  // --- controls and marks
  up: P('M6.8 14.4L12 9.2L17.2 14.4'),
  down: P('M6.8 9.6L12 14.8L17.2 9.6'),
  warn: P('M12 4.4L20.6 19.2H3.4Z') + P('M12 10V14.6') + C(12, 16.9, 0.5, F),
  info: C(12, 12, 8.2) + P('M12 11V16.4') + C(12, 8.2, 0.5, F),
  diamond: P('M12 4.6L19.4 12L12 19.4L4.6 12Z'),
  check: P('M5.4 12.6L10 17.2L18.6 7.4'),
  close: P('M6.4 6.4L17.6 17.6M17.6 6.4L6.4 17.6'),
  pack: P('M7.4 8.6C7.4 6 9.4 4.6 12 4.6C14.6 4.6 16.6 6 16.6 8.6V19.6H7.4Z') + P('M9.6 13H14.4V16.6H9.6Z') + P('M7.4 10.6H5.6V16H7.4M16.6 10.6H18.4V16H16.6') + P('M10.2 4.9V3.2H13.8V4.9'),
  pause: P('M9 6V18M15 6V18'),
  jump: P('M12 17V6M7.4 10.6L12 6L16.6 10.6') + P('M7 20.2H17'),
  crouch: P('M7.4 5.6L12 10.2L16.6 5.6') + P('M7.4 11L12 15.6L16.6 11') + P('M7 20.2H17'),
  sprint: P('M6.8 12.4L12 7.2L17.2 12.4') + P('M6.8 18L12 12.8L17.2 18'),
  aim: C(12, 12, 5.2) + P('M12 2.8V6.8M12 17.2V21.2M2.8 12H6.8M17.2 12H21.2'),
  wheel: C(12, 12, 8.4) + C(12, 5.6, 0.9, F) + C(17.5, 8.8, 0.9, F) + C(17.5, 15.2, 0.9, F) + C(12, 18.4, 0.9, F) + C(6.5, 15.2, 0.9, F) + C(6.5, 8.8, 0.9, F),
  reload: P('M18.6 12C18.6 15.6 15.6 18.6 12 18.6C8.4 18.6 5.4 15.6 5.4 12C5.4 8.4 8.4 5.4 12 5.4C14 5.4 15.8 6.3 17 7.7') + P('M17.4 4V7.9H13.5'),
  light: P('M9 17.2H15M10 20H14') + P('M8.6 14.6C7.2 13.6 6.2 11.9 6.2 10C6.2 6.8 8.8 4.2 12 4.2C15.2 4.2 17.8 6.8 17.8 10C17.8 11.9 16.8 13.6 15.4 14.6Z'),
  revive: C(12, 12, 8.2) + P('M12 8V16M8 12H16'),
  rotate: P('M5 12.4H19C20.1 12.4 21 13.3 21 14.4V18C21 19.1 20.1 20 19 20H5C3.9 20 3 19.1 3 18V14.4C3 13.3 3.9 12.4 5 12.4Z') + P('M4.4 9.4V7C4.4 5.6 5.5 4.5 6.9 4.5H13.4') + P('M11.2 2.3L13.4 4.5L11.2 6.7'),
  me: P('M12 4.4L17.4 18.8L12 15.6L6.6 18.8Z'),
} as const;

export type IconName = keyof typeof ICONS;

/**
 * A line icon. `halo` draws a dark copy underneath so the icon holds on bright snow without a
 * filter (filters on things that move every frame are expensive on phones).
 */
export function icon(name: IconName, cls = '', parent?: Node | null, halo = false): SVGSVGElement {
  const inner = ICONS[name];
  return svgEl(halo ? `<g class="ih">${inner}</g><g>${inner}</g>` : inner, cls ? 'ic ' + cls : 'ic', '0 0 24 24', parent);
}

/** Swap the drawing of an existing icon element. */
export function setIcon(el: SVGSVGElement, name: IconName, halo = false): void {
  const a = el as unknown as { _n?: string };
  if (a._n === name) return;
  a._n = name;
  const inner = ICONS[name];
  el.innerHTML = halo ? `<g class="ih">${inner}</g><g>${inner}</g>` : inner;
}

export const itemIcon = (item: ItemId): IconName => item;
export const toolIcon = (tool: ToolId): IconName => tool;
export const partIcon = (part: PartId): IconName => `part_${part}`;
