import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { scrollTopForRow, virtualWindow } from './virtual.js';

export type VirtualListProps = {
  /** Accessible name for the scrolling region. */
  label: string;
  /** Uniform row height in pixels; must match the CSS the rows use. */
  rowHeight: number;
  rowCount: number;
  renderRow: (index: number) => ReactNode;
  /** Scroll this row into view when it changes; null keeps the current offset. */
  scrollToIndex?: number | null;
  className?: string;
};

/**
 * A fixed-height windowed list. Only the visible rows (plus overscan) exist in
 * the DOM, so a 10,000-line diff scrolls without building 10,000 elements. The
 * container is a focusable scroll region with its own Escape handling left to
 * the parent, matching the other scroll regions in the app.
 */
export function VirtualList({
  label,
  rowHeight,
  rowCount,
  renderRow,
  scrollToIndex = null,
  className,
}: VirtualListProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => setViewport(node.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (scrollToIndex === null) return;
    const node = ref.current;
    if (!node) return;
    const next = scrollTopForRow(scrollToIndex, rowHeight);
    node.scrollTop = next;
    setScrollTop(next);
  }, [scrollToIndex, rowHeight, viewport]);

  const win = useMemo(
    () => virtualWindow({ scrollTop, viewport, rowHeight, total: rowCount }),
    [scrollTop, viewport, rowHeight, rowCount],
  );

  const rows: ReactNode[] = [];
  for (let index = win.start; index < win.end; index += 1) {
    rows.push(
      <div key={index} role="listitem" className="mona-virtual-row" style={{ height: rowHeight }}>
        {renderRow(index)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className={`mona-virtual ${className ?? ''}`.trim()}
      role="list"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="mona-virtual-spacer" style={{ height: Math.max(win.height, rowHeight) }}>
        <div className="mona-virtual-rows" style={{ transform: `translateY(${win.offset}px)` }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
