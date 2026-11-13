// Small things the first-person hands hold for a moment: a matchbox and a match (lighting a fire),
// a ration bar, a thermos, a bandage roll, a flare cartridge, a rifle round and its spent case, a
// flashlight cell. Not registered as world models (the pickups of these items are not this
// module's); built once with the KIT Builder and cached. Each is centred on its own origin, long
// axis along +Y unless noted; the first-person animator places it in a hand.
import { Builder, MAT, PAL, hex, mixRGB, type ModelDef } from '../kit';

export type ExtraName = 'matchbox' | 'match' | 'ration' | 'thermos' | 'bandage' | 'cartridge' | 'round' | 'case' | 'cell';

const cache = new Map<ExtraName, ModelDef>();

/** The model of a hand-held extra (cached). `match`: its head is emissive 1 (the glow material lights it). */
export function getExtra(name: ExtraName): ModelDef {
  let d = cache.get(name);
  if (!d) {
    d = BUILD[name]();
    d.name = 'fp_' + name;
    cache.set(name, d);
  }
  return d;
}

function done(b: Builder): ModelDef {
  return b.build({ ao: 0.8, ground: false, aoRadius: 0.01 });
}

const BUILD: Record<ExtraName, () => ModelDef> = {
  /** 53 x 16 x 36 mm, length along X, thin along Y; striker strips on the +-Z sides. */
  matchbox() {
    const b = new Builder(0x3a7c);
    b.ink({ color: hex(0x6e2216), mat: MAT.PLASTIC, wear: 0.55, snow: 0, rough: 0.92 });
    b.box(0.053, 0.016, 0.036, { bevel: 0.0012 });
    b.ink({ color: hex(0xcbbf9f), mat: MAT.PLASTIC, wear: 0.5, snow: 0, rough: 0.9 });
    b.box(0.036, 0.0004, 0.024, { bevel: 0.0001 }).move(0.002, 0.0081, 0);
    b.ink({ color: hex(0x3a1c12), mat: MAT.PLASTIC, wear: 0.4, snow: 0, rough: 0.92 });
    b.stencil('MATCHES', 0.0048, { weight: 0.17, align: 'center' }).rotX(-Math.PI / 2).move(0.002, 0.0084, 0.0024);
    b.ink({ color: hex(0x2a1d16), mat: MAT.ROCK, wear: 0.6, snow: 0, rough: 0.95 });
    for (const s of [-1, 1]) b.box(0.047, 0.012, 0.0006, { bevel: 0.0002 }).move(0, 0, s * 0.0182);
    // the tray pushed a little out of the sleeve, a few match heads showing
    b.ink({ color: hex(0xb8a581), mat: MAT.PLASTIC, wear: 0.4, snow: 0, rough: 0.9 });
    b.box(0.012, 0.014, 0.033, { bevel: 0.0006 }).move(0.031, -0.0004, 0);
    b.ink({ color: hex(0x7a1d12), mat: MAT.PLASTIC, wear: 0.3, snow: 0, rough: 0.8 });
    for (let i = 0; i < 4; i++) b.sphere([0.0026, 0.0022, 0.0022], { sides: 6, rings: 4 }).move(0.035, 0.002, -0.011 + i * 0.0072);
    return done(b);
  },
  /** A wooden match, 47 mm along +Y, the head at the top (emissive 1: lit by the glow material). */
  match() {
    const b = new Builder(0x3a7d);
    b.ink({ color: PAL.pine, mat: MAT.WOOD, wear: 0.2, snow: 0, grain: 'y' });
    b.box(0.0021, 0.044, 0.0021, { bevel: 0.0003 }).move(0, -0.0015, 0);
    b.ink({ color: hex(0x5a1810), mat: MAT.PLASTIC, wear: 0.2, snow: 0, rough: 0.85, emissive: 1 });
    b.sphere([0.0029, 0.0042, 0.0029], { sides: 8, rings: 5 }).move(0, 0.0215, 0);
    return done(b);
  },
  /** Ration bar in foil and a paper sleeve: 110 x 22 x 45 mm, length along Y, the torn end up. */
  ration() {
    const b = new Builder(0x3a7e);
    b.ink({ color: hex(0x4f5236), mat: MAT.PLASTIC, wear: 0.55, snow: 0, rough: 0.9 });
    b.box(0.047, 0.07, 0.023, { bevel: 0.0015 }).move(0, -0.018, 0);
    b.ink({ color: hex(0x1e1f18), mat: MAT.PLASTIC, wear: 0.4, snow: 0, rough: 0.9 });
    b.stencil('FOOD', 0.007, { weight: 0.16, align: 'center' }).move(0, -0.02, 0.0118);
    b.ink({ color: hex(0xb7b9bb), mat: MAT.METAL, wear: 0.25, snow: 0, rough: 0.38 });
    const foil = b.box(0.0452, 0.042, 0.0218, { bevel: 0.001, rows: 4 });
    foil.move(0, 0.031, 0).crumple(0.0012, 160);
    // the bar itself where the foil is torn back
    b.ink({ color: hex(0x7a5a38), mat: MAT.PLASTIC, wear: 0.6, snow: 0, rough: 0.95 });
    b.box(0.041, 0.018, 0.018, { bevel: 0.002 }).move(0, 0.054, 0).noise(0.0008, 300);
    return done(b);
  },
  /** Steel vacuum flask, green hammertone paint, cup lid on top: 75 mm across, 255 mm tall along Y. */
  thermos() {
    const b = new Builder(0x3a7f);
    b.ink({ color: hex(0x34482f), mat: MAT.PAINT, wear: 0.55, snow: 0, rough: 0.5 });
    b.lathe([[0, -0.1275], [0.033, -0.1272], [0.0372, -0.122], [0.0375, 0.07], [0.0345, 0.084], [0.024, 0.094], [0.023, 0.1]], { sides: 18, smooth: true });
    // the cup lid, brushed steel
    b.ink({ color: hex(0x9a9ea1), mat: MAT.METAL, wear: 0.3, snow: 0, rough: 0.35 });
    b.lathe([[0.0235, 0.088], [0.0395, 0.094], [0.041, 0.1], [0.041, 0.124], [0.0395, 0.128], [0, 0.1285]], { sides: 18, smooth: true });
    // a dent and a strap handle
    b.ink({ color: hex(0x1e1f1c), mat: MAT.PLASTIC, wear: 0.5, snow: 0, rough: 0.7 });
    b.strap([[0.037, 0.05, 0], [0.052, 0.035, 0], [0.054, -0.03, 0], [0.037, -0.05, 0]], 0.016, 0.0045, { up: [1, 0, 0] });
    return done(b);
  },
  /** Gauze roll, axis along X (70 mm wide, 46 mm across), a loose end hanging down. */
  bandage() {
    const b = new Builder(0x3a80);
    const gauze = mixRGB(hex(0xd8d4c6), hex(0xb9b2a0), 0.25);
    b.ink({ color: gauze, mat: MAT.CLOTH, wear: 0.45, snow: 0, rough: 0.95, detailScale: 1.6 });
    b.lathe([[0.008, -0.035], [0.022, -0.035], [0.0232, -0.033], [0.0232, 0.033], [0.022, 0.035], [0.008, 0.035], [0.008, -0.035]], { sides: 18, smooth: true }).rotZ(Math.PI / 2);
    const tail = b.cloth(0.068, 0.11, { billow: 0.004, wrinkle: 0.002, thickness: 0.0012, tear: 0.2 });
    tail.move(0, -0.0225, 0.0225).ghost();
    return done(b);
  },
  /** 12 gauge flare cartridge along +Y: red hull, brass head at the bottom. */
  cartridge() {
    const b = new Builder(0x3a81);
    b.ink({ color: hex(0x9a2a1d), mat: MAT.PLASTIC, wear: 0.35, snow: 0, rough: 0.45 });
    b.lathe([[0.0102, -0.02], [0.0104, 0.04], [0.0096, 0.0445], [0.006, 0.0458], [0, 0.0455]], { sides: 16, smooth: true });
    b.ink({ color: PAL.brass, mat: MAT.METAL, wear: 0.35, snow: 0, rough: 0.32 });
    b.lathe([[0, -0.0255], [0.0108, -0.0255], [0.0112, -0.0245], [0.0112, -0.0225], [0.0106, -0.022], [0.0106, -0.012], [0.0103, -0.0115]], { sides: 16, smooth: true });
    b.ink({ color: hex(0x6a6d70), mat: MAT.METAL, wear: 0.3, snow: 0 });
    b.cyl(0.0028, 0.0006, { sides: 10, bevel: 0.0001 }).move(0, -0.0258, 0);
    return done(b);
  },
  /** A loaded rifle round along +Y, 71 mm: brass case, copper bullet with a lead tip. */
  round() {
    const b = new Builder(0x3a82);
    b.ink({ color: PAL.brass, mat: MAT.METAL, wear: 0.25, snow: 0, rough: 0.28 });
    b.lathe([[0, -0.0355], [0.0058, -0.0355], [0.006, -0.034], [0.0052, -0.0325], [0.006, -0.031], [0.006, 0.004], [0.0045, 0.0085], [0.0044, 0.0145]], { sides: 12, smooth: true });
    b.ink({ color: hex(0xa4633e), mat: MAT.METAL, wear: 0.3, snow: 0, rough: 0.3 });
    b.lathe([[0.004, 0.0142], [0.0039, 0.022], [0.0031, 0.03], [0.0016, 0.0345]], { sides: 12, smooth: true });
    b.ink({ color: hex(0x5d5e60), mat: MAT.METAL, wear: 0.4, snow: 0, rough: 0.6 });
    b.lathe([[0.0016, 0.0343], [0.0011, 0.0352], [0, 0.0356]], { sides: 12, smooth: true });
    return done(b);
  },
  /** A spent case (the round without its bullet, a little darker at the mouth). */
  case() {
    const b = new Builder(0x3a83);
    b.ink({ color: mixRGB(PAL.brass, hex(0x3a2a18), 0.15), mat: MAT.METAL, wear: 0.3, snow: 0, rough: 0.3 });
    const c = b.lathe([[0, -0.0355], [0.0058, -0.0355], [0.006, -0.034], [0.0052, -0.0325], [0.006, -0.031], [0.006, 0.004], [0.0045, 0.0085], [0.0044, 0.0145], [0.0038, 0.0145], [0.0038, 0.006]], { sides: 12, smooth: true });
    c.tint(hex(0x1c140c), (v) => (v.y > 0.01 ? 0.6 : 0));
    return done(b);
  },
  /** A D cell along +Y: black jacket with a copper-gold band, steel ends, the + button up. */
  cell() {
    const b = new Builder(0x3a84);
    b.ink({ color: hex(0x18181a), mat: MAT.PAINT, wear: 0.35, snow: 0, rough: 0.4 });
    b.lathe([[0.0164, -0.0302], [0.017, -0.029], [0.017, 0.0285], [0.0164, 0.0298]], { sides: 18, smooth: true });
    b.ink({ color: hex(0xa8742c), mat: MAT.PAINT, wear: 0.3, snow: 0, rough: 0.35 });
    b.lathe([[0.01705, 0.012], [0.01705, 0.0272]], { sides: 18, smooth: true });
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.2, snow: 0, rough: 0.3 });
    b.lathe([[0, -0.0306], [0.0155, -0.0305], [0.0164, -0.0302]], { sides: 18, smooth: true });
    b.lathe([[0.0164, 0.0298], [0.0118, 0.03], [0.0058, 0.0302], [0.0055, 0.0322], [0, 0.0324]], { sides: 18, smooth: true });
    return done(b);
  },
};
