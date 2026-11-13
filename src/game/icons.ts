// UiGame.icon(item): a 128 px picture of every item for the pack, drawn in code on a canvas. Small
// still lifes rather than symbols (the HUD keeps the UI's line icons): each thing in its own worn
// material, lit from the upper left, resting on a soft shadow; radio parts carry the one amber accent.
// Drawn once on first request and cached. No image files.
// Owner: TOGETHER.
import type { ItemId } from '../sim/types';

const SIZE = 128;
const cache = new Map<ItemId, HTMLCanvasElement>();

type G = CanvasRenderingContext2D;

// --- palette (sRGB): worn, desaturated, cold; colour only where the thing is coloured
const METAL = ['#5b6168', '#2a2e33', '#14171a'];
const PAINT_RED = ['#8a3a2a', '#5c2318', '#2e110b'];
const WOOD = ['#8c6a46', '#5e4329', '#33231a'];
const CLOTH = ['#6f735f', '#4b4e3f', '#2a2c24'];
const PAPER = ['#d8d1bf', '#a8a091', '#6d675c'];
const BRASS = ['#b39250', '#7d6331', '#43341a'];
const AMBER = ['#e0a145', '#b07126', '#5f3a12'];
const PLASTIC = ['#3d4a44', '#27302c', '#121614'];

function lin(g: G, x0: number, y0: number, x1: number, y1: number, c: string[]): CanvasGradient {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, c[0]);
  gr.addColorStop(0.55, c[1]);
  gr.addColorStop(1, c[2]);
  return gr;
}

function shadow(g: G, cx: number, cy: number, rx: number, ry: number): void {
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rx);
  gr.addColorStop(0, 'rgba(0,0,0,0.45)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.translate(cx, cy);
  g.scale(1, ry / rx);
  g.translate(-cx, -cy);
  g.fillStyle = gr;
  g.beginPath();
  g.arc(cx, cy, rx, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function rrect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Fill the current path with a top-left lit gradient over its box, outline it, rim-light its top edge. */
function solid(g: G, c: string[], x: number, y: number, w: number, h: number): void {
  g.fillStyle = lin(g, x, y, x + w * 0.35, y + h, c);
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.stroke();
  g.save();
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  g.translate(1.2, 1.4);
  g.stroke();
  g.restore();
}

function box(g: G, c: string[], x: number, y: number, w: number, h: number, r = 4): void {
  rrect(g, x, y, w, h, r);
  solid(g, c, x, y, w, h);
}

/** Fine wear: scratches and grain across a box (deterministic). */
function wear(g: G, x: number, y: number, w: number, h: number, n: number, alpha = 0.12, seed = 1): void {
  g.save();
  rrect(g, x, y, w, h, 3);
  g.clip();
  g.strokeStyle = `rgba(255,255,255,${alpha})`;
  g.lineWidth = 0.8;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) {
    const px = x + rnd() * w, py = y + rnd() * h, l = 3 + rnd() * 9, a = (rnd() - 0.5) * 0.8;
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
    g.stroke();
  }
  g.restore();
}

function rotated(g: G, cx: number, cy: number, a: number, fn: () => void): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(a);
  g.translate(-cx, -cy);
  fn();
  g.restore();
}

// ------------------------------------------------------------------------------------------- items

const DRAW: Record<ItemId, (g: G) => void> = {
  axe(g) {
    shadow(g, 64, 104, 44, 9);
    rotated(g, 64, 64, -0.62, () => {
      box(g, WOOD, 60, 30, 9, 82, 4); // haft
      wear(g, 60, 30, 9, 82, 8, 0.1, 2);
      g.beginPath(); // head
      g.moveTo(52, 22); g.lineTo(74, 22); g.quadraticCurveTo(92, 18, 98, 8); g.lineTo(102, 40); g.quadraticCurveTo(90, 32, 74, 36); g.lineTo(52, 36); g.closePath();
      solid(g, METAL, 52, 8, 50, 32);
      g.strokeStyle = 'rgba(220,226,230,0.55)'; // the honed edge
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(98, 9); g.lineTo(102, 39); g.stroke();
    });
  },
  flashlight(g) {
    shadow(g, 64, 98, 46, 8);
    rotated(g, 64, 64, -0.32, () => {
      box(g, METAL, 22, 54, 62, 20, 6);
      wear(g, 22, 54, 62, 20, 10, 0.14, 3);
      g.beginPath(); g.moveTo(84, 52); g.lineTo(104, 46); g.lineTo(104, 82); g.lineTo(84, 76); g.closePath();
      solid(g, METAL, 84, 46, 20, 36);
      box(g, ['#c9d2d6', '#8a969c', '#4a5357'], 103, 47, 5, 34, 2); // lens rim
      box(g, PLASTIC, 44, 49, 12, 6, 2); // switch
    });
  },
  flaregun(g) {
    shadow(g, 64, 100, 46, 8);
    box(g, PAINT_RED, 22, 38, 76, 20, 6); // barrel
    wear(g, 22, 38, 76, 20, 12, 0.14, 4);
    g.beginPath(); g.moveTo(34, 56); g.lineTo(54, 56); g.lineTo(48, 98); g.lineTo(28, 96); g.closePath(); // grip
    solid(g, PAINT_RED, 28, 56, 26, 42);
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3; // trigger guard
    g.beginPath(); g.arc(60, 62, 8, 0, Math.PI); g.stroke();
    box(g, METAL, 96, 40, 8, 16, 2); // muzzle
  },
  rifle(g) {
    shadow(g, 64, 96, 54, 7);
    rotated(g, 64, 64, -0.28, () => {
      g.beginPath(); g.moveTo(6, 60); g.lineTo(54, 58); g.lineTo(58, 70); g.lineTo(30, 72); g.lineTo(8, 84); g.closePath(); // stock
      solid(g, WOOD, 6, 58, 52, 26);
      box(g, WOOD, 52, 58, 46, 10, 3); // fore-end
      box(g, METAL, 50, 52, 74, 6, 2); // barrel
      box(g, METAL, 54, 47, 22, 6, 2); // receiver and scope base
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2.5; // bolt
      g.beginPath(); g.moveTo(70, 50); g.lineTo(76, 42); g.stroke();
      wear(g, 6, 58, 92, 26, 10, 0.1, 5);
    });
  },
  radio(g) {
    shadow(g, 64, 104, 40, 8);
    box(g, PLASTIC, 30, 40, 68, 58, 8);
    wear(g, 30, 40, 68, 58, 14, 0.1, 6);
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3; // antenna
    g.beginPath(); g.moveTo(42, 40); g.lineTo(38, 12); g.stroke();
    for (let i = 0; i < 5; i++) { // speaker grille
      g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(38, 52 + i * 6); g.lineTo(62, 52 + i * 6); g.stroke();
    }
    g.beginPath(); g.arc(80, 62, 8, 0, Math.PI * 2); solid(g, METAL, 72, 54, 16, 16); // dial
    box(g, METAL, 96, 70, 12, 6, 2); // crank
    box(g, METAL, 104, 70, 6, 18, 2);
  },
  stick(g) {
    shadow(g, 64, 98, 48, 8);
    for (const [y, a, l] of [[70, -0.5, 92], [78, 0.35, 86], [64, 0.1, 80]] as const) {
      rotated(g, 64, y, a, () => {
        box(g, WOOD, 64 - l / 2, y - 4, l, 8, 4);
        wear(g, 64 - l / 2, y - 4, l, 8, 6, 0.15, Math.round(y));
        box(g, WOOD, 64 + l * 0.1, y - 12, 4, 10, 2); // a twig
      });
    }
  },
  log(g) {
    shadow(g, 64, 98, 46, 9);
    rotated(g, 64, 70, -0.18, () => {
      box(g, WOOD, 20, 52, 80, 34, 8);
      wear(g, 20, 52, 80, 34, 16, 0.14, 7);
      g.beginPath(); g.ellipse(100, 69, 9, 17, 0, 0, Math.PI * 2); // the split end
      solid(g, ['#c7a77c', '#9b7b52', '#5e4329'], 91, 52, 18, 34);
      g.strokeStyle = 'rgba(60,40,20,0.5)'; g.lineWidth = 1;
      for (const r of [5, 10]) { g.beginPath(); g.ellipse(100, 69, r * 0.5, r, 0, 0, Math.PI * 2); g.stroke(); }
    });
  },
  tinder(g) {
    shadow(g, 64, 98, 36, 8);
    g.lineCap = 'round';
    for (let i = 0; i < 28; i++) {
      const a = -1.2 + (i / 27) * 2.4 + Math.sin(i * 7.1) * 0.15, l = 26 + (i % 5) * 4;
      g.strokeStyle = i % 3 ? '#b49a6a' : '#7c6644';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(64, 92); g.quadraticCurveTo(64 + Math.sin(a) * l * 0.5, 92 - l * 0.6, 64 + Math.sin(a) * l, 92 - Math.cos(a) * l); g.stroke();
    }
    box(g, CLOTH, 50, 84, 28, 8, 3); // the twine
  },
  matches(g) {
    shadow(g, 64, 98, 40, 8);
    box(g, PAPER, 30, 50, 68, 42, 3);
    box(g, ['#7a3328', '#4f1f17', '#2a100c'], 30, 50, 68, 12, 3); // band
    wear(g, 30, 50, 68, 42, 10, 0.12, 8);
    rotated(g, 70, 46, -0.7, () => {
      box(g, ['#e3d6b4', '#bba985', '#7d6f55'], 64, 22, 5, 40, 2);
      g.beginPath(); g.ellipse(66.5, 22, 4.5, 6, 0, 0, Math.PI * 2);
      solid(g, ['#b8402a', '#7d2516', '#3a0f08'], 62, 16, 9, 12);
    });
  },
  flare(g) {
    shadow(g, 64, 100, 26, 7);
    box(g, PAINT_RED, 50, 28, 28, 60, 5);
    box(g, BRASS, 47, 82, 34, 12, 3);
    wear(g, 50, 28, 28, 60, 8, 0.12, 9);
    g.fillStyle = 'rgba(230,220,200,0.5)';
    g.fillRect(52, 46, 24, 4);
  },
  ammo(g) {
    shadow(g, 64, 100, 38, 8);
    for (const x of [40, 60, 80]) {
      box(g, BRASS, x - 7, 50, 14, 44, 3);
      g.beginPath(); g.moveTo(x - 6, 50); g.quadraticCurveTo(x, 26, x + 6, 50); g.closePath();
      solid(g, ['#b27b55', '#7d5233', '#45291a'], x - 6, 30, 12, 20);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x - 7, 86, 14, 3);
    }
  },
  cell(g) {
    shadow(g, 64, 100, 30, 8);
    box(g, ['#4b5a63', '#2c363c', '#151b1f'], 46, 34, 36, 62, 6);
    box(g, METAL, 56, 26, 16, 10, 2);
    g.fillStyle = 'rgba(224,161,69,0.85)';
    g.fillRect(50, 58, 28, 3);
    wear(g, 46, 34, 36, 62, 8, 0.12, 10);
  },
  bandage(g) {
    shadow(g, 64, 100, 40, 8);
    g.beginPath(); g.ellipse(56, 70, 28, 28, 0, 0, Math.PI * 2);
    solid(g, PAPER, 28, 42, 56, 56);
    g.beginPath(); g.ellipse(56, 70, 9, 9, 0, 0, Math.PI * 2);
    g.fillStyle = '#5e594f'; g.fill();
    box(g, PAPER, 74, 86, 32, 12, 2); // the loose end
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
    for (const r of [14, 19, 24]) { g.beginPath(); g.arc(56, 70, r, 0, Math.PI * 2); g.stroke(); }
  },
  ration(g) {
    shadow(g, 64, 100, 42, 8);
    g.beginPath(); g.moveTo(26, 46); g.lineTo(102, 46); g.lineTo(96, 96); g.lineTo(32, 96); g.closePath();
    solid(g, CLOTH, 26, 46, 76, 50);
    box(g, CLOTH, 24, 40, 80, 10, 3); // folded top
    wear(g, 26, 46, 76, 50, 14, 0.12, 11);
    g.fillStyle = 'rgba(216,209,191,0.55)';
    g.fillRect(44, 64, 40, 3);
    g.fillRect(44, 72, 30, 3);
  },
  thermos(g) {
    shadow(g, 64, 102, 28, 7);
    box(g, ['#4f6470', '#2e3d46', '#141c21'], 46, 36, 36, 62, 7);
    box(g, METAL, 48, 24, 32, 14, 4); // cup lid
    box(g, METAL, 46, 64, 36, 6, 2); // band
    wear(g, 46, 36, 36, 62, 12, 0.14, 12);
  },
  // --- radio parts: the amber accent
  part_battery(g) {
    shadow(g, 64, 100, 42, 8);
    box(g, ['#545b61', '#30353a', '#16191c'], 26, 44, 76, 52, 6);
    box(g, AMBER, 26, 60, 76, 12, 2);
    box(g, METAL, 36, 36, 12, 10, 2);
    box(g, METAL, 80, 36, 12, 10, 2);
    wear(g, 26, 44, 76, 52, 14, 0.12, 13);
  },
  part_handset(g) {
    shadow(g, 64, 100, 44, 8);
    rotated(g, 64, 64, -0.5, () => {
      box(g, PLASTIC, 30, 54, 68, 16, 7);
      g.beginPath(); g.ellipse(30, 62, 14, 18, 0, 0, Math.PI * 2); solid(g, PLASTIC, 16, 44, 28, 36);
      g.beginPath(); g.ellipse(98, 62, 14, 18, 0, 0, Math.PI * 2); solid(g, PLASTIC, 84, 44, 28, 36);
      g.fillStyle = AMBER[0];
      g.fillRect(50, 58, 28, 3);
    });
    g.strokeStyle = 'rgba(30,30,30,0.8)'; g.lineWidth = 2.5; // the coiled cord
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, x = 84 + t * 24, y = 86 + Math.sin(t * Math.PI * 8) * 4 + t * 10;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  },
  part_coil(g) {
    shadow(g, 64, 102, 34, 7);
    box(g, ['#3c3a35', '#26241f', '#11100d'], 52, 22, 24, 78, 5); // former
    for (let i = 0; i < 12; i++) {
      const y = 30 + i * 5.6;
      g.beginPath(); g.ellipse(64, y, 18, 3.2, 0, 0, Math.PI * 2);
      g.strokeStyle = i % 2 ? AMBER[1] : AMBER[0];
      g.lineWidth = 3;
      g.stroke();
    }
    g.strokeStyle = AMBER[2]; g.lineWidth = 2;
    g.beginPath(); g.moveTo(82, 30); g.lineTo(104, 22); g.stroke();
  },
  part_tube(g) {
    shadow(g, 64, 104, 26, 7);
    g.beginPath(); g.moveTo(48, 84); g.lineTo(48, 42); g.quadraticCurveTo(48, 18, 64, 18); g.quadraticCurveTo(80, 18, 80, 42); g.lineTo(80, 84); g.closePath();
    g.fillStyle = 'rgba(170,190,200,0.28)';
    g.fill();
    g.strokeStyle = 'rgba(220,235,240,0.55)'; g.lineWidth = 1.6; g.stroke();
    box(g, METAL, 56, 40, 16, 30, 2); // the electrode
    g.fillStyle = 'rgba(224,161,69,0.9)'; // a warm filament
    g.fillRect(62, 46, 4, 18);
    box(g, ['#4a3a2a', '#2c2218', '#15100b'], 44, 82, 40, 14, 3); // base
    for (const x of [52, 60, 68, 76]) box(g, BRASS, x - 1.5, 95, 3, 8, 1);
  },
  part_fuse(g) {
    shadow(g, 64, 98, 44, 8);
    rotated(g, 64, 64, -0.25, () => {
      box(g, BRASS, 20, 54, 18, 22, 3);
      box(g, BRASS, 90, 54, 18, 22, 3);
      rrect(g, 36, 56, 56, 18, 8);
      g.fillStyle = 'rgba(190,205,210,0.3)';
      g.fill();
      g.strokeStyle = 'rgba(220,235,240,0.55)'; g.lineWidth = 1.6; g.stroke();
      g.strokeStyle = AMBER[0]; g.lineWidth = 2; // the wire
      g.beginPath(); g.moveTo(38, 65);
      for (let i = 1; i <= 8; i++) g.lineTo(38 + i * 6.5, 65 + (i % 2 ? -4 : 4));
      g.stroke();
    });
  },
};

/** The pack picture for an item (128 x 128 canvas), or null where there is no DOM (tools in Node). */
export function itemIcon(item: ItemId): HTMLCanvasElement | null {
  const hit = cache.get(item);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const draw = DRAW[item];
  if (!draw) return null;
  const cv = document.createElement('canvas');
  cv.width = SIZE;
  cv.height = SIZE;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.lineJoin = 'round';
  draw(g);
  cache.set(item, cv);
  return cv;
}
