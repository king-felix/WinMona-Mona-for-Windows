// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProject } from '../shared/catalog.js';
import type { StudioView } from '../shared/studio.js';
import { StudioPanel } from './StudioPanel.js';

const project: CatalogProject = {
  id: 'prj_a',
  label: 'Studio Lab',
  canonicalPath: 'C:\\work\\studio-lab',
  repoKind: 'git',
  sharedRepoKey: null,
  branch: 'main',
  pinned: false,
  archived: false,
  revision: 1,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  folderExists: true,
  markerId: 'prj_a',
  color: null,
  monogram: null,
  worktreeSiblingIds: [],
  binding: null,
};

function view(itemCount: number, overrides: Partial<StudioView> = {}): StudioView {
  return {
    projectId: 'prj_a',
    sessionId: 'ses_1',
    thread: null,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item_${index}`,
      seq: index + 1,
      turnId: null,
      kind: 'assistant' as const,
      title: `Event ${index}`,
      body: `Body ${index}`,
      status: 'completed',
      truncated: false,
      at: '2026-11-12T00:00:00.000Z',
    })),
    history: {
      total: itemCount,
      oldestSeq: itemCount > 0 ? 1 : null,
      newestSeq: itemCount > 0 ? itemCount : null,
      hasOlder: false,
      hasNewer: false,
    },
    run: {
      state: 'idle',
      detail: 'Ready.',
      turnId: null,
      submission: null,
      startedAt: null,
    },
    control: {
      pauseRequested: false,
      queueState: 'idle',
      lastOutcome: null,
      interrupt: null,
      blockedProblem: null,
    },
    pending: null,
    diagnostics: [],
    capabilities: {
      planMode: { status: 'supported', reason: null },
      approvalResponse: { status: 'supported', reason: null },
      attachments: { status: 'unsupported', reason: 'No runtime supports attachments here.' },
    },
    warning: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

type EventHandler = (event: unknown) => void;

type BridgeOverrides = {
  history?: (input: {
    projectId: string;
    sessionId: string;
    beforeSeq?: number | undefined;
    aroundSeq?: number | undefined;
    limit?: number | undefined;
  }) => Promise<unknown>;
  search?: (input: { projectId: string; sessionId: string; query: string }) => Promise<unknown>;
};

const studioHandlers: EventHandler[] = [];

function installBridge(next: StudioView, overrides: BridgeOverrides = {}): void {
  (window as unknown as { mona: unknown }).mona = {
    studioGet: vi.fn(async () => ({ ok: true as const, data: next })),
    studioHistory: vi.fn(
      overrides.history ??
        (async () => ({
          ok: true as const,
          data: { items: [], window: { total: 0, oldestSeq: null, newestSeq: null, hasOlder: false, hasNewer: false } },
        })),
    ),
    studioSearchHistory: vi.fn(
      overrides.search ??
        (async (input: { query: string }) => ({
          ok: true as const,
          data: { query: input.query, items: [], total: 0 },
        })),
    ),
    onStudioEvent: (handler: EventHandler) => {
      studioHandlers.push(handler);
      return () => {
        const index = studioHandlers.indexOf(handler);
        if (index >= 0) studioHandlers.splice(index, 1);
      };
    },
    projectSpend: vi.fn(async () => ({ ok: true as const, data: null })),
  };
}

beforeEach(() => {
  studioHandlers.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(next: StudioView, overrides: BridgeOverrides = {}): Promise<void> {
  installBridge(next, overrides);
  await act(async () => {
    root.render(
      <StudioPanel
        info={null}
        project={project}
        engine={null}
        spend={null}
        draft=""
        sessionId="ses_1"
        ui={null}
        busy={null}
        onDraft={() => undefined}
        onOpenFolder={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
        onNewSession={() => undefined}
        onLocate={() => undefined}
        onDraftSent={() => undefined}
        onSpendRefresh={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function renderedItems(): number {
  return container.querySelectorAll('.timeline-item').length;
}

describe('StudioPanel render window', () => {
  it('renders the newest page of a long history, not every loaded row', async () => {
    await render(view(300));
    expect(renderedItems()).toBe(120);
    const earlier = container.querySelector('[data-testid="timeline-earlier"]');
    expect(earlier).not.toBeNull();
    expect(earlier?.textContent).toContain('Showing the newest 120 of 300 loaded items');
    // The newest rows are the ones rendered.
    expect(container.textContent).toContain('Body 299');
    expect(container.textContent).not.toContain('Body 0');
  });

  it('reveals an older page on request, keeping every item reachable', async () => {
    await render(view(300));
    const button = container.querySelector('[data-testid="timeline-earlier"] button') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(renderedItems()).toBe(240);
    await act(async () => {
      (container.querySelector('[data-testid="timeline-earlier"] button') as HTMLButtonElement | null)?.click();
    });
    expect(renderedItems()).toBe(300);
    expect(container.querySelector('[data-testid="timeline-earlier"]')).toBeNull();
  });

  it('renders a short history in full with no earlier-items control', async () => {
    await render(view(12));
    expect(renderedItems()).toBe(12);
    expect(container.querySelector('[data-testid="timeline-earlier"]')).toBeNull();
  });
});

function itemAt(
  seq: number,
  label = 'Body',
): {
  id: string;
  seq: number;
  turnId: string | null;
  kind: 'assistant';
  title: string;
  body: string;
  status: string;
  truncated: boolean;
  at: string;
} {
  return {
    id: `item_${seq}`,
    seq,
    turnId: null,
    kind: 'assistant',
    title: `Event ${seq}`,
    body: `${label} ${seq}`,
    status: 'completed',
    truncated: false,
    at: '2026-11-12T00:00:00.000Z',
  };
}

function page(items: ReturnType<typeof itemAt>[], window: Partial<StudioView['history']> = {}) {
  return {
    ok: true as const,
    data: {
      items,
      window: {
        total: 1_200,
        oldestSeq: items[0]?.seq ?? null,
        newestSeq: items[items.length - 1]?.seq ?? null,
        hasOlder: true,
        hasNewer: true,
        ...window,
      },
    },
  };
}

describe('StudioPanel stored history', () => {
  it('loads a stored older page from the bridge and keeps every row reachable', async () => {
    const newest = Array.from({ length: 500 }, (_, index) => itemAt(701 + index, 'Newest'));
    const older = Array.from({ length: 500 }, (_, index) => itemAt(201 + index, 'Older'));
    const historyCalls: Array<{ beforeSeq?: number | undefined; aroundSeq?: number | undefined }> = [];
    const base = view(0, {
      items: newest,
      history: { total: 1_200, oldestSeq: 701, newestSeq: 1_200, hasOlder: true, hasNewer: false },
    });
    await render(base, {
      history: async (input) => {
        historyCalls.push({ beforeSeq: input.beforeSeq, aroundSeq: input.aroundSeq });
        return page(older, { hasOlder: true, hasNewer: true });
      },
    });

    const controls = container.querySelector('[data-testid="timeline-older"]');
    expect(controls?.textContent).toContain('Load earlier stored items');
    const button = controls?.querySelector('button') as HTMLButtonElement | null;
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(historyCalls).toEqual([{ beforeSeq: 701, aroundSeq: undefined }]);
    expect(container.querySelector('[data-testid="history-window"]')?.textContent).toContain('1,200 stored');
    // The older page is now adjacent to the newest one the reader had.
    const shown = [...container.querySelectorAll('.timeline-item')].slice(0, 3).map((node) => node.textContent);
    expect(shown.some((text) => text?.includes('Older 499'))).toBe(false);
    expect(container.textContent).toContain('Newest 1200');
  });

  it('preserves the scroll anchor when an older page is prepended', async () => {
    const newest = Array.from({ length: 500 }, (_, index) => itemAt(701 + index, 'Newest'));
    const older = Array.from({ length: 500 }, (_, index) => itemAt(201 + index, 'Older'));
    const base = view(0, {
      items: newest,
      history: { total: 1_200, oldestSeq: 701, newestSeq: 1_200, hasOlder: true, hasNewer: false },
    });
    let height = 1_000;
    await render(base, {
      history: async () => {
        // The page is prepended between the measurement and the restore, which
        // is exactly when a naive implementation loses the reader's place.
        height = 1_600;
        return page(older);
      },
    });

    const node = container.querySelector('.timeline') as HTMLElement;
    let scrollTop = 320;
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(node, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    const button = container.querySelector('[data-testid="timeline-older"] button') as HTMLButtonElement | null;
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // The reader keeps their place: the added height appears above the anchor.
    expect(scrollTop).toBe(320 + (1_600 - 1_000));
  });

  it('searches stored history and opens the window around a hit', async () => {
    const newest = Array.from({ length: 10 }, (_, index) => itemAt(691 + index, 'Newest'));
    const around = [itemAt(116), itemAt(117, 'Found'), itemAt(118)];
    const base = view(0, {
      items: newest,
      history: { total: 1_200, oldestSeq: 691, newestSeq: 700, hasOlder: true, hasNewer: false },
    });
    const historyCalls: Array<{ aroundSeq?: number | undefined }> = [];
    await render(base, {
      search: async (input) => ({
        ok: true as const,
        data: { query: input.query, items: [itemAt(117, 'Found')], total: 1 },
      }),
      history: async (input) => {
        historyCalls.push({ aroundSeq: input.aroundSeq });
        return page(around, { hasOlder: true, hasNewer: true });
      },
    });

    const input = container.querySelector('#timeline-search') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, 'Found 117');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const searchButton = container.querySelector('[data-testid="history-search"]') as HTMLButtonElement | null;
    await act(async () => {
      searchButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="history-results"]')?.textContent).toContain('1 stored match');

    const hit = container.querySelector('[data-testid="history-hit-117"]') as HTMLButtonElement | null;
    expect(hit).not.toBeNull();
    await act(async () => {
      hit?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(historyCalls).toEqual([{ aroundSeq: 117 }]);
    const highlighted = container.querySelector('.timeline-item.highlighted');
    expect(highlighted?.textContent).toContain('Found 117');
  });

  it('ignores an item pushed for another engine thread', async () => {
    const base = view(2, {
      items: [itemAt(1, 'Mine'), itemAt(2, 'Mine')],
      thread: {
        threadId: 'thr_current',
        workspace: 'C:\\work\\studio-lab',
        provider: 'deepseek',
        model: 'deepseek-flash',
        mode: 'agent',
        permissionPosture: 'full_access',
        allowShell: true,
        trustMode: true,
        autoApprove: true,
        observedAt: '2026-11-12T00:00:00.000Z',
      },
      history: { total: 2, oldestSeq: 1, newestSeq: 2, hasOlder: false, hasNewer: false },
    });
    await render(base);
    await act(async () => {
      for (const handler of studioHandlers) {
        handler({ type: 'item', projectId: 'prj_a', threadId: 'thr_other', item: itemAt(3, 'Other') });
        handler({ type: 'delta', projectId: 'prj_a', threadId: 'thr_other', itemId: 'item_3', text: 'X', seq: 3 });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.textContent).not.toContain('Other 3');
    expect(renderedItems()).toBe(2);
  });

  it('offers a deliberate jump when newer stored rows are outside the window', async () => {
    const base = view(2, {
      items: [itemAt(1), itemAt(2)],
      history: { total: 1_200, oldestSeq: 1, newestSeq: 2, hasOlder: false, hasNewer: true },
    });
    await render(base);
    const jump = container.querySelector('[data-testid="timeline-jump"]');
    expect(jump?.textContent).toContain('Newer stored rows are outside the loaded window');
  });

  it('shows the beginning of the conversation once no older rows remain', async () => {
    await render(view(5, { history: { total: 5, oldestSeq: 1, newestSeq: 5, hasOlder: false, hasNewer: false } }));
    expect(container.querySelector('[data-testid="timeline-beginning"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-older"]')).toBeNull();
  });
});
