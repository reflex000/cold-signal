import { describe, expect, it } from 'vitest';
import { Atmosphere, SkyLut } from './atmosphere';
import { slowdown } from '../../sim/timing';

const DEG = Math.PI / 180;
const verbose = !!(globalThis as any).process?.env?.ATMOS_VERBOSE;
const log = (...a: unknown[]): void => {
  if (verbose) console.log(...a);
};

describe('atmosphere', () => {
  // how busy the machine was around the build (1 = idle): the budget scales with it (sim/timing.ts)
  const before = slowdown();
  const t0 = performance.now();
  const atm = new Atmosphere(1.6);
  const built = performance.now() - t0;
  const slow = Math.max(before, slowdown());

  it('builds its static tables quickly', () => {
    log('static tables ms', built.toFixed(1), 'machine slowdown', slow.toFixed(2));
    expect(built).toBeLessThan(400 * slow);
  });

  it('reddens the sun toward the horizon', () => {
    const T = [0, 0, 0];
    const r = atm.r0;
    const at = (el: number): number[] => {
      atm.lightTransmittance(r, Math.sin(el * DEG), T);
      return [...T];
    };
    const noon = at(22), low = at(5), set = at(0.5);
    log('T noon', noon.map((v) => v.toFixed(3)), 'el5', low.map((v) => v.toFixed(3)), 'el0.5', set.map((v) => v.toFixed(3)));
    expect(noon[0]).toBeGreaterThan(noon[2]);
    expect(noon[2]).toBeGreaterThan(0.3);
    expect(low[2] / low[0]).toBeLessThan(noon[2] / noon[0]);
    expect(set[2] / set[0]).toBeLessThan(low[2] / low[0]);
  });

  it('makes a blue sky by day and a blue hour after sunset', () => {
    const lut = new SkyLut(atm, 32, 48, 20);
    lut.buildNow(30 * DEG); // warm the JIT
    const s0 = performance.now();
    lut.buildNow(22 * DEG);
    const ms = performance.now() - s0;
    const o = [0, 0, 0];
    const look = (el: number, az: number, sunEl: number): number[] => {
      const c = Math.cos(el * DEG) * Math.cos(az * DEG) * Math.cos(sunEl * DEG) + Math.sin(el * DEG) * Math.sin(sunEl * DEG);
      lut.sample(el * DEG, az * DEG, c, o);
      return [...o];
    };
    const zen = look(89, 0, 22);
    const away = look(5, 180, 22);
    const toward = look(5, 0, 22);
    log('lut ms', ms.toFixed(1), 'zenith', zen.map((v) => v.toExponential(2)), 'horizon away', away.map((v) => v.toExponential(2)), 'toward', toward.map((v) => v.toExponential(2)));
    expect(zen[2]).toBeGreaterThan(zen[0] * 1.8);
    expect(toward[0]).toBeGreaterThan(away[0]);
    lut.buildNow(-5 * DEG);
    const bz = look(89, 0, -5);
    const bt = look(3, 0, -5);
    const ba = look(3, 180, -5);
    log('blue hour zenith', bz.map((v) => v.toExponential(2)), 'toward', bt.map((v) => v.toExponential(2)), 'anti', ba.map((v) => v.toExponential(2)));
    expect(bz[2]).toBeGreaterThan(bz[0]);
    expect(bt[0]).toBeGreaterThan(ba[0]);
    expect(ms).toBeLessThan(200);
  });
});
