import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZOOM_FACTORS } from '../shared/appearance.js';
import {
  appearanceView,
  nearestZoomFactor,
  nextZoomFactor,
  readZoom,
  writeZoom,
  zoomPercent,
  zoomShortcut,
} from './appearance.js';

describe('window scale ladder', () => {
  it('starts at the design scale and clamps at both ends', () => {
    expect(appearanceView(1).zoomPercent).toBe(100);
    expect(zoomPercent(1)).toBe(100);
    let factor = 1;
    for (let index = 0; index < 20; index += 1) factor = nextZoomFactor(factor, 'in');
    expect(factor).toBe(ZOOM_FACTORS[ZOOM_FACTORS.length - 1]);
    for (let index = 0; index < 40; index += 1) factor = nextZoomFactor(factor, 'out');
    expect(factor).toBe(ZOOM_FACTORS[0]);
  });

  it('steps one rung at a time and resets to 100%', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1);
    expect(nextZoomFactor(1, 'out')).toBe(0.9);
    expect(nextZoomFactor(0.5, 'reset')).toBe(1);
    expect(nextZoomFactor(2, 'reset')).toBe(1);
  });

  it('snaps any value to the nearest rung rather than trusting it', () => {
    expect(nearestZoomFactor(1.04)).toBe(1);
    expect(nearestZoomFactor('0.62')).toBe(0.6);
    expect(nearestZoomFactor(Number.NaN)).toBe(1);
    expect(nearestZoomFactor(undefined)).toBe(1);
    expect(nearestZoomFactor(7)).toBe(2);
    expect(nearestZoomFactor(-3)).toBe(0.5);
  });

  it('reports honestly when a direction is exhausted, and names the scale', () => {
    const max = appearanceView(2);
    expect(max.canZoomIn).toBe(false);
    expect(max.canZoomOut).toBe(true);
    expect(max.detail).toBe('Scale 200%');
    const min = appearanceView(0.5);
    expect(min.canZoomOut).toBe(false);
    expect(min.canZoomIn).toBe(true);
    const design = appearanceView(1);
    expect(design.canZoomIn).toBe(true);
    expect(design.canZoomOut).toBe(true);
  });
});

describe('zoom keyboard shortcut', () => {
  const base = { control: true, meta: false, alt: false };

  it('maps Ctrl with plus, minus and zero, including the unshifted keys', () => {
    expect(zoomShortcut({ ...base, key: '+' })).toBe('in');
    expect(zoomShortcut({ ...base, key: '=' })).toBe('in');
    expect(zoomShortcut({ ...base, key: '-' })).toBe('out');
    expect(zoomShortcut({ ...base, key: '_' })).toBe('out');
    expect(zoomShortcut({ ...base, key: '0' })).toBe('reset');
  });

  it('maps the numpad by code, because its key values vary by layout', () => {
    expect(zoomShortcut({ ...base, key: 'Add', code: 'NumpadAdd' })).toBe('in');
    expect(zoomShortcut({ ...base, key: 'Subtract', code: 'NumpadSubtract' })).toBe('out');
    expect(zoomShortcut({ ...base, key: 'Insert', code: 'Numpad0' })).toBe('reset');
  });

  it('ignores unmodified keys, Alt combinations and unrelated keys', () => {
    expect(zoomShortcut({ key: '=', control: false, meta: false, alt: false })).toBeNull();
    expect(zoomShortcut({ ...base, key: '=', alt: true })).toBeNull();
    expect(zoomShortcut({ ...base, key: 'k' })).toBeNull();
    // Cmd on macOS behaves like Ctrl here.
    expect(zoomShortcut({ key: '+', control: false, meta: true, alt: false })).toBe('in');
  });
});

describe('persisted scale', () => {
  it('round-trips through a file, and treats junk as the design scale', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mona-zoom-'));
    const file = path.join(root, 'state', 'appearance.json');
    try {
      expect(readZoom(file)).toBe(1);
      expect(writeZoom(file, 1.25)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, zoomFactor: 1.25 });
      expect(readZoom(file)).toBe(1.25);
      // An out-of-ladder or malformed file must not break the window.
      writeFileSync(file, JSON.stringify({ zoomFactor: 9 }), 'utf8');
      expect(readZoom(file)).toBe(2);
      writeFileSync(file, 'not json', 'utf8');
      expect(readZoom(file)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
