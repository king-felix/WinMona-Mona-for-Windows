// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette, type PaletteItem } from './palette.js';

const items: PaletteItem[] = [
  { id: 'open', label: 'Open a folder…', group: 'Projects' },
  { id: 'home', label: 'Go to Home', group: 'Navigate' },
  { id: 'settings', label: 'Go to Settings', group: 'Navigate' },
];

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<button id="opener">Open palette</button><div id="root"></div>';
  document.getElementById('opener')?.focus();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
});

async function render(selected: (id: string) => void, closed = (): void => {}): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  root = createRoot(container);
  await act(async () => {
    root?.render(<CommandPalette open label="Command palette" items={items} onSelect={selected} onClose={closed} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function paletteInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.mona-palette input');
  if (!input) throw new Error('palette input missing');
  return input;
}

describe('CommandPalette', () => {
  it('focuses the filter, lists actions, and runs the highlighted one with Enter', async () => {
    const selected: string[] = [];
    await render((id) => selected.push(id));
    expect(document.activeElement).toBe(paletteInput());

    await act(async () => {
      paletteInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      paletteInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(selected).toEqual(['home']);
  });

  it('filters by label and group, and closes on Escape', async () => {
    let closed = 0;
    await render(
      () => undefined,
      () => (closed += 1),
    );
    const input = paletteInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'settings');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = Array.from(document.querySelectorAll('.mona-palette-item')).map((node) => node.textContent);
    expect(labels).toEqual(['Go to Settings']);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(1);
  });

  it('reports no match instead of pretending an action exists', async () => {
    await render(() => undefined);
    const input = paletteInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'zzz');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('No matching action.');
  });
});
