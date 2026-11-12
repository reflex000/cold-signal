// 'crate': a wooden supply crate. Boards nailed inside a frame of battens, standing on two skids,
// with rope, steel or cleat handles on the ends and a lid hinged along its back edge (named part
// 'lid', opened by the props system's setOpen). The style reference for hard-surface timber props:
// every board is its own slightly bowed plank with a bevelled edge and a gap to the next, battens
// stand proud of the boards, steel is a separate painted part, wear and grime follow hands and
// ground.
//
// Variants (seed & 3): 0 general supply crate, rope handles; 1 long olive crate, steel bail
// handles and a steel band; 2 small plywood crate with cleat grips; 3 wide flat crate, one band
// cut and sprung loose.
// Anchors: top (lid centre), loot (inside floor), use (where a player stands to open it), hinge.
import { Builder, MAT, PAL, mixRGB, Path, type Part, type RGB, type V3 } from '../kit';
import { register } from '../registry';

const PI = Math.PI;

register(
  'crate',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const W = [0.82, 1.16, 0.6, 0.98][v]; // board shell, X
    const H = [0.54, 0.44, 0.5, 0.42][v]; // total height: skids + shell + lid
    const D = [0.52, 0.44, 0.48, 0.64][v]; // board shell, Z
    const ply = v === 2;
    const wood = v === 2 ? PAL.plywood : v === 1 ? PAL.pine : PAL.timber;
    const paint: RGB | null = v === 1 ? PAL.olive : v === 3 ? mixRGB(PAL.drab, PAL.timber, 0.35) : null;
    const face = paint ?? wood;
    const frame = paint ? mixRGB(paint, PAL.timberDark, 0.15) : mixRGB(wood, PAL.timberDark, 0.25);
    const wear = r.range(0.45, 0.75);
    const t = ply ? 0.012 : 0.018; // boards
    const bt = 0.02; // batten thickness (how far it stands proud)
    const bw = ply ? 0.055 : 0.07; // batten width
    const sk = 0.05; // skid height
    const y0 = sk; // bottom of the shell
    const y1 = H - t - bt; // top of the shell, where the lid sits
    const Hs = y1 - y0;
    const gap = ply ? 0 : 0.004;

    const boardInk = { color: face, mat: MAT.WOOD, wear, vary: 0.14 } as const;
    const frameInk = { color: frame, mat: MAT.WOOD, wear: Math.min(1, wear + 0.15), vary: 0.1 } as const;
    const steelInk = { color: PAL.steelDark, mat: MAT.METAL, wear: 0.75, rough: 0.6 } as const;
    const boards: Part[] = [];

    /**
     * One wall made facing +Z with its outer board face on z = 0: boards across `len`, battens
     * standing proud: verticals at +-(half - vw / 2) of width `vw`, rails between them.
     */
    const wall = (len: number, half: number, vw: number, brace: boolean) =>
      b.group(() => {
        b.ink(ply ? { ...boardInk, grain: 'x' } : boardInk);
        if (ply) boards.push(b.box(len, Hs, t, { bevel: 0.002 }).move(0, y0 + Hs / 2, -t / 2));
        else {
          const n = Math.max(2, Math.round(Hs / 0.12));
          const pitch = Hs / n;
          for (let i = 0; i < n; i++) boards.push(b.plank(len, pitch - gap, t, { rows: 2 }).rotZ(PI / 2).move(0, y0 + pitch * (i + 0.5), -t / 2));
        }
        b.ink(frameInk);
        for (const s of [-1, 1]) b.plank(Hs, vw, bt, { rows: 1 }).move(s * (half - vw / 2), y0 + Hs / 2, bt / 2);
        const inner = half - vw;
        for (const yy of [y0 + bw / 2, y1 - bw / 2]) b.plank(inner * 2, bw, bt, { rows: 1 }).rotZ(PI / 2).move(0, yy, bt / 2);
        if (brace) {
          // corner to corner of the panel between the rails, a hair thinner so it never shares a face with them
          const ax = -inner + bw * 0.55, ay = y0 + bw * 1.1, bx = inner - bw * 0.55, by = y1 - bw * 1.1;
          b.plank(Math.hypot(bx - ax, by - ay), bw * 0.92, bt * 0.9, { rows: 1 }).span([ax, ay, bt * 0.45], [bx, by, bt * 0.45]);
        }
      });

    // ---- shell ----
    for (const s of [-1, 1]) {
      const g = wall(W, W / 2, bw, W > 0.75);
      if (s < 0) g.rotY(PI);
      g.move(0, 0, (s * D) / 2);
    }
    for (const s of [-1, 1]) wall(D - 2 * t, D / 2 + bt, bw + bt, false).rotY((s * PI) / 2).move((s * W) / 2, 0, 0);
    // the bake cannot see into a closed box: darken the inner faces of the boards for when it is open
    for (const p of boards) p.shade((q) => (q.nx * q.x + q.nz * q.z < -1e-4 ? 0.5 : 1));
    // inside floor, dark and dusty
    b.ink({ ...boardInk, wear: wear * 0.5 });
    {
      const n = ply ? 1 : Math.max(3, Math.round((D - 2 * t) / 0.13));
      const pitch = (D - 2 * t) / n;
      for (let i = 0; i < n; i++) {
        const p = ply
          ? b.box(W - 2 * t, t, D - 2 * t, { bevel: 0.002 }).move(0, y0 + t / 2, 0)
          : b.plank(W - 2 * t, pitch - gap, t, { rows: 1 }).rotZ(PI / 2).rotX(-PI / 2).move(0, y0 + t / 2, -D / 2 + t + pitch * (i + 0.5));
        p.shade((q) => (q.ny > 0.5 ? 0.42 : 0.7));
      }
    }
    // skids under the floor, set in from the front and back
    b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.8, vary: 0.1 });
    for (const s of [-1, 1]) {
      b.plank(W + 2 * bt, sk, 0.075, { rows: 1 })
        .rotZ(PI / 2)
        .move(0, sk / 2, s * (D / 2 - 0.07))
        .tint(PAL.rustDark, (q) => 0.35 - q.y * 4);
    }

    // ---- lid (named part, hinged along the back top edge) ----
    const LW = W + 2 * bt, LD = D + 2 * bt;
    const hinge: V3 = [0, y1, -LD / 2];
    b.part(
      'lid',
      () => {
        b.ink(ply ? { ...boardInk, grain: 'x' } : boardInk);
        if (ply) b.box(LW, t, LD, { bevel: 0.003 }).move(0, y1 + t / 2, 0);
        else {
          const n = Math.max(3, Math.round(LD / 0.125));
          const pitch = LD / n;
          for (let i = 0; i < n; i++) b.plank(LW, pitch - gap, t, { rows: 2 }).rotZ(PI / 2).rotX(-PI / 2).move(0, y1 + t / 2, -LD / 2 + pitch * (i + 0.5));
        }
        b.ink(frameInk);
        const cleats = W > 0.9 ? [-1, 0, 1] : [-1, 1];
        for (const c of cleats) b.plank(LD - 0.01, bw, bt, { rows: 1 }).rotX(-PI / 2).move(c * (LW / 2 - bw / 2 - 0.004), y1 + t + bt / 2, 0);
        // strap hinges and the hasp
        b.ink(steelInk);
        for (const s of [-1, 1]) {
          const hx = s * (LW / 2 - bw - 0.09);
          b.box(0.035, 0.003, 0.17, { bevel: 0.001 }).move(hx, y1 + t + 0.0015, -LD / 2 + 0.085);
          b.cyl(0.008, 0.06, { sides: 8, bevel: 0.002 }).rotZ(PI / 2).move(hx, y1, -LD / 2 - 0.004);
        }
        b.box(0.04, 0.085, 0.004, { bevel: 0.001 }).move(0, y1 - 0.025, LD / 2 + 0.002);
      },
      hinge,
      { axis: [1, 0, 0], open: -1.95 },
    );
    // hinge leaves on the back wall, the staple the hasp drops over on the front rail
    b.ink(steelInk);
    for (const s of [-1, 1]) b.box(0.035, 0.12, 0.003, { bevel: 0.001 }).move(s * (LW / 2 - bw - 0.09), y1 - 0.065, -LD / 2 - 0.0015);
    b.torus(0.012, 0.0028, { segs: 10, sides: 5 }).rotZ(PI / 2).move(0, y1 - 0.05, LD / 2);

    // ---- handles on the ends ----
    for (const s of [-1, 1]) {
      const g = b.group(() => {
        const yh = y0 + Hs * 0.66;
        if (v === 1) {
          // steel bail hanging in two brackets
          b.ink(steelInk);
          for (const k of [-1, 1]) b.box(0.03, 0.05, 0.012, { bevel: 0.002 }).move(k * 0.08, yh, bt + 0.006);
          const path = Path.fillet([[-0.08, yh, bt + 0.016], [-0.08, yh - 0.075, bt + 0.03], [0.08, yh - 0.075, bt + 0.03], [0.08, yh, bt + 0.016]], 0.02, 3);
          b.pipe(path, 0.0055, { sides: 6 });
        } else if (v === 2) {
          // a grip cleat across the end
          b.ink(frameInk);
          b.plank(0.3, 0.045, 0.028, { rows: 1 }).rotZ(PI / 2).move(0, yh, bt + 0.014).shade((q) => (q.ny < -0.5 ? 0.6 : 1));
        } else {
          // rope through a wooden block, knotted on top
          b.ink(frameInk);
          b.box(0.24, 0.05, 0.03, { bevel: 0.006 }).move(0, yh, bt + 0.015);
          b.ink({ color: PAL.rope, mat: MAT.CLOTH, wear: 0.6, vary: 0.05, detailScale: 1.8 });
          const zc = bt + 0.034;
          b.pipe(Path.spline([[-0.08, yh + 0.026, zc - 0.012], [-0.081, yh - 0.03, zc], [-0.05, yh - 0.075, zc + 0.012], [0, yh - 0.088, zc + 0.016], [0.05, yh - 0.075, zc + 0.012], [0.081, yh - 0.03, zc], [0.08, yh + 0.026, zc - 0.012]], 5), 0.0085, { sides: 6 });
          for (const k of [-1, 1]) b.sphere([0.014, 0.011, 0.014], { sides: 7, rings: 4 }).move(k * 0.08, yh + 0.03, zc - 0.012);
        }
      });
      g.rotY((s * PI) / 2).move((s * W) / 2, 0, 0);
    }

    // ---- steel bands, over the battens and below the handles ----
    if (v === 1 || v === 3) {
      b.ink({ color: PAL.galvanised, mat: MAT.METAL, wear: 0.6, rough: 0.5 });
      const hx = W / 2 + bt + 0.0015, hz = D / 2 + bt + 0.0015;
      const y = y0 + Hs * 0.3;
      const loop = Path.fillet([[0, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz], [-hx, y, -hz], [0, y, -hz]], 0.012, 3);
      loop.pop();
      b.strap(loop, 0.016, 0.0012, { closed: true, up: [0, 0, -1] });
      if (v === 3) {
        // a second band was cut at the front and has sprung off the end, curling
        const y2 = y0 + Hs * 0.8;
        const tail = Path.spline([[hx, y2, hz * 0.55], [hx + 0.02, y2 - 0.01, hz * 0.85], [hx + 0.07, y2 - 0.04, hz + 0.02], [hx + 0.11, y2 - 0.09, hz - 0.02], [hx + 0.09, y2 - 0.13, hz - 0.08]], 4);
        const path = Path.fillet([[-hx, y2, hz * 0.2], [-hx, y2, -hz], [hx, y2, -hz], ...tail], 0.012, 3);
        b.strap(path, 0.016, 0.0012, { up: [-1, 0, 0] });
      }
    }

    // ---- weather and use: grime and damp creep up from the ground, the lid's front edge is handled most ----
    b.each((q) => {
      const g = Math.max(0, 1 - q.y / 0.14) * 0.35;
      if (g > 0) {
        q.r *= 1 - g;
        q.g *= 1 - g * 1.05;
        q.b *= 1 - g * 1.1;
      }
      if (q.y > H - 0.03 && q.z > D / 2) q.wear = Math.min(1, q.wear + 0.15);
    });

    b.anchor('top', [0, H, 0]);
    b.anchor('loot', [0, y0 + t + 0.01, 0]);
    b.anchor('use', [0, 0, D / 2 + 0.55], 0);
    b.anchor('hinge', hinge);
    return b.build();
  },
  { variants: 4, size: 'prop', desc: 'wooden supply crate; lid opens (part "lid")', tags: ['loot', 'crate'] },
);
