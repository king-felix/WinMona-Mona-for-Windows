import { describe, expect, it } from 'vitest';
import { scrollTopForRow, virtualWindow } from './virtual.js';

describe('virtualWindow', () => {
  it('renders only the visible rows plus overscan for a long uniform list', () => {
    const win = virtualWindow({ scrollTop: 0, viewport: 320, rowHeight: 16, total: 10_000, overscan: 4 });
    expect(win.start).toBe(0);
    // 320/16 = 20 visible rows, +1 partial, +4 overscan.
    expect(win.rendered).toBe(25);
    expect(win.end).toBeLessThan(30);
    expect(win.height).toBe(160_000);
    expect(win.offset).toBe(0);
  });

  it('moves the window with the scroll offset and keeps the spacer height exact', () => {
    const win = virtualWindow({ scrollTop: 1_600, viewport: 320, rowHeight: 16, total: 10_000, overscan: 2 });
    expect(win.start).toBe(98);
    expect(win.offset).toBe(1_568);
    expect(win.offset).toBe(win.start * 16);
    expect(win.height).toBe(160_000);
  });

  it('never renders past the end of the list', () => {
    const win = virtualWindow({ scrollTop: 159_999, viewport: 320, rowHeight: 16, total: 10_000 });
    expect(win.end).toBe(10_000);
    expect(win.rendered).toBeLessThanOrEqual(10_000 - win.start);
  });

  it('clamps hostile input instead of producing a negative or infinite window', () => {
    const win = virtualWindow({ scrollTop: -50, viewport: Number.NaN, rowHeight: 0, total: -3 });
    expect(win).toEqual({ start: 0, end: 0, offset: 0, height: 0, rendered: 0 });
  });

  it('renders a short list entirely', () => {
    const win = virtualWindow({ scrollTop: 0, viewport: 320, rowHeight: 16, total: 3, overscan: 8 });
    expect(win).toMatchObject({ start: 0, end: 3, rendered: 3 });
  });
});

describe('scrollTopForRow', () => {
  it('keeps one row of context above the target row', () => {
    expect(scrollTopForRow(10, 16, 320)).toBe(144);
    expect(scrollTopForRow(0, 16, 320)).toBe(0);
  });
});
