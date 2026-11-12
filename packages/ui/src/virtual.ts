/**
 * Fixed-row windowing. A diff, a change list, or any long uniform row list is
 * rendered as a slice of rows inside a spacer box of the full height, so the
 * DOM never holds more than `overscan` rows beyond the viewport. Rows must have
 * a fixed height; the caller sets it in CSS and passes the same number here.
 *
 * This is deliberately arithmetic, not measurement: a scrolling list that
 * measures every row is what makes a long diff freeze.
 */

export type VirtualWindowInput = {
  /** Scroll offset of the container in pixels. */
  scrollTop: number;
  /** Visible height of the container in pixels. */
  viewport: number;
  /** Uniform row height in pixels. */
  rowHeight: number;
  /** Number of rows in the list. */
  total: number;
  /** Extra rows rendered above and below the viewport. Defaults to 8. */
  overscan?: number;
};

export type VirtualWindow = {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Pixel offset of `start` from the top of the list. */
  offset: number;
  /** Total pixel height of the list. */
  height: number;
  /** Number of rows actually rendered. */
  rendered: number;
};

export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const rowHeight = Number.isFinite(input.rowHeight) && input.rowHeight > 0 ? input.rowHeight : 1;
  const total = Math.max(0, Math.floor(Number.isFinite(input.total) ? input.total : 0));
  const overscan = Math.max(0, Math.floor(input.overscan ?? 8));
  const viewport = Math.max(0, Number.isFinite(input.viewport) ? input.viewport : 0);
  const scrollTop = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0);
  const height = total * rowHeight;
  if (total === 0) return { start: 0, end: 0, offset: 0, height: 0, rendered: 0 };

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleRows = Math.ceil(viewport / rowHeight) + 1;
  const start = Math.max(0, Math.min(total - 1, firstVisible - overscan));
  const end = Math.min(total, Math.max(start, firstVisible + visibleRows + overscan));
  return {
    start,
    end,
    offset: start * rowHeight,
    height,
    rendered: Math.max(0, end - start),
  };
}

/** Scroll offset that brings `index` into view, with the row just above it. */
export function scrollTopForRow(index: number, rowHeight: number): number {
  const rowHeightSafe = rowHeight > 0 ? rowHeight : 1;
  const rowTop = Math.max(0, Math.floor(index)) * rowHeightSafe;
  // Keep one row of context above the target instead of pinning it to the edge.
  return Math.max(0, rowTop - rowHeightSafe);
}
