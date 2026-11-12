import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export type PaletteItem = {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  disabled?: boolean;
};

/**
 * Command palette shell: a labelled modal with a real filter, Arrow/Home/End
 * navigation, Enter to run the highlighted action, and Escape to close. It
 * carries no command execution of its own; the caller maps ids to safe handlers.
 */
export function CommandPalette({
  open,
  label,
  placeholder = 'Type a command or project name',
  items,
  onSelect,
  onClose,
}: {
  open: boolean;
  label: string;
  placeholder?: string;
  items: readonly PaletteItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const opener = useRef<Element | null>(null);
  const baseId = useId();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.label, item.hint ?? '', item.group ?? ''].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setQuery('');
    setActiveIndex(0);
    // Wait for the dialog to paint before claiming focus.
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      const previous = opener.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  if (!open) return null;

  const active = filtered[activeIndex];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(filtered.length - 1, 0));
      return;
    }
    if (event.key === 'Enter' && active && !active.disabled) {
      event.preventDefault();
      onSelect(active.id);
    }
  };

  return (
    <div className="mona-dialog-backdrop">
      <div
        className="mona-dialog mona-palette"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          className="mona-input"
          type="text"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active ? `${baseId}-${active.id}` : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {filtered.length === 0 ? (
          <p className="mona-muted" role="status">
            No matching action.
          </p>
        ) : (
          <ul className="mona-palette-list" id={`${baseId}-list`} role="listbox" aria-label={label}>
            {filtered.map((item, index) => (
              <li
                key={item.id}
                id={`${baseId}-${item.id}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={item.disabled ? true : undefined}
                data-active={index === activeIndex}
                className="mona-palette-item"
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!item.disabled) onSelect(item.id);
                }}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="mona-muted">{item.hint}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mona-muted mona-palette-help">
          Arrow keys move · Enter runs · Escape closes. Status changes are announced, not every keystroke.
        </p>
      </div>
    </div>
  );
}
