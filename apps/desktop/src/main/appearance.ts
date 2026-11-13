// Window scale: the pure decisions, plus a small file-backed preference.
//
// Zoom belongs to the main process for two reasons. It is a property of the
// window (Chromium applies it to the web contents, so every layout reflows
// together — controls, timeline, composer and drawer all move instead of one
// panel growing while the rest stays fixed). And the keyboard shortcut must work
// wherever focus is, including inside the terminal drawer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ZOOM_FACTORS, type AppearanceView, type ZoomDirection } from '../shared/appearance.js';

const LADDER: readonly number[] = ZOOM_FACTORS;
const DEFAULT_FACTOR = 1;
const EPSILON = 0.0001;

/** The ladder entry at an index, clamped. Never undefined: an out-of-range index is the design scale. */
function factorAt(index: number): number {
  return LADDER[Math.max(0, Math.min(LADDER.length - 1, index))] ?? DEFAULT_FACTOR;
}

function sameFactor(left: number, right: number): boolean {
  return Math.abs(left - right) < EPSILON;
}

/** Index of the design scale in the ladder, used as the reset position. */
const DEFAULT_INDEX = Math.max(
  0,
  LADDER.findIndex((factor) => sameFactor(factor, DEFAULT_FACTOR)),
);

/** The ladder entry closest to any number, so a stale or edited file cannot break scaling. */
export function nearestZoomFactor(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_FACTOR;
  let best = factorAt(DEFAULT_INDEX);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const factor of LADDER) {
    const distance = Math.abs(factor - numeric);
    if (distance < bestDistance) {
      best = factor;
      bestDistance = distance;
    }
  }
  return best;
}

export function nextZoomFactor(current: number, direction: ZoomDirection): number {
  const index = LADDER.findIndex((factor) => sameFactor(factor, nearestZoomFactor(current)));
  const resolved = index < 0 ? DEFAULT_INDEX : index;
  if (direction === 'reset') return DEFAULT_FACTOR;
  const delta = direction === 'in' ? 1 : -1;
  return factorAt(resolved + delta);
}

export function zoomPercent(factor: number): number {
  return Math.round(nearestZoomFactor(factor) * 100);
}

export function appearanceView(factor: number): AppearanceView {
  const resolved = nearestZoomFactor(factor);
  const percent = zoomPercent(resolved);
  return {
    zoomFactor: resolved,
    zoomPercent: percent,
    canZoomIn: !sameFactor(resolved, factorAt(LADDER.length - 1)),
    canZoomOut: !sameFactor(resolved, factorAt(0)),
    detail: `Scale ${percent}%`,
  };
}

/**
 * Which zoom step a key event asks for, or null when it is not a zoom key.
 *
 * Ctrl with '+' or '=' (the unshifted key on most layouts), '-' or '_', and '0'.
 * Numpad add/subtract/0 are matched by `code` because their `key` values vary by
 * layout. Alt is excluded so it cannot collide with the Alt+N section shortcuts,
 * and a repeat is honoured so holding the key keeps stepping.
 */
export function zoomShortcut(input: {
  key: string;
  code?: string;
  control: boolean;
  meta?: boolean;
  alt?: boolean;
}): ZoomDirection | null {
  if (!(input.control || input.meta)) return null;
  if (input.alt) return null;
  const code = input.code ?? '';
  if (code === 'NumpadAdd') return 'in';
  if (code === 'NumpadSubtract') return 'out';
  if (code === 'Numpad0') return 'reset';
  switch (input.key) {
    case '+':
    case '=':
      return 'in';
    case '-':
    case '_':
      return 'out';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

/** Read the saved scale. A missing, unreadable or out-of-ladder file is the design scale. */
export function readZoom(file: string): number {
  try {
    if (!existsSync(file)) return DEFAULT_FACTOR;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { zoomFactor?: unknown };
    return nearestZoomFactor(parsed?.zoomFactor);
  } catch {
    return DEFAULT_FACTOR;
  }
}

/** Persist the scale. Failing to write is not a reason to refuse the zoom. */
export function writeZoom(file: string, factor: number): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ schema: 1, zoomFactor: nearestZoomFactor(factor) }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
