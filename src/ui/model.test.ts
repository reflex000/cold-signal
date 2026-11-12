import { describe, expect, it } from 'vitest';
import type { Camera } from '../game/view';
import type { PlayerEnt } from '../sim/types';
import { bearingTo, coldStage, contextAction, coreFrac, project, toolReadout, trendClass, wrapPi } from './model';

function me(over: Partial<PlayerEnt> = {}): PlayerEnt {
  return {
    id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, rev: 0, name: 'A', slot: 0, bot: false,
    vx: 0, vy: 0, vz: 0, pitch: 0, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 37, wet: 0, stamina: 1, hunger: 0, feels: -10, shelter: 0, fireHeat: 0, huddle: 0, trend: 0,
    bleed: 90, revive: 0, reviver: 0, inv: {}, held: 'hands', act: 'none', actT: 0, loaded: 0, flareLoaded: 0, lightOn: false,
    cellCharge: 1, radioCharge: 0, radioSig: 0, radioDist: -1, aim: 0, carry: 0, isolation: 0, kills: 0,
    ...over,
  };
}

describe('ui model', () => {
  it('stages follow DESIGN.md thresholds with hysteresis', () => {
    expect(coldStage(36.5)).toBe(0);
    expect(coldStage(35)).toBe(1);
    expect(coldStage(33)).toBe(2);
    expect(coldStage(31)).toBe(3);
    expect(coldStage(30.2)).toBe(3);
    // warming just past a boundary keeps the colder stage until clearly out
    expect(coldStage(35.03, 1)).toBe(1);
    expect(coldStage(35.2, 1)).toBe(0);
    expect(coldStage(33.05, 2)).toBe(2);
  });

  it('maps the core onto the instrument', () => {
    expect(coreFrac(30)).toBe(0);
    expect(coreFrac(37.5)).toBe(1);
    expect(coreFrac(20)).toBe(0);
    expect(coreFrac(40)).toBe(1);
  });

  it('turns the trend into an arrow', () => {
    expect(trendClass(0)).toBe('');
    expect(trendClass(-0.3)).toBe('dn');
    expect(trendClass(-1.5)).toBe('dn fast');
    expect(trendClass(0.5)).toBe('up');
    expect(trendClass(2)).toBe('up fast');
  });

  it('reads tools', () => {
    expect(toolReadout(me({ held: 'hands' }))).toBeNull();
    expect(toolReadout(me({ held: 'axe' }))).toBeNull();
    const r = toolReadout(me({ held: 'rifle', loaded: 0, inv: { rifle: 1, ammo: 7 } }))!;
    expect(r.big).toBe('0');
    expect(r.small).toBe('/ 7');
    expect(r.empty).toBe(true);
    const f = toolReadout(me({ held: 'flashlight', cellCharge: 0.1, lightOn: true, inv: { flashlight: 1, cell: 2 } }))!;
    expect(f.bar).toBeCloseTo(0.1);
    expect(f.low).toBe(true);
    expect(f.note).toBe('On');
    const radio = toolReadout(me({ held: 'radio', radioCharge: 0.5, radioSig: 0.9, radioDist: 230, inv: { radio: 1 } }))!;
    expect(radio.sig).toBe(5);
    expect(radio.note).toBe('about 250 m');
    expect(toolReadout(me({ held: 'radio', radioCharge: 0, radioSig: 0.9 }))!.sig).toBe(0);
  });

  it('offers reload only when it can', () => {
    expect(contextAction(me({ held: 'rifle', loaded: 5, inv: { ammo: 3 } }))).toBeNull();
    expect(contextAction(me({ held: 'rifle', loaded: 2, inv: { ammo: 3 } }))).toBe('reload');
    expect(contextAction(me({ held: 'rifle', loaded: 2, inv: {} }))).toBeNull();
    expect(contextAction(me({ held: 'flashlight' }))).toBe('light');
  });

  it('measures bearings clockwise from north', () => {
    expect(bearingTo(0, 0, 0, -10)).toBeCloseTo(0);
    expect(bearingTo(0, 0, 10, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(bearingTo(0, 0, 0, 10))).toBeCloseTo(Math.PI);
    expect(bearingTo(0, 0, -10, 0)).toBeCloseTo(-Math.PI / 2);
    expect(wrapPi(Math.PI * 3)).toBeCloseTo(-Math.PI);
    expect(wrapPi(-0.5)).toBeCloseTo(-0.5);
  });

  it('projects points in front of the camera', () => {
    const cam: Camera = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 90, third: 0 };
    const out = [0, 0, 0];
    expect(project(cam, 0, 0, -10, 800, 600, out)).toBe(true);
    expect(out[0]).toBeCloseTo(400);
    expect(out[1]).toBeCloseTo(300);
    expect(out[2]).toBeCloseTo(10);
    // east of a north-facing camera is to the right
    project(cam, 5, 0, -10, 800, 600, out);
    expect(out[0]).toBeGreaterThan(400);
    // above is up
    project(cam, 0, 5, -10, 800, 600, out);
    expect(out[1]).toBeLessThan(300);
    // behind
    expect(project(cam, 0, 0, 10, 800, 600, out)).toBe(false);
    // turned left (yaw +90 deg) the camera faces west
    const west: Camera = { ...cam, yaw: Math.PI / 2 };
    expect(project(west, -10, 0, 0, 800, 600, out)).toBe(true);
    expect(out[0]).toBeCloseTo(400);
  });
});
