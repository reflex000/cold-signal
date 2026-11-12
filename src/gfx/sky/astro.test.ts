import { describe, expect, it } from 'vitest';
import { afternoonCrossing, skyBodies, starFrame } from './astro';

const DEG = Math.PI / 180;

describe('astro', () => {
  it('puts the winter sun about 22 degrees high at noon and sets it about 16:45', () => {
    const noon = skyBodies(12.4, 0);
    expect(noon.sunElevation / DEG).toBeGreaterThan(20.5);
    expect(noon.sunElevation / DEG).toBeLessThan(23.5);
    expect(noon.sun.z).toBeGreaterThan(0.8); // due south (+Z)
    const set = afternoonCrossing(0);
    expect(set).toBeGreaterThan(16.6);
    expect(set).toBeLessThan(16.9);
    // the sun sets in the south-west: west is -X, south is +Z
    const s = skyBodies(set, 0).sun;
    expect(s.x).toBeLessThan(-0.5);
    expect(s.z).toBeGreaterThan(0.3);
    // blue hour: sun 4 to 8 degrees below the horizon around 17:15
    const blue = skyBodies(17.25, 0).sunElevation / DEG;
    expect(blue).toBeLessThan(-3);
    expect(blue).toBeGreaterThan(-9);
  });

  it('has a waxing gibbous moon up through the first evening', () => {
    const dusk = skyBodies(17.0, 0);
    const late = skyBodies(22.0, 0);
    expect(dusk.moonLit).toBeGreaterThan(0.6);
    expect(dusk.moonLit).toBeLessThan(0.85);
    expect(dusk.moonElevation / DEG).toBeGreaterThan(5);
    expect(late.moonElevation / DEG).toBeGreaterThan(30);
    // fuller two days later
    expect(skyBodies(22.0, 2).moonLit).toBeGreaterThan(late.moonLit);
    const m = late.moon;
    expect(Math.hypot(m.x, m.y, m.z)).toBeCloseTo(1, 6);
  });

  it('turns the stars about the celestial pole 46 degrees up in the north', () => {
    for (const sid of [0, 1.3, 4.2]) {
      const M = starFrame(sid);
      // the pole (star frame +Z) is fixed
      expect(M[6]).toBeCloseTo(0, 6);
      expect(M[7]).toBeCloseTo(Math.sin(46 * DEG), 6);
      expect(M[8]).toBeCloseTo(-Math.cos(46 * DEG), 6);
      // orthonormal columns
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const d = M[a * 3] * M[b * 3] + M[a * 3 + 1] * M[b * 3 + 1] + M[a * 3 + 2] * M[b * 3 + 2];
          expect(d).toBeCloseTo(a === b ? 1 : 0, 6);
        }
      }
    }
  });
});
