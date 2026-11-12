// Where the sun, the moon and the stars are. Pure math, no three.js: tested in astro.test.ts.
//
// The mountain sits at about 46 degrees north in early winter: the sun's declination is near -22
// degrees, so it culminates about 22 degrees high at 12:24 local time and sets about 16:45 after a
// short, low arc through the south. The moon runs on its own track: a waxing gibbous on the first
// evening that rises in the afternoon, rides high through the night and grows fuller each day.
//
// World axes: X east, Y up, Z south (north is -Z). Directions returned are unit vectors toward
// the body. Angles in radians unless a name says otherwise. Owner: ATMOS.
import { DEG, TAU } from '../../core/math';

export const LATITUDE = 46 * DEG;
/** Local clock hour of solar noon (time zone and equation of time folded in). */
export const SOLAR_NOON = 12.4;
const OBLIQUITY = 23.44 * DEG;
/** Sun's declination on day 0, and its drift per day toward the solstice. */
const SUN_DEC0 = -22 * DEG;
const SUN_DEC_RATE = -0.12 * DEG;
/** Moon's elongation from the sun on day 0 at 00:00 (115 deg: waxing gibbous at dusk). */
const MOON_ELONG0 = 112 * DEG;
const SYNODIC_RATE = TAU / 29.53; // elongation gained per day
const MOON_INCL = 5.1 * DEG;
const MOON_NODE = 40 * DEG; // ecliptic longitude of the ascending node (sets how high the moon rides)
/** Angular radii of the discs as seen from the ground. */
export const SUN_RADIUS = 0.267 * DEG;
export const MOON_RADIUS = 0.259 * DEG;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface SkyBodies {
  /** Unit vector toward the sun. */
  sun: Vec3Like;
  /** Unit vector toward the moon. */
  moon: Vec3Like;
  /** Fraction of the moon's disc that is lit, 0 (new) .. 1 (full). */
  moonLit: number;
  /** Elongation of the moon from the sun, radians 0..2pi (pi = full). */
  moonElongation: number;
  /** Elevation of the sun above the horizon, radians. */
  sunElevation: number;
  moonElevation: number;
  /** Local sidereal angle, radians: rotates the star field about the celestial pole. */
  sidereal: number;
}

/** Fractional days since day 0 00:00. */
export function daysOf(clock: number, day: number): number {
  return day + clock / 24;
}

/**
 * Direction toward a body at hour angle h (radians, positive after it culminates) and declination
 * dec, seen from LATITUDE. Writes into out and returns it.
 */
export function horizonDir(h: number, dec: number, out: Vec3Like): Vec3Like {
  const sl = Math.sin(LATITUDE), cl = Math.cos(LATITUDE);
  const sd = Math.sin(dec), cd = Math.cos(dec);
  const ch = Math.cos(h), sh = Math.sin(h);
  const east = -cd * sh;
  const north = sd * cl - cd * ch * sl;
  const up = sl * sd + cl * cd * ch;
  out.x = east;
  out.y = up;
  out.z = -north;
  return out;
}

/** Declination of a point on the ecliptic at longitude lon with ecliptic latitude lat. */
function eclipticDec(lon: number, lat: number): number {
  return Math.asin(Math.sin(lat) * Math.cos(OBLIQUITY) + Math.cos(lat) * Math.sin(OBLIQUITY) * Math.sin(lon));
}

/** Right ascension of a point on the ecliptic. */
function eclipticRA(lon: number, lat: number): number {
  return Math.atan2(Math.sin(lon) * Math.cos(OBLIQUITY) - Math.tan(lat) * Math.sin(OBLIQUITY), Math.cos(lon));
}

export function sunDeclination(days: number): number {
  return SUN_DEC0 + SUN_DEC_RATE * days;
}

/** Positions of the sun and moon for a clock hour (0..24) on a given day. */
export function skyBodies(clock: number, day: number, out?: SkyBodies): SkyBodies {
  const o: SkyBodies = out ?? { sun: { x: 0, y: 1, z: 0 }, moon: { x: 0, y: 1, z: 0 }, moonLit: 0, moonElongation: 0, sunElevation: 0, moonElevation: 0, sidereal: 0 };
  const days = daysOf(clock, day);
  const hSun = ((clock - SOLAR_NOON) / 24) * TAU;
  const decSun = sunDeclination(days);
  horizonDir(hSun, decSun, o.sun);
  o.sunElevation = Math.asin(Math.max(-1, Math.min(1, o.sun.y)));

  // The sun's ecliptic longitude follows from its declination (it is before the solstice, so
  // the longitude is in the third quadrant).
  const sinLon = Math.max(-1, Math.min(1, Math.sin(decSun) / Math.sin(OBLIQUITY)));
  const lonSun = Math.PI - Math.asin(sinLon); // 180 + |asin|: 250 deg for -22 deg
  const raSun = eclipticRA(lonSun, 0);

  // Moon: elongation grows by one turn per synodic month; latitude from a fixed node.
  const elong = MOON_ELONG0 + SYNODIC_RATE * days;
  const lonMoon = lonSun + elong;
  const latMoon = MOON_INCL * Math.sin(lonMoon - MOON_NODE);
  const raMoon = eclipticRA(lonMoon, latMoon);
  const decMoon = eclipticDec(lonMoon, latMoon);
  // Hour angle: the sky turns as one; the moon lags the sun by the difference in right ascension.
  const hMoon = hSun - (raMoon - raSun);
  horizonDir(hMoon, decMoon, o.moon);
  o.moonElevation = Math.asin(Math.max(-1, Math.min(1, o.moon.y)));
  o.moonElongation = ((elong % TAU) + TAU) % TAU;
  o.moonLit = 0.5 * (1 - Math.cos(o.moonElongation));
  // Local sidereal angle = hour angle of the sun + its right ascension.
  o.sidereal = hSun + raSun;
  return o;
}

/**
 * Column-major 3x3 rotation (as 9 numbers) taking a direction in the star frame (z toward the
 * celestial pole, x toward right ascension 0) to world space at a sidereal angle. Orthonormal, so
 * its transpose maps world directions back into the star frame.
 */
export function starFrame(sidereal: number, out: number[] = new Array(9)): number[] {
  // A star at right ascension ra, declination dec has hour angle h = sidereal - ra. Map the three
  // basis vectors of the star frame through horizonDir's formula (linear in the star vector).
  const sl = Math.sin(LATITUDE), cl = Math.cos(LATITUDE);
  const cs = Math.cos(sidereal), ss = Math.sin(sidereal);
  // Star vector s = (cos dec cos ra, cos dec sin ra, sin dec).
  // cos dec cos h = cs*s.x + ss*s.y ; cos dec sin h = ss*s.x - cs*s.y ; sin dec = s.z
  const map = (sx: number, sy: number, sz: number, k: number): void => {
    const cdch = cs * sx + ss * sy;
    const cdsh = ss * sx - cs * sy;
    const sd = sz;
    const east = -cdsh;
    const north = sd * cl - cdch * sl;
    const up = sl * sd + cl * cdch;
    out[k] = east;
    out[k + 1] = up;
    out[k + 2] = -north;
  };
  map(1, 0, 0, 0);
  map(0, 1, 0, 3);
  map(0, 0, 1, 6);
  return out;
}

/** Clock hour (0..24) at which the sun's centre crosses a given elevation in the afternoon. */
export function afternoonCrossing(elevation: number, day = 0): number {
  const dec = sunDeclination(day + 0.7);
  const c = (Math.sin(elevation) - Math.sin(LATITUDE) * Math.sin(dec)) / (Math.cos(LATITUDE) * Math.cos(dec));
  const h = Math.acos(Math.max(-1, Math.min(1, c)));
  return SOLAR_NOON + (h / TAU) * 24;
}
