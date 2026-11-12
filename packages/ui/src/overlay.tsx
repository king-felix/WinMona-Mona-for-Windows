import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './primitives.js';

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null || element.getClientRects().length > 0);
}

/**
 * Modal dialog: labelled, modal, Escape closes, Tab stays inside, and focus
 * returns to whatever opened it. A dialog that quietly drops focus into the page
 * behind it is a keyboard trap in reverse.
 */
export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
}): React.JSX.Element | null {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const node = panel.current;
    const first = node ? (focusables(node)[0] ?? node) : null;
    first?.focus();
    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const items = focusables(panel.current);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="mona-dialog-backdrop">
      <div
        className="mona-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <div>{children}</div>
        <div className="mona-row" style={{ justifyContent: 'flex-end' }}>
          {actions ?? (
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export type MenuItem = { id: string; label: string; hint?: string; disabled?: boolean; onSelect?: () => void };

/** Menu button: Escape closes and restores focus; arrows move between items. */
export function Menu({ label, items }: { label: string; items: readonly MenuItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')[activeIndex];
    first?.focus();
  }, [open, activeIndex]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="mona-menu">
      <Button variant="secondary" aria-label={`${label} menu`} onClick={() => setOpen((value) => !value)} ref={button}>
        {label}
      </Button>
      {open ? (
        <ul
          className="mona-menu-list"
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, items.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            }
          }}
        >
          {items.map((item, index) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="mona-menu-item"
                data-active={index === activeIndex}
                disabled={item.disabled}
                aria-disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.();
                  close();
                }}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="mona-muted">{item.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type TabItem = { id: string; label: string; panel?: ReactNode };

/** Tabs with roving focus; arrow keys move selection, Home/End jump. */
export function Tabs({
  label,
  items,
  activeId,
  onSelect,
}: {
  label: string;
  items: readonly TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const baseId = useId();
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  const move = (next: number): void => {
    const item = items[(next + items.length) % items.length];
    if (item) onSelect(item.id);
  };

  return (
    <div className="mona-stack">
      <div className="mona-tabs" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${baseId}-${item.id}`}
            className="mona-tab"
            aria-selected={item.id === activeId}
            aria-controls={`${baseId}-${item.id}-panel`}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(activeIndex + 1);
              }
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(activeIndex - 1);
              }
              if (event.key === 'Home') {
                event.preventDefault();
                move(0);
              }
              if (event.key === 'End') {
                event.preventDefault();
                move(items.length - 1);
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={`${item.id}-panel`}
          role="tabpanel"
          id={`${baseId}-${item.id}-panel`}
          aria-labelledby={`${baseId}-${item.id}`}
          hidden={item.id !== activeId}
          tabIndex={0}
        >
          {item.id === activeId ? item.panel : null}
        </div>
      ))}
    </div>
  );
}
