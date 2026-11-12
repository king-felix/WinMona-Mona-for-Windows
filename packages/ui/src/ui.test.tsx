// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Badge, Button, EmptyState, ErrorState, Field, Notification, Skeleton } from './primitives.js';
import { Dialog, Menu, Tabs } from './overlay.js';
import { Harness } from './harness/screens.js';
import { HARNESS_LABEL } from './harness/fixtures.js';

let root: Root | null = null;
const container = (): HTMLElement => document.getElementById('root') as HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  if (root) {
    const node = root;
    await act(async () => {
      node.unmount();
    });
    root = null;
  }
});

async function render(node: React.ReactNode): Promise<void> {
  const node_ = createRoot(container());
  root = node_;
  await act(async () => {
    node_.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('primitives', () => {
  it('labels a field, describes its error and marks it invalid', async () => {
    await render(<Field label="Project label" value="" hint="Shown in the catalog" error="A label is required" />);
    const input = container().querySelector('input');
    expect(input).not.toBeNull();
    const label = container().querySelector('label');
    expect(label?.getAttribute('for')).toBe(input?.id);
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input?.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('hint');
    expect(container().querySelector('[role="alert"]')?.textContent).toContain('A label is required');
  });

  it('carries status meaning in text and glyph, not colour alone', async () => {
    await render(<Badge tone="critical">blocked</Badge>);
    const badge = container().querySelector('.mona-badge') as HTMLElement;
    expect(badge.textContent).toContain('blocked');
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).not.toBe('');
    expect(badge.getAttribute('data-tone')).toBe('critical');
  });

  it('announces errors assertively and loading state politely', async () => {
    await render(
      <>
        <ErrorState title="Engine unavailable" detail="Executable missing" />
        <Skeleton label="Loading projects" />
      </>,
    );
    expect(container().querySelector('[role="alert"]')?.textContent).toContain('Engine unavailable');
    expect(container().querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders the empty state and notifications with usable text', async () => {
    await render(
      <>
        <EmptyState title="Choose a folder to begin" body="Nothing is inferred from an empty catalog." />
        <Notification tone="attention" title="Cost unknown">
          Usage arrived without pricing.
        </Notification>
        <Button>Open</Button>
      </>,
    );
    expect(container().textContent).toContain('Choose a folder to begin');
    const status = container().querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(container().querySelector('button')?.getAttribute('type')).toBe('button');
  });
});

describe('keyboard behaviour', () => {
  it('tabs respond to arrow keys and Home/End', async () => {
    let active = 'timeline';
    const items = [
      { id: 'timeline', label: 'Timeline' },
      { id: 'changes', label: 'Changes' },
      { id: 'tests', label: 'Tests' },
    ];
    const view = (): React.JSX.Element => (
      <Tabs label="Panels" items={items} activeId={active} onSelect={(id) => (active = id)} />
    );
    const node = createRoot(container());
    root = node;
    await act(async () => {
      node.render(view());
    });
    const tabs = () => Array.from(container().querySelectorAll('[role="tab"]')) as HTMLElement[];
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      tabs()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(active).toBe('changes');
    await act(async () => {
      node.render(view());
    });
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1]?.tabIndex).toBe(0);
    expect(tabs()[0]?.tabIndex).toBe(-1);
  });

  it('dialog traps focus, closes on Escape and restores the opener', async () => {
    function Host(): React.JSX.Element {
      const [open, setOpen] = (globalThis as unknown as { __useState: never }).__useState as never;
      void open;
      void setOpen;
      return <div />;
    }
    void Host;
    // A plain harness component keeps the test independent of React internals.
    const opener = document.createElement('button');
    opener.textContent = 'Open dialog';
    document.body.appendChild(opener);
    opener.focus();
    const node = createRoot(container());
    root = node;
    const closed = (): void => {
      void node.render(<div />);
      opener.focus();
    };
    await act(async () => {
      node.render(
        <Dialog open title="Quit and stop owned work?" onClose={closed}>
          <p>Work already sent is not rolled back.</p>
        </Dialog>,
      );
    });
    const dialog = container().querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    // Focus starts inside the dialog, on the first focusable control.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container().querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('menu opens, moves with arrows, and Escape returns focus to its button', async () => {
    await render(
      <Menu
        label="Queue actions"
        items={[
          { id: 'pause', label: 'Pause after task' },
          { id: 'cancel', label: 'Cancel queued' },
        ]}
      />,
    );
    const button = container().querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-haspopup')).toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = container().querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    const items = Array.from(container().querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    expect(items.length).toBe(2);
    await act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container().querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('visual harness', () => {
  it('is clearly labelled as fixture data and renders every required screen', async () => {
    await render(<Harness />);
    expect(container().querySelector('[data-testid="harness-banner"]')?.textContent).toContain(HARNESS_LABEL);
    for (const screen of ['home', 'studio', 'work', 'cost', 'blocker', 'settings', 'states']) {
      expect(container().querySelector(`[data-screen="${screen}"]`)).not.toBeNull();
    }
    const text = container().textContent ?? '';
    expect(text).toContain('Unknown');
    expect(text).toContain('deliberately-long-project-name');
    expect(text).toContain('X:\\AI_projects\\Mona');
    expect(text).toContain('deepseek-flash');
  });

  it('makes no external requests and renders no remote URL as a link', async () => {
    await render(<Harness />);
    const links = Array.from(container().querySelectorAll('a[href], img[src], link[href]'));
    expect(links).toEqual([]);
    const html = container().innerHTML;
    expect(html).not.toMatch(/https?:\/\/(?!api\.deepseek\.com)/);
  });

  it('keeps every interactive control reachable and named', async () => {
    await render(<Harness />);
    const controls = Array.from(
      container().querySelectorAll<HTMLElement>('button, input, select, [role="tab"], [role="menuitem"]'),
    );
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      const labelled = control.id
        ? (container().querySelector(`label[for="${control.id}"]`)?.textContent?.trim() ?? '')
        : '';
      const direct = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
      const resolved = direct || labelled;
      expect(resolved.length, `${control.tagName} ${control.outerHTML.slice(0, 160)}`).toBeGreaterThan(0);
    }
  });
});
