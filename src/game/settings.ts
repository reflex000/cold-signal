// Player settings: defaults, validation, and persistence in localStorage ('cs.settings').
// Storage can be missing or full (private mode, quota): every access is guarded and the game runs
// on defaults.
// Owner: GAME.
import type { Settings } from './view';

const KEY = 'cs.settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  quality: 'auto',
  renderScale: 1,
  fov: 75,
  sensitivity: 1,
  invertY: false,
  master: 0.9,
  music: 0.7,
  sfx: 1,
  shake: true,
  grain: true,
  hints: true,
  bots: 0,
  showFps: false,
});

const QUALITIES: readonly Settings['quality'][] = ['mobile', 'low', 'medium', 'high', 'ultra', 'auto'];

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** A valid value for `key`, or the default when `v` is not one. */
export function cleanSetting<K extends keyof Settings>(key: K, v: unknown): Settings[K] {
  const d = DEFAULT_SETTINGS[key];
  switch (key) {
    case 'quality':
      return (QUALITIES.includes(v as Settings['quality']) ? v : d) as Settings[K];
    case 'renderScale':
      return (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0.5, 1) : d) as Settings[K];
    case 'fov':
      return (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), 60, 100) : d) as Settings[K];
    case 'sensitivity':
      return (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0.2, 3) : d) as Settings[K];
    case 'master':
    case 'music':
    case 'sfx':
      return (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : d) as Settings[K];
    case 'bots':
      return (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), 0, 3) : d) as Settings[K];
    default:
      return (typeof v === 'boolean' ? v : d) as Settings[K];
  }
}

export function loadSettings(useStorage: boolean): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!useStorage) return s;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return s;
    const o = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    if (!o || typeof o !== 'object') return s;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k in o) (s as unknown as Record<string, unknown>)[k] = cleanSetting(k, o[k]);
    }
  } catch {
    /* unreadable: defaults */
  }
  return s;
}

export function storeSettings(s: Settings, useStorage: boolean): void {
  if (!useStorage) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: settings last for this visit only */
  }
}
