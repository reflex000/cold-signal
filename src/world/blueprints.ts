// Blueprints: the footprint of every structure the player walks into or collides with, as
// pure data. The simulation collides with these boxes, the model engineers build the visible
// walls from the same numbers, so the wall you see is the wall you hit.
//
// LOCAL SPACE of a blueprint: metres, Y up, origin on the ground at the structure's anchor
// point, +Z is the FRONT (where the main opening is), +X is to the right when you stand inside
// looking out of the front... i.e. plain three.js object space.
//
// PLACING: world = position + Ry(yaw) * local, exactly `object.rotation.y = yaw` in three.js:
//     wx = x + lx * cos(yaw) + lz * sin(yaw)
//     wz = z - lx * sin(yaw) + lz * cos(yaw)
// so the front of a structure placed with yaw points along (sin yaw, cos yaw): yaw 0 faces
// south / downhill (+Z), yaw PI/2 faces east. PropInst.yaw, Poi.yaw, box collider yaw, Floor.yaw,
// ShelterVol.yaw and anchor yaw all use this convention. (A PLAYER yaw looks down -Z instead,
// so a player facing the way an anchor faces has yaw = anchor.yaw + PI.)
//
// Boxes are vertical prisms: centre (x, z), half extents (hx along local X, hz along local Z)
// rotated by `yaw` about Y, from height y0 to y1 above the structure's ground. Windows do not
// cut colliders (nobody climbs through); doors, breaks and the cave mouth are real gaps.
// Floors are walkable rectangles at height y; World.groundAt lets a walker step up 0.5 m, so
// thresholds are built as stacked floors no more than 0.3 m apart.
import type { Surface } from '../sim/types';
import { datan2, dcos, dlen, dsin } from './dmath';
import type { Collider, Floor, PoiId, ShelterVol } from './types';

export type SolidKind = 'wall' | 'furniture' | 'rock';

export interface BpBox {
  x: number; z: number; hx: number; hz: number; yaw: number; y0: number; y1: number;
  kind: SolidKind;
  /** What the box is, for the modeller: 'hull', 'wall', 'stove', 'bed', 'table', 'shelf', 'seat' ... */
  tag: string;
}
export interface BpPost { x: number; z: number; r: number; y0: number; y1: number; kind: SolidKind; tag: string }
export interface BpFloor { x: number; z: number; hx: number; hz: number; yaw: number; y: number; surface: Surface; tag: string }
export interface BpShelter { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; amount: number; indoor: boolean }
/** A named point. `yaw` is the direction something placed there faces (model convention). */
export interface BpAnchor { x: number; y: number; z: number; yaw: number }
/** A hole in the shell, for the modeller. (x, y, z) is the centre of its sill / threshold. */
export interface BpOpening { kind: 'door' | 'window' | 'break' | 'mouth' | 'exit'; x: number; y: number; z: number; yaw: number; w: number; h: number }

export interface Blueprint {
  name: string;
  /** Overall size of the visible structure (x across, y tall, z front to back). */
  size: { x: number; y: number; z: number };
  /** Circle (local) kept free of trees, rocks, scattered items and the trail. */
  clear: { x: number; z: number; r: number };
  boxes: BpBox[];
  posts: BpPost[];
  floors: BpFloor[];
  shelters: BpShelter[];
  anchors: Record<string, BpAnchor>;
  openings: BpOpening[];
}

// ------------------------------------------------------------------------------------------
// builders
// ------------------------------------------------------------------------------------------
function box(tag: string, x: number, z: number, hx: number, hz: number, y0: number, y1: number, kind: SolidKind = 'wall', yaw = 0): BpBox {
  return { x, z, hx, hz, yaw, y0, y1, kind, tag };
}

/**
 * A straight wall from (x0, z0) to (x1, z1), `t` thick, with gaps given as [from, to] distances
 * in metres from the start point.
 */
function run(tag: string, x0: number, z0: number, x1: number, z1: number, t: number, y0: number, y1: number, kind: SolidKind = 'wall', gaps: [number, number][] = []): BpBox[] {
  const dx = x1 - x0, dz = z1 - z0;
  const len = dlen(dx, dz);
  const ux = dx / len, uz = dz / len;
  const yaw = datan2(-dz, dx); // local X of the box along the wall
  const out: BpBox[] = [];
  const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
  let from = 0;
  const piece = (a: number, b: number) => {
    if (b - a < 0.02) return;
    const m = (a + b) / 2;
    out.push({ x: x0 + ux * m, z: z0 + uz * m, hx: (b - a) / 2, hz: t / 2, yaw, y0, y1, kind, tag });
  };
  for (const g of sorted) {
    piece(from, g[0]);
    from = g[1];
  }
  piece(from, len);
  return out;
}

/**
 * Walls around a polygon given as interior corner points: one box per edge, `t` thick, lying
 * outside the edge and overlapping at the corners. Edges listed in `open` are left out.
 */
function ring(tag: string, pts: [number, number][], t: number, y0: number, y1: number, kind: SolidKind, open: number[] = []): BpBox[] {
  let cx = 0, cz = 0;
  for (const p of pts) {
    cx += p[0];
    cz += p[1];
  }
  cx /= pts.length;
  cz /= pts.length;
  const out: BpBox[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (open.includes(i)) continue;
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = dlen(dx, dz);
    let nx = dz / len, nz = -dx / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ x: mx + nx * t / 2, z: mz + nz * t / 2, hx: len / 2 + t * 0.45, hz: t / 2, yaw: datan2(-dz, dx), y0, y1, kind, tag });
  }
  return out;
}

const A = (x: number, y: number, z: number, yaw = 0): BpAnchor => ({ x, y, z, yaw });
const PI = Math.PI;

// ------------------------------------------------------------------------------------------
// FUSELAGE  (model 'fuselage')  18 m of a 3.6 m tube, nose at +Z, torn open at -Z.
//
//                 +Z  nose (crushed, closed)
//         z=+9.0  .-======-.
//                 |########|   cockpit, not enterable
//         z=+6.3  |--------|   bulkhead: locker (L) on -X side, galley shelf (G) on +X side
//                 | L    G |
//                 | SS  SS |   seat rows at z=+4.4, +3.4 (-X) and z=+4.4 (+X)
//                 | SS     |
//                 |        = exit   over-wing exit, +X side, z 0.4..1.4 (a 'wing' lies outside)
//                 |   aisle|
//                 | SS     |   seat row at z=-2.6 (-X)
//                 |        |   floor y=0.36 (metal)
//         z=-8.0  |- - - - |   torn floor edge, step y=0.18
//         z=-9.0  ~~~~~~~~~~   the break: fully open, 3.1 m wide
//               x=-1.8   +1.8
//                 -Z  (players start just outside; the skid scar runs away along -Z)
// ------------------------------------------------------------------------------------------
const FUSELAGE: Blueprint = {
  name: 'fuselage',
  size: { x: 3.6, y: 3.6, z: 18 },
  clear: { x: 0, z: 0, r: 11.5 },
  boxes: [
    ...run('hull', -1.68, -9, -1.68, 9, 0.24, 0, 3.4),
    ...run('hull', 1.68, -9, 1.68, 9, 0.24, 0, 3.4, 'wall', [[9.4, 10.4]]),
    box('bulkhead', 0, 6.42, 1.56, 0.12, 0, 3.4),
    box('nose', 0, 8.9, 1.56, 0.12, 0, 3.4),
    box('seat', -0.92, 4.4, 0.64, 0.3, 0.36, 1.42, 'furniture'),
    box('seat', -0.92, 3.4, 0.64, 0.3, 0.36, 1.42, 'furniture'),
    box('seat', 0.92, 4.4, 0.64, 0.3, 0.36, 1.42, 'furniture'),
    box('seat', -0.92, -2.6, 0.64, 0.3, 0.36, 1.42, 'furniture'),
    box('galley', 1.16, 5.86, 0.4, 0.44, 0.36, 1.26, 'furniture'),
  ],
  posts: [],
  floors: [
    { x: 0, z: -0.85, hx: 1.56, hz: 7.15, yaw: 0, y: 0.36, surface: 'metal', tag: 'cabin floor' },
    { x: 0, z: -8.6, hx: 1.5, hz: 0.6, yaw: 0, y: 0.18, surface: 'metal', tag: 'torn floor step' },
  ],
  shelters: [
    { x: 0, y: 1.6, z: 0.4, hx: 1.56, hy: 1.6, hz: 5.9, yaw: 0, amount: 0.9, indoor: true },
    { x: 0, y: 1.6, z: -7.25, hx: 1.56, hy: 1.6, hz: 1.75, yaw: 0, amount: 0.6, indoor: true },
  ],
  anchors: {
    break: A(0, 0, -9.4, PI),
    exit: A(1.68, 0.36, 0.9, PI / 2),
    locker: A(-1.05, 0.36, 5.8, PI),
    galley: A(1.16, 1.28, 5.86, PI),
    seat1: A(-0.3, 0.36, 3.9, 0),
    loot1: A(0.9, 0.36, 2.6, -PI / 2),
    loot2: A(-0.95, 0.36, -4.6, PI / 2),
    medkit: A(1.3, 0.36, -1.2, -PI / 2),
    note: A(0.3, 0.36, 5.6, PI),
    bot1: A(0.6, 0.36, -6.2, PI),
    bot2: A(-0.6, 0.36, -4.8, PI),
    bot3: A(0.5, 0.36, -3.2, PI),
  },
  openings: [
    { kind: 'break', x: 0, y: 0, z: -9, yaw: PI, w: 3.12, h: 3.2 },
    { kind: 'exit', x: 1.68, y: 0.36, z: 0.9, yaw: PI / 2, w: 1.0, h: 1.5 },
  ],
};

// ------------------------------------------------------------------------------------------
// TAIL SECTION  (model 'tail_section')  9 m of tapering tail cone, the break at +Z.
//
//         z=+4.5  ~~~~~~~~~~~   the break, 3.2 m wide
//                 |  step   |   y=0.15
//         z=+3.7  |         |   cargo floor y=0.30 (metal)
//                 | c2   c1 |   c1: the axe   c2: cargo crate
//                  \  P    /    P: ELT rack on the -X wall (the battery)
//                   \ c3  /     the fin stands over z -4..-1
//         z=-4.5     \___/      closed tail cone, 1.6 m wide
// ------------------------------------------------------------------------------------------
const TAIL: Blueprint = {
  name: 'tail_section',
  size: { x: 3.4, y: 6.5, z: 9 },
  clear: { x: 0, z: 0, r: 6.5 },
  boxes: [
    ...run('hull', -1.6, 4.5, -0.8, -4.5, 0.22, 0, 3.0),
    ...run('hull', 1.6, 4.5, 0.8, -4.5, 0.22, 0, 3.0),
    ...run('hull', -0.9, -4.5, 0.9, -4.5, 0.22, 0, 3.0),
    box('elt rack', -0.98, -1.2, 0.16, 0.4, 0.3, 1.5, 'furniture', -0.089),
  ],
  posts: [],
  floors: [
    { x: 0, z: -0.4, hx: 0.95, hz: 4.0, yaw: 0, y: 0.3, surface: 'metal', tag: 'cargo floor' },
    { x: 0, z: 2.0, hx: 1.32, hz: 1.7, yaw: 0, y: 0.3, surface: 'metal', tag: 'cargo floor (wide)' },
    { x: 0, z: 4.15, hx: 1.4, hz: 0.45, yaw: 0, y: 0.15, surface: 'metal', tag: 'step' },
  ],
  shelters: [{ x: 0, y: 1.5, z: -0.6, hx: 1.3, hy: 1.5, hz: 3.8, yaw: 0, amount: 0.75, indoor: true }],
  anchors: {
    break: A(0, 0, 5.2, 0),
    part: A(-0.72, 0.3, -1.2, PI / 2),
    cargo1: A(0.7, 0.3, 1.2, 0.6),
    cargo2: A(-0.7, 0.3, 2.3, PI / 2),
    cargo3: A(0.1, 0.3, -2.9, 0),
    note: A(0.6, 0.3, -0.6, -PI / 2),
    bot1: A(0.2, 0.3, 2.9, 0),
    bot2: A(-0.2, 0.3, 0.4, 0),
  },
  openings: [{ kind: 'break', x: 0, y: 0, z: 4.5, yaw: 0, w: 3.0, h: 2.8 }],
};

// ------------------------------------------------------------------------------------------
// RANGER CABIN  (model 'cabin')  6 x 5 m log cabin, door and porch on the front (+Z).
//
//        x=-3                               x=+3
//  z=-2.5 +----------------------------------+      back wall
//         | [stove]   [shelf2]     [  bed  ] |      stove (-2.2,-1.8)   bed 2.0 x 0.9
//         |    o                             |      o: chimney pipe
//         |[s]                               W      W: window, east wall, z -0.6..0.6
//         |[1]                               |      shelf1 on the west wall
//         |[cupboard]              [ table ] |      table under the front window
//  z=+2.5 +---[ door ]---------WWWWWW--------+      door gap x -1.6..-0.7; window x 0.9..2.1
//         |            porch  y=0.15         |      floor inside y=0.30 (wood)
//  z=+3.9 +..................................+      porch roof on posts
// ------------------------------------------------------------------------------------------
const CABIN: Blueprint = {
  name: 'cabin',
  size: { x: 6, y: 4.2, z: 6.4 },
  clear: { x: 0, z: 0.6, r: 6.4 },
  boxes: [
    ...run('wall', -3, -2.4, 3, -2.4, 0.2, 0, 2.6),
    ...run('wall', -2.9, -2.5, -2.9, 2.5, 0.2, 0, 2.6),
    ...run('wall', 2.9, -2.5, 2.9, 2.5, 0.2, 0, 2.6),
    ...run('wall', -3, 2.4, 3, 2.4, 0.2, 0, 2.6, 'wall', [[1.4, 2.3]]),
    box('stove', -2.2, -1.8, 0.36, 0.36, 0.3, 1.15, 'furniture'),
    box('bed', 1.8, -1.85, 1.0, 0.45, 0.3, 0.85, 'furniture'),
    box('table', 2.0, 1.72, 0.7, 0.45, 0.3, 1.05, 'furniture'),
    box('shelf', -2.64, -0.1, 0.16, 0.7, 0.3, 1.9, 'furniture'),
    box('shelf', -0.2, -2.14, 0.7, 0.16, 0.3, 1.9, 'furniture'),
    box('cupboard', -2.5, 1.75, 0.3, 0.45, 0.3, 1.5, 'furniture'),
  ],
  posts: [
    { x: -2.85, z: 3.8, r: 0.08, y0: 0, y1: 2.3, kind: 'wall', tag: 'porch post' },
    { x: 2.85, z: 3.8, r: 0.08, y0: 0, y1: 2.3, kind: 'wall', tag: 'porch post' },
  ],
  floors: [
    { x: 0, z: 0, hx: 2.8, hz: 2.5, yaw: 0, y: 0.3, surface: 'wood', tag: 'floor' },
    { x: 0, z: 3.2, hx: 3.0, hz: 0.7, yaw: 0, y: 0.15, surface: 'wood', tag: 'porch' },
  ],
  shelters: [
    { x: 0, y: 1.5, z: 0, hx: 2.8, hy: 1.5, hz: 2.3, yaw: 0, amount: 1, indoor: true },
    { x: 0, y: 1.3, z: 3.2, hx: 3.0, hy: 1.3, hz: 0.7, yaw: 0, amount: 0.55, indoor: false },
  ],
  anchors: {
    door: A(-1.15, 0.3, 2.4, 0),
    porch: A(-1.15, 0.15, 3.3, 0),
    stove: A(-2.2, 0.3, -1.8, 0),
    hearth: A(-1.45, 0.3, -1.35, 0),
    bed: A(1.8, 0.86, -1.85, 0),
    bedside: A(1.6, 0.3, -1.0, PI),
    table: A(1.75, 1.06, 1.72, PI),
    table2: A(2.3, 1.06, 1.72, PI),
    shelf1: A(-2.62, 1.36, -0.45, PI / 2),
    shelf1b: A(-2.62, 1.36, 0.25, PI / 2),
    shelf2: A(-0.55, 1.36, -2.12, 0),
    shelf2b: A(0.15, 1.36, -2.12, 0),
    rack: A(0.6, 1.55, -2.24, 0),
    cupboard: A(-2.1, 0.3, 1.75, PI / 2),
    note: A(1.45, 1.06, 1.6, PI),
    chimney: A(-2.2, 4.4, -1.8, 0),
    bot1: A(-1.2, 0.3, -0.8, PI),
    bot2: A(-0.2, 0.3, -1.0, PI),
    bot3: A(0.6, 0.3, 0.2, PI),
  },
  openings: [
    { kind: 'door', x: -1.15, y: 0.3, z: 2.4, yaw: 0, w: 0.9, h: 1.95 },
    { kind: 'window', x: 1.5, y: 1.25, z: 2.4, yaw: 0, w: 1.2, h: 0.8 },
    { kind: 'window', x: 2.9, y: 1.25, z: 0, yaw: PI / 2, w: 1.2, h: 0.8 },
  ],
};

// WOODSHED (model 'woodshed')  3 x 1.6 m lean-to, open at the front (+Z).
//   z=-0.8 +-----------+   back and both sides are plank walls 1.9 m tall;
//          |  stacked  |   split wood is stacked along the back
//   z=+0.8 +           +   open front
const WOODSHED: Blueprint = {
  name: 'woodshed',
  size: { x: 3, y: 2.2, z: 1.6 },
  clear: { x: 0, z: 0.3, r: 3.0 },
  boxes: [
    ...run('wall', -1.5, -0.74, 1.5, -0.74, 0.12, 0, 1.9),
    ...run('wall', -1.44, -0.8, -1.44, 0.8, 0.12, 0, 1.9),
    ...run('wall', 1.44, -0.8, 1.44, 0.8, 0.12, 0, 1.9),
    box('woodpile', 0, -0.4, 1.3, 0.25, 0, 1.1, 'furniture'),
  ],
  posts: [],
  floors: [],
  shelters: [{ x: 0, y: 1, z: 0.1, hx: 1.38, hy: 1, hz: 0.7, yaw: 0, amount: 0.6, indoor: false }],
  anchors: { block: A(0, 0, 2.0, 0), pile: A(0, 1.1, -0.4, 0) },
  openings: [],
};

// ------------------------------------------------------------------------------------------
// ICE-FISHING HUT  (model 'fishing_hut')  2.5 x 2.5 m plywood shack on skids, door on +Z.
//
//  z=-1.25 +-------------+
//          |[shelf]      |    shelf on the back wall (the fuse lies on it)
//          |b    (hole)  |    b: bench along the -X wall; fishing hole in the floor
//          |b            |    floor y=0.10 (wood)
//  z=+1.25 +---[door]----+    door gap x -0.4..0.4
// ------------------------------------------------------------------------------------------
const HUT: Blueprint = {
  name: 'fishing_hut',
  size: { x: 2.5, y: 2.4, z: 2.5 },
  clear: { x: 0, z: 0, r: 2.6 },
  boxes: [
    ...run('wall', -1.25, -1.2, 1.25, -1.2, 0.1, 0, 2.2),
    ...run('wall', -1.2, -1.25, -1.2, 1.25, 0.1, 0, 2.2),
    ...run('wall', 1.2, -1.25, 1.2, 1.25, 0.1, 0, 2.2),
    ...run('wall', -1.25, 1.2, 1.25, 1.2, 0.1, 0, 2.2, 'wall', [[0.85, 1.65]]),
    box('bench', -0.92, 0.1, 0.22, 0.85, 0.1, 0.55, 'furniture'),
    box('shelf', 0.45, -1.02, 0.6, 0.12, 0.1, 1.2, 'furniture'),
  ],
  posts: [],
  floors: [{ x: 0, z: 0, hx: 1.15, hz: 1.2, yaw: 0, y: 0.1, surface: 'wood', tag: 'floor' }],
  shelters: [{ x: 0, y: 1.1, z: 0, hx: 1.15, hy: 1.1, hz: 1.15, yaw: 0, amount: 0.95, indoor: true }],
  anchors: {
    door: A(0, 0.1, 1.2, 0),
    part: A(0.5, 1.22, -1.0, 0),
    shelf: A(0.15, 1.22, -1.0, 0),
    toolbox: A(0.72, 0.1, 0.55, -PI / 2),
    hole: A(0.15, 0.1, -0.2, 0),
    note: A(0.8, 1.22, -1.0, 0),
    bot1: A(0.1, 0.1, 0.5, PI),
  },
  openings: [{ kind: 'door', x: 0, y: 0.1, z: 1.2, yaw: 0, w: 0.8, h: 1.85 }],
};

// ------------------------------------------------------------------------------------------
// THE CAVE  (model 'cave_rocks')  a rock chamber built against the foot of the cliff band.
// The mouth is at +Z (it faces downhill), the chamber runs 9.2 m back into the cliff.
// The terrain under it is a flat pad; every wall here is rock the modeller piles up, 4.4 m
// tall, roofed over (the roof is not a collider).
//
//                    cliff
//         z=-9.2     ._______.
//                   /   den   \         den: where the wolves lie up
//         z=-6.6   |           |        chamber 6.6 m wide
//                  |      cache|        cache: the old survey cache (the tube)
//         z=-3.6   |   fire    |        fire: a good hearth, out of the wind
//                   \         /
//         z=-1.0     \       /
//      ##############|       |##############   rock face either side
//         z= 0       ' mouth '          3 m wide
//                 x=-1.5   +1.5
// ------------------------------------------------------------------------------------------
const CAVE_POLY: [number, number][] = [
  [-1.5, 0.3], [-1.5, -1.0], [-3.3, -3.6], [-3.3, -6.6], [-1.6, -9.2],
  [1.6, -9.2], [3.3, -6.6], [3.3, -3.6], [1.5, -1.0], [1.5, 0.3],
];
const CAVE: Blueprint = {
  name: 'cave_rocks',
  size: { x: 13, y: 5.5, z: 12.5 },
  clear: { x: 0, z: -4.4, r: 8.2 },
  boxes: [
    ...ring('rock', CAVE_POLY, 1.7, 0, 4.4, 'rock', [9]),
    box('rock', -4.3, -0.45, 2.1, 0.85, 0, 4.4, 'rock'),
    box('rock', 4.3, -0.45, 2.1, 0.85, 0, 4.4, 'rock'),
  ],
  posts: [],
  floors: [{ x: 0, z: -4.45, hx: 3.4, hz: 4.85, yaw: 0, y: 0.03, surface: 'rock', tag: 'cave floor' }],
  shelters: [
    { x: 0, y: 2, z: -5.1, hx: 3.3, hy: 2.2, hz: 4.1, yaw: 0, amount: 1, indoor: true },
    { x: 0, y: 2, z: 0.2, hx: 1.6, hy: 2.2, hz: 1.4, yaw: 0, amount: 0.75, indoor: false },
  ],
  anchors: {
    mouth: A(0, 0, 0.8, 0),
    fire: A(0, 0.03, -3.4, 0),
    cache: A(2.3, 0.03, -5.6, -PI / 2),
    part: A(1.5, 0.03, -6.4, 0),
    den: A(-1.3, 0.03, -7.3, 0.6),
    loot1: A(-2.3, 0.03, -4.4, PI / 2),
    sticks: A(-1.7, 0.03, -2.9, 0),
    note: A(1.9, 0.03, -4.5, -PI / 2),
    bot1: A(0.9, 0.03, -2.3, PI),
    bot2: A(-0.9, 0.03, -2.5, PI),
    bot3: A(0.2, 0.03, -5.2, PI),
  },
  openings: [{ kind: 'mouth', x: 0, y: 0, z: 0, yaw: 0, w: 3.0, h: 2.6 }],
};

// TORN TENT (model 'tent_torn')  2.4 x 3.2 m ridge tent, open at the front (+Z), cloth walls
// sagging to 1.3 m. Low: it breaks the wind for someone sitting inside, it is not a room.
//   z=-1.6 +---------+
//          |         |
//   z=+1.6 +         +   open (flaps torn away)
const TENT: Blueprint = {
  name: 'tent_torn',
  size: { x: 2.4, y: 1.5, z: 3.2 },
  clear: { x: 0, z: 0, r: 2.6 },
  boxes: [
    ...run('cloth', -1.2, -1.56, 1.2, -1.56, 0.08, 0, 1.3),
    ...run('cloth', -1.16, -1.6, -1.16, 1.6, 0.08, 0, 1.3),
    ...run('cloth', 1.16, -1.6, 1.16, 1.6, 0.08, 0, 1.3),
  ],
  posts: [],
  floors: [],
  shelters: [{ x: 0, y: 0.7, z: -0.2, hx: 1.1, hy: 0.7, hz: 1.3, yaw: 0, amount: 0.5, indoor: false }],
  anchors: { inside: A(0, 0, -0.5, 0), front: A(0, 0, 2.2, 0) },
  openings: [],
};

const CRATE: Blueprint = {
  name: 'crate',
  size: { x: 0.9, y: 0.62, z: 0.64 },
  clear: { x: 0, z: 0, r: 1.0 },
  boxes: [box('crate', 0, 0, 0.45, 0.32, 0, 0.62, 'furniture')],
  posts: [], floors: [], shelters: [],
  anchors: { top: A(0, 0.62, 0, 0) },
  openings: [],
};

const BARREL: Blueprint = {
  name: 'barrel',
  size: { x: 0.6, y: 0.9, z: 0.6 },
  clear: { x: 0, z: 0, r: 0.8 },
  boxes: [],
  posts: [{ x: 0, z: 0, r: 0.3, y0: 0, y1: 0.9, kind: 'furniture', tag: 'drum' }],
  floors: [], shelters: [],
  anchors: { top: A(0, 0.9, 0, 0) },
  openings: [],
};

// SURVEY MAST (model 'survey_mast')  a 6 m guyed pole with a wind vane; three guy stakes 2.5 m out.
const SURVEY_MAST: Blueprint = {
  name: 'survey_mast',
  size: { x: 5, y: 6, z: 5 },
  clear: { x: 0, z: 0, r: 1.2 },
  boxes: [],
  posts: [{ x: 0, z: 0, r: 0.09, y0: 0, y1: 6, kind: 'wall', tag: 'pole' }],
  floors: [], shelters: [],
  anchors: { base: A(0, 0, 0, 0), top: A(0, 6, 0, 0), stake1: A(0, 0, 2.5, 0), stake2: A(2.17, 0, -1.25, 0), stake3: A(-2.17, 0, -1.25, 0) },
  openings: [],
};

// WING (model 'wing')  a torn wing lying flat, 9 m along local X, 2.6 m chord. You can walk on it.
const WING: Blueprint = {
  name: 'wing',
  size: { x: 9, y: 0.6, z: 2.6 },
  clear: { x: 0, z: 0, r: 4.8 },
  boxes: [], posts: [],
  floors: [{ x: 0, z: 0, hx: 4.5, hz: 1.3, yaw: 0, y: 0.45, surface: 'metal', tag: 'wing skin' }],
  shelters: [],
  anchors: { root: A(-4.5, 0.45, 0, 0), tip: A(4.5, 0.45, 0, 0) },
  openings: [],
};

// ENGINE NACELLE (model 'engine_nacelle')  a turbofan on its side, 3.4 m long (local Z), 1.9 m tall.
const NACELLE: Blueprint = {
  name: 'engine_nacelle',
  size: { x: 2, y: 1.9, z: 3.4 },
  clear: { x: 0, z: 0, r: 2.4 },
  boxes: [box('nacelle', 0, 0, 0.95, 1.7, 0, 1.9, 'wall')],
  posts: [], floors: [],
  shelters: [],
  anchors: { intake: A(0, 0.95, 1.7, 0) },
  openings: [],
};

// SEAT ROW (model 'seat_row')  three seats torn out in one piece, 1.5 m wide, facing +Z.
const SEAT_ROW: Blueprint = {
  name: 'seat_row',
  size: { x: 1.5, y: 1.1, z: 0.65 },
  clear: { x: 0, z: 0, r: 1.2 },
  boxes: [box('seat', 0, 0, 0.75, 0.32, 0, 1.1, 'furniture')],
  posts: [], floors: [], shelters: [],
  anchors: { seat: A(0, 0.45, 0.1, 0) },
  openings: [],
};

// ------------------------------------------------------------------------------------------
// SIGNAL TOWER MAST AND DECK  (model 'tower_mast')  a 30 m lattice mast on a 3 x 3 m base,
// with the steel pickup deck in front of it.
//
//         z=-4.5   o-----o      mast legs at (+-1.5, -4.5) and (+-1.5, -1.5); you can walk
//                  | \ / |      between them
//         z=-1.5   o-----o
//         z=+0.5  +-------+
//                 |       |     deck 6 x 6 m, grating, y=0.45
//                 | deck  |     (the flare goes here; the winch comes down here)
//         z=+6.5  +-------+
//                   |___|       step y=0.22, front, 2.4 m wide
// ------------------------------------------------------------------------------------------
const TOWER_MAST: Blueprint = {
  name: 'tower_mast',
  size: { x: 6, y: 30, z: 11.6 },
  clear: { x: 0, z: 1.2, r: 7.2 },
  boxes: [],
  posts: [
    { x: -1.5, z: -4.5, r: 0.15, y0: 0, y1: 30, kind: 'wall', tag: 'leg' },
    { x: 1.5, z: -4.5, r: 0.15, y0: 0, y1: 30, kind: 'wall', tag: 'leg' },
    { x: -1.5, z: -1.5, r: 0.15, y0: 0, y1: 30, kind: 'wall', tag: 'leg' },
    { x: 1.5, z: -1.5, r: 0.15, y0: 0, y1: 30, kind: 'wall', tag: 'leg' },
  ],
  floors: [
    { x: 0, z: 3.5, hx: 3, hz: 3, yaw: 0, y: 0.45, surface: 'metal', tag: 'deck' },
    { x: 0, z: 6.8, hx: 1.2, hz: 0.3, yaw: 0, y: 0.22, surface: 'metal', tag: 'step' },
  ],
  shelters: [],
  anchors: {
    deck: A(0, 0.45, 3.5, 0),
    beacon: A(0, 0.45, 0.9, 0),
    base: A(0, 0, -3, 0),
    top: A(0, 30, -3, 0),
    bot1: A(-2.2, 0.45, 5.4, 0),
    bot2: A(2.2, 0.45, 5.4, 0),
    bot3: A(2.3, 0.45, 1.6, 0),
  },
  openings: [],
};

// ------------------------------------------------------------------------------------------
// EQUIPMENT SHED  (model 'tower_shed')  3 x 4 m steel-clad hut, door on the front (+Z).
//
//  z=-2 +-----------+
//       |  [panel]  |    transmitter panel cabinet on the back wall
//       |[b]     [L]|    b: bench along -X; L: locker against +X
//       |[b]        |    floor y=0.18 (wood)
//  z=+2 +--[door]---+    door gap x -0.45..0.45
// ------------------------------------------------------------------------------------------
const TOWER_SHED: Blueprint = {
  name: 'tower_shed',
  size: { x: 3, y: 2.7, z: 4 },
  clear: { x: 0, z: 0, r: 3.4 },
  boxes: [
    ...run('wall', -1.5, -1.94, 1.5, -1.94, 0.12, 0, 2.5),
    ...run('wall', -1.44, -2, -1.44, 2, 0.12, 0, 2.5),
    ...run('wall', 1.44, -2, 1.44, 2, 0.12, 0, 2.5),
    ...run('wall', -1.5, 1.94, 1.5, 1.94, 0.12, 0, 2.5, 'wall', [[1.05, 1.95]]),
    box('panel', 0.15, -1.7, 0.6, 0.18, 0.18, 1.95, 'furniture'),
    box('bench', -1.06, -0.3, 0.3, 1.0, 0.18, 0.95, 'furniture'),
  ],
  posts: [],
  floors: [{ x: 0, z: 0, hx: 1.38, hz: 1.95, yaw: 0, y: 0.18, surface: 'wood', tag: 'floor' }],
  shelters: [{ x: 0, y: 1.3, z: 0, hx: 1.38, hy: 1.3, hz: 1.88, yaw: 0, amount: 1, indoor: true }],
  anchors: {
    door: A(0, 0.18, 1.94, 0),
    panel: A(0.15, 1.3, -1.5, 0),
    stand: A(0.15, 0.18, -0.75, PI),
    locker: A(1.02, 0.18, -0.2, -PI / 2),
    shelf: A(-1.06, 0.97, -0.6, PI / 2),
    shelfb: A(-1.06, 0.97, 0.1, PI / 2),
    note: A(-1.06, 0.97, 0.5, PI / 2),
    bot1: A(0.5, 0.18, 0.6, PI),
  },
  openings: [{ kind: 'door', x: 0, y: 0.18, z: 1.94, yaw: 0, w: 0.9, h: 1.95 }],
};

// GENERATOR (model 'generator')  hand-crank generator set on a 2.2 x 1.6 m concrete pad;
// the crank is on the front (+Z) face.
const GENERATOR: Blueprint = {
  name: 'generator',
  size: { x: 2.2, y: 1.1, z: 1.6 },
  clear: { x: 0, z: 0, r: 1.9 },
  boxes: [box('genset', 0, -0.2, 0.65, 0.36, 0.12, 1.05, 'furniture')],
  posts: [],
  floors: [{ x: 0, z: 0, hx: 1.1, hz: 0.8, yaw: 0, y: 0.12, surface: 'rock', tag: 'concrete pad' }],
  shelters: [],
  anchors: { crank: A(0, 0.85, 0.2, 0), stand: A(0, 0.12, 0.55, PI) },
  openings: [],
};

export const BLUEPRINTS: Record<string, Blueprint> = {
  fuselage: FUSELAGE,
  tail_section: TAIL,
  cabin: CABIN,
  woodshed: WOODSHED,
  fishing_hut: HUT,
  cave_rocks: CAVE,
  tent_torn: TENT,
  crate: CRATE,
  barrel: BARREL,
  survey_mast: SURVEY_MAST,
  wing: WING,
  engine_nacelle: NACELLE,
  seat_row: SEAT_ROW,
  tower_mast: TOWER_MAST,
  tower_shed: TOWER_SHED,
  generator: GENERATOR,
};

/** The blueprint for a model name, or undefined if the model has no footprint (debris, poles). */
export function blueprint(model: string): Blueprint | undefined {
  return BLUEPRINTS[model];
}

// ------------------------------------------------------------------------------------------
// Sites: how the blueprints are arranged at each place, in the site's local space (origin at
// the Poi, rotated by Poi.yaw, same convention as a blueprint).
// ------------------------------------------------------------------------------------------
export interface SitePart { id: string; model: string; x: number; z: number; yaw: number }
export interface SitePad { x: number; z: number; r: number; feather: number }
export interface Site {
  poi: PoiId;
  parts: SitePart[];
  /** Site-level anchors: 'approach' (where the trail arrives), 'fire', bot stand points ... */
  anchors: Record<string, BpAnchor>;
  /** Discs of terrain levelled to one height under the site. */
  pads: SitePad[];
  /** Local point whose natural ground height the pads take (default: mean of the first pad). */
  ref?: { x: number; z: number };
}

// WRECK. The fuselage lies nose-first along +Z; the plane came in along +Z, so the skid scar
// and the debris trail lead away behind the break (-Z). One wing stub lies under the over-wing
// exit on the +X side.
//        scar <----  [break ======= fuselage ======= nose]
//                     P P            [ wing ]
//                    P P  (B)        B: barrel fire     P: player start slots
const SITE_WRECK: Site = {
  poi: 'wreck',
  parts: [
    { id: 'fuselage', model: 'fuselage', x: 0, z: 0, yaw: 0 },
    { id: 'wing', model: 'wing', x: 6.35, z: 0.9, yaw: 0.06 },
  ],
  anchors: {
    approach: A(-0.6, 0, -15.5, PI),
    barrel: A(3.6, 0, -11.6, 0),
    spawn0: A(-0.7, 0, -10.6, PI),
    spawn1: A(0.8, 0, -11.0, PI),
    spawn2: A(-1.6, 0, -12.2, PI),
    spawn3: A(0.2, 0, -12.8, PI),
    bot1: A(2.4, 0, -12.6, 0.9),
    bot2: A(4.9, 0, -12.4, -0.9),
    bot3: A(4.4, 0, -10.2, -2.2),
    sign: A(-3.4, 0, -17.5, PI),
    luggage1: A(-3.2, 0, -11.2, 0.7),
    luggage2: A(5.6, 0, -15.5, 2.1),
  },
  pads: [
    { x: 0, z: -6, r: 6.5, feather: 9 },
    { x: 0, z: 0, r: 6.5, feather: 9 },
    { x: 0, z: 6, r: 6.5, feather: 9 },
    { x: 1.5, z: -12, r: 7, feather: 9 },
    { x: 6.5, z: 1, r: 5, feather: 8 },
  ],
};

const SITE_TAIL: Site = {
  poi: 'tail',
  parts: [{ id: 'tail', model: 'tail_section', x: 0, z: 0, yaw: 0 }],
  anchors: {
    approach: A(0.4, 0, 8.8, 0),
    fire: A(3.6, 0, 5.6, 0),
    crate: A(-2.6, 0, 6.2, 0.5),
    bot1: A(2.2, 0, 7.0, 0),
    bot2: A(-1.8, 0, 7.6, 0),
    bot3: A(3.4, 0, 3.4, 0),
  },
  pads: [{ x: 0, z: 1.5, r: 8.5, feather: 9 }],
};

// CABIN. The woodshed stands off the east wall, open toward the cabin; heavy logs lie by it.
const SITE_CABIN: Site = {
  poi: 'cabin',
  parts: [
    { id: 'cabin', model: 'cabin', x: 0, z: 0, yaw: 0 },
    { id: 'woodshed', model: 'woodshed', x: 7.4, z: 0.2, yaw: -PI / 2 },
  ],
  anchors: {
    approach: A(-1.15, 0, 8.6, 0),
    fire: A(2.5, 0, 7.5, 0),
    log1: A(5.6, 0, 3.6, 0.2),
    log2: A(6.6, 0, 4.4, 0.3),
    log3: A(7.9, 0, 3.4, -0.4),
    log4: A(9.3, 0, 1.8, 1.4),
    log5: A(9.6, 0, -1.2, 1.7),
    log6: A(8.4, 0, 4.9, 0.1),
    branchpile: A(5.0, 0, -2.6, 0.8),
    sign: A(-3.6, 0, 9.4, 0),
    bot1: A(0.8, 0, 5.4, 0),
    bot2: A(-2.6, 0, 5.8, 0),
    bot3: A(3.4, 0, 5.2, 0),
  },
  pads: [{ x: 1.5, z: 1, r: 13, feather: 12 }],
};

const SITE_HUT: Site = {
  poi: 'hut',
  parts: [{ id: 'hut', model: 'fishing_hut', x: 0, z: 0, yaw: 0 }],
  anchors: { approach: A(0, 0, 3.4, 0), bot1: A(1.6, 0, 2.6, 0), bot2: A(-1.6, 0, 2.8, 0), bot3: A(2.4, 0, 0.4, 0) },
  pads: [],
};

const SITE_CAVE: Site = {
  poi: 'cave',
  parts: [{ id: 'cave', model: 'cave_rocks', x: 0, z: 0, yaw: 0 }],
  anchors: {
    approach: A(0.3, 0, 7.5, 0),
    sign: A(3.4, 0, 8.4, 0),
    bot1: A(2.2, 0, 4.2, 0),
    bot2: A(-2.4, 0, 4.6, 0),
    bot3: A(0.4, 0, 5.6, 0),
  },
  pads: [
    { x: 0, z: -5.2, r: 6.6, feather: 3.5 },
    { x: 0, z: -0.5, r: 6.4, feather: 4 },
    { x: 0, z: 4.5, r: 5.5, feather: 8 },
  ],
  ref: { x: 0, z: 5 },
};

// SURVEY CAMP.            N (-Z)
//                     mast (0.5,-5.5)
//     tent A (-4.2,-1)                crates (3.2,-2.6) (4.0,-1.7): a windbreak
//                      fire (0.6, 0.4)
//           barrel (-2.6, 3.7)        tent B, collapsed (4.5, 3.0)
const SITE_CAMP: Site = {
  poi: 'camp',
  parts: [
    { id: 'tentA', model: 'tent_torn', x: -4.2, z: -1.0, yaw: 1.05 },
    { id: 'tentB', model: 'tent_torn', x: 4.5, z: 3.0, yaw: -2.3 },
    { id: 'mast', model: 'survey_mast', x: 0.5, z: -5.5, yaw: 0.3 },
    { id: 'crate1', model: 'crate', x: 3.2, z: -2.6, yaw: 0.35 },
    { id: 'crate2', model: 'crate', x: 4.05, z: -1.75, yaw: 1.2 },
    { id: 'crate3', model: 'crate', x: -0.9, z: -4.6, yaw: -0.2 },
    { id: 'barrel', model: 'barrel', x: -2.6, z: 3.7, yaw: 0 },
  ],
  anchors: {
    approach: A(-1.0, 0, 9.5, 0),
    fire: A(0.6, 0, 0.4, 0),
    part: A(-0.9, 0.63, -4.6, 0),
    lootA: A(2.3, 0, -1.2, -0.6),
    lootB: A(-3.6, 0, -0.6, 1.05),
    lootC: A(1.4, 0, 3.4, 2.4),
    note: A(-4.5, 0, -1.4, 1.05),
    sign: A(-3.0, 0, 9.0, 0),
    bot1: A(1.8, 0, 1.4, -2.2),
    bot2: A(-0.8, 0, 1.6, 2.4),
    bot3: A(0.4, 0, -1.4, 0.2),
  },
  pads: [{ x: 0, z: 0, r: 12, feather: 13 }],
};

// SIGNAL TOWER.               N (-Z)
//                        [ mast ]
//      [shed] door ->    [ deck ]        barrels (5.4,-3.4) (6.2,-2.5)
//      [generator] crank ->
const SITE_TOWER: Site = {
  poi: 'tower',
  parts: [
    { id: 'mast', model: 'tower_mast', x: 0, z: 0, yaw: 0 },
    { id: 'shed', model: 'tower_shed', x: -7.6, z: -0.6, yaw: PI / 2 },
    { id: 'gen', model: 'generator', x: -7.2, z: 4.4, yaw: PI / 2 },
    { id: 'barrel1', model: 'barrel', x: 5.4, z: -3.4, yaw: 0 },
    { id: 'barrel2', model: 'barrel', x: 6.2, z: -2.5, yaw: 0 },
  ],
  anchors: {
    approach: A(6.5, 0, 10.5, 0),
    fire: A(-3.6, 0, 2.4, 0),
    sign: A(8.5, 0, 9.5, 0),
    bot1: A(-4.6, 0, 1.2, PI / 2),
    bot2: A(-4.4, 0, 5.4, PI / 2),
    bot3: A(4.4, 0, 6.6, 0),
  },
  pads: [{ x: -1, z: 1, r: 13.5, feather: 10 }],
};

export const SITES: Record<Exclude<PoiId, 'lake'>, Site> = {
  wreck: SITE_WRECK,
  tail: SITE_TAIL,
  cabin: SITE_CABIN,
  hut: SITE_HUT,
  cave: SITE_CAVE,
  camp: SITE_CAMP,
  tower: SITE_TOWER,
};

// ------------------------------------------------------------------------------------------
// placing
// ------------------------------------------------------------------------------------------
export interface Pose { x: number; y: number; z: number; yaw: number }
export type PlacedSolid = Collider & { kind: SolidKind };
export interface Placed {
  colliders: PlacedSolid[];
  floors: Floor[];
  shelters: ShelterVol[];
  anchors: Record<string, Pose>;
}

/** Local point -> world, for something placed at `at`. */
export function toWorld(at: Pose, lx: number, ly: number, lz: number, lyaw = 0): Pose {
  const c = dcos(at.yaw), s = dsin(at.yaw);
  return { x: at.x + lx * c + lz * s, y: at.y + ly, z: at.z - lx * s + lz * c, yaw: at.yaw + lyaw };
}

/**
 * Place a blueprint in the world. `at` is a Poi or any { x, y, z, yaw } (y = ground height).
 * Returns world-space colliders (each tagged with `kind`), floors, shelter volumes and anchors.
 */
export function placeBlueprint(bp: Blueprint, at: Pose, poi?: PoiId): Placed {
  const colliders: PlacedSolid[] = [];
  const floors: Floor[] = [];
  const shelters: ShelterVol[] = [];
  const anchors: Record<string, Pose> = {};
  for (const b of bp.boxes) {
    const w = toWorld(at, b.x, 0, b.z, b.yaw);
    colliders.push({ s: 'b', x: w.x, z: w.z, hx: b.hx, hz: b.hz, yaw: w.yaw, y0: at.y + b.y0, y1: at.y + b.y1, kind: b.kind });
  }
  for (const p of bp.posts) {
    const w = toWorld(at, p.x, 0, p.z);
    colliders.push({ s: 'c', x: w.x, z: w.z, r: p.r, y0: at.y + p.y0, y1: at.y + p.y1, kind: p.kind });
  }
  for (const f of bp.floors) {
    const w = toWorld(at, f.x, f.y, f.z, f.yaw);
    floors.push({ x: w.x, z: w.z, hx: f.hx, hz: f.hz, yaw: w.yaw, y: w.y, surface: f.surface });
  }
  for (const v of bp.shelters) {
    const w = toWorld(at, v.x, v.y, v.z, v.yaw);
    const sv: ShelterVol = { x: w.x, y: w.y, z: w.z, hx: v.hx, hy: v.hy, hz: v.hz, yaw: w.yaw, amount: v.amount, indoor: v.indoor };
    if (poi) sv.poi = poi;
    shelters.push(sv);
  }
  for (const k in bp.anchors) {
    const a = bp.anchors[k];
    anchors[k] = toWorld(at, a.x, a.y, a.z, a.yaw);
  }
  return { colliders, floors, shelters, anchors };
}

export interface PlacedSite extends Placed {
  /** One entry per site part: the model to draw and where. */
  parts: { id: string; model: string; pose: Pose }[];
}

/**
 * Place a whole site at its Poi. Anchors come back as 'partId.anchor' (for example
 * 'cabin.stove', 'shed.panel') and 'site.name' for the site's own ('site.approach').
 */
export function placeSite(site: Site, at: Pose): PlacedSite {
  const out: PlacedSite = { colliders: [], floors: [], shelters: [], anchors: {}, parts: [] };
  for (const p of site.parts) {
    const bp = BLUEPRINTS[p.model];
    const pose = toWorld(at, p.x, 0, p.z, p.yaw);
    out.parts.push({ id: p.id, model: p.model, pose });
    if (!bp) continue;
    const pl = placeBlueprint(bp, pose, site.poi);
    for (const c of pl.colliders) out.colliders.push(c);
    for (const f of pl.floors) out.floors.push(f);
    for (const s of pl.shelters) out.shelters.push(s);
    for (const k in pl.anchors) out.anchors[p.id + '.' + k] = pl.anchors[k];
  }
  for (const k in site.anchors) {
    const a = site.anchors[k];
    out.anchors['site.' + k] = toWorld(at, a.x, a.y, a.z, a.yaw);
  }
  return out;
}
