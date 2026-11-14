// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProject, EngineView, UiStateView } from '../shared/catalog.js';
import type { AppInfo } from '../shared/ipc.js';
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
  command?: (input: { projectId: string; sessionId: string; text: string; operationKey: string }) => Promise<unknown>;
};

const studioHandlers: EventHandler[] = [];

function installBridge(next: StudioView, overrides: BridgeOverrides = {}): void {
  (window as unknown as { mona: unknown }).mona = {
    studioGet: vi.fn(async () => ({ ok: true as const, data: next })),
    studioSubmit: vi.fn(async () => ({
      ok: true as const,
      data: {
        submissionId: 'sub_test',
        threadId: 'thr_current',
        turnId: 'turn_test',
        state: 'accepted',
        replayed: false,
        reconciliation: { required: false },
        prompt: 'sent',
        thread: null,
        run: { state: 'running', detail: 'accepted', turnId: 'turn_test', submission: null, startedAt: null },
      },
    })),
    commandDispatch: vi.fn(
      overrides.command ??
        (async () => ({
          ok: true as const,
          data: {
            projectId: 'prj_a',
            command: 'help',
            via: 'name',
            status: 'done',
            code: 'ok',
            detail: 'Opened the catalog.',
            at: '2026-11-12T00:00:00.000Z',
            operation: 'show-catalog',
            oldSessionId: null,
            newSessionId: null,
            threadCreated: false,
            providerRequest: false,
            replayed: false,
            ui: null,
          },
        })),
    ),
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const connectedEngine: EngineView = {
  state: 'connected',
  detail: 'Owned runtime is ready.',
  workspace: project.canonicalPath,
  pid: 42,
  endpoint: 'http://127.0.0.1:7801',
  compatibility: 'qualified',
};

const liveInfo = {
  localState: { available: true, schemaVersion: 1, detail: 'Local state is open.' },
  permission: { label: 'Full Access' },
  credentials: { detail: 'Codewhale manages credentials.' },
} as unknown as AppInfo;

function Interactive({
  initialDraft = '',
  onNewConversation = () => undefined,
  focusMode = false,
  onToggleFocus = () => undefined,
  fullScreen = false,
  onToggleFullScreen = () => undefined,
}: {
  initialDraft?: string;
  onNewConversation?: (input: { oldSessionId: string | null; newSessionId: string; ui: UiStateView }) => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  fullScreen?: boolean;
  onToggleFullScreen?: () => void;
}): React.JSX.Element {
  const [draft, setDraftValue] = useState(initialDraft);
  return (
    <StudioPanel
      info={liveInfo}
      project={project}
      engine={connectedEngine}
      spend={null}
      draft={draft}
      sessionId="ses_1"
      ui={null}
      busy={null}
      onDraft={setDraftValue}
      onOpenFolder={() => undefined}
      onStart={() => undefined}
      onStop={() => undefined}
      onNewSession={() => undefined}
      onLocate={() => undefined}
      onDraftSent={() => undefined}
      onNewConversation={onNewConversation}
      focusMode={focusMode}
      onToggleFocus={onToggleFocus}
      fullScreen={fullScreen}
      onToggleFullScreen={onToggleFullScreen}
      onSpendRefresh={() => undefined}
    />
  );
}

async function renderInteractive(
  next: StudioView,
  initialDraft = '',
  overrides: BridgeOverrides = {},
  onNewConversation?: (input: { oldSessionId: string | null; newSessionId: string; ui: UiStateView }) => void,
  chrome: {
    focusMode?: boolean;
    onToggleFocus?: () => void;
    fullScreen?: boolean;
    onToggleFullScreen?: () => void;
  } = {},
): Promise<void> {
  installBridge(next, overrides);
  await act(async () => {
    root.render(
      <Interactive
        initialDraft={initialDraft}
        onNewConversation={onNewConversation ?? (() => undefined)}
        {...(chrome.focusMode === undefined ? {} : { focusMode: chrome.focusMode })}
        {...(chrome.onToggleFocus === undefined ? {} : { onToggleFocus: chrome.onToggleFocus })}
        {...(chrome.fullScreen === undefined ? {} : { fullScreen: chrome.fullScreen })}
        {...(chrome.onToggleFullScreen === undefined ? {} : { onToggleFullScreen: chrome.onToggleFullScreen })}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function typeIntoComposer(value: string): Promise<HTMLTextAreaElement> {
  const textarea = container.querySelector('#draft') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return textarea;
}

async function press(textarea: HTMLTextAreaElement, key: string, options: KeyboardEventInit = {}): Promise<boolean> {
  let prevented = false;
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    textarea.dispatchEvent(event);
    prevented = event.defaultPrevented;
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return prevented;
}

function submitCalls(): number {
  return (window.mona.studioSubmit as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0;
}

describe('StudioPanel slash commands', () => {
  it('lists the engine catalogue with descriptions when a slash starts a line', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('/');
    const list = container.querySelector('[data-testid="slash-command-list"]');
    expect(list).not.toBeNull();
    const first = list?.querySelector('.command-row');
    expect(first?.textContent).toContain('/');
    expect(first?.textContent).toContain('terminal only');
    expect(first?.textContent).toMatch(/no request|provider request|cost unknown/);
    expect(container.querySelector('[data-testid="slash-command-count"]')?.textContent).toMatch(/commands\. ↑↓ choose/);

    await typeIntoComposer('/model');
    const model = container.querySelector('[data-testid="slash-command-model"]');
    expect(model?.textContent).toContain('/model');
    expect(model?.textContent).toContain('Switch or show the current model');
  });

  it('filters locally and offers an honest empty state', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('/zz');
    expect(container.querySelector('[data-testid="slash-command-count"]')?.textContent).toContain('No command matches');
  });

  it('fills the highlighted command with Tab', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/models');
    expect(container.querySelector('[data-testid="slash-command-models"]')).not.toBeNull();
    await press(textarea, 'Tab');
    const next = container.querySelector('#draft') as HTMLTextAreaElement;
    expect(next.value).toBe('/models');
    expect(container.querySelector('[data-testid="slash-command-list"]')).toBeNull();
  });

  it('closes on Escape without touching the draft or interrupting work', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/mo');
    const prevented = await press(textarea, 'Escape');
    expect(prevented).toBe(true);
    expect(container.querySelector('[data-testid="slash-command-list"]')).toBeNull();
    expect((container.querySelector('#draft') as HTMLTextAreaElement).value).toBe('/mo');
    expect(submitCalls()).toBe(0);
  });

  it('keeps plain Enter a newline while the list is open', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/mo');
    const prevented = await press(textarea, 'Enter');
    expect(prevented).toBe(false);
    expect(submitCalls()).toBe(0);
    expect(container.querySelector('[data-testid="slash-command-list"]')).not.toBeNull();
  });

  it('fills a command on pointer selection', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('/cost');
    const option = container.querySelector('[data-testid="slash-command-cost"]') as HTMLElement | null;
    expect(option).not.toBeNull();
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect((container.querySelector('#draft') as HTMLTextAreaElement).value).toBe('/cost');
  });

  it('refuses to send a terminal-only command and says what is left to do', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/model');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(submitCalls()).toBe(0);
    const text = document.body.textContent ?? '';
    expect(text.includes('/model is a Codewhale command')).toBe(true);
    expect(text.includes('Start it with \\/ to send it to the model as ordinary text')).toBe(true);
  });

  it('refuses an ambiguous prefix instead of executing a different command', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/mod');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(submitCalls()).toBe(0);
    const text = document.body.textContent ?? '';
    expect(text.includes('“/mod” is not a command. It could be: /mode, /model, /modeldb, /models')).toBe(true);
  });

  it('names the missing argument for a command that requires one', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/review');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(submitCalls()).toBe(0);
    expect((document.body.textContent ?? '').includes('It needs an argument: /review <target>')).toBe(true);
  });

  it('sends ordinary prose, paths and pasted code as text', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('Please review C:\\work\\mona and /usr/bin/env');
    expect(container.querySelector('[data-testid="slash-command-list"]')).toBeNull();
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(submitCalls()).toBe(1);
  });

  it('sends an escaped command literally and says the backslash was an escape', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('\\/new');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(submitCalls()).toBe(1);
    const call = (window.mona.studioSubmit as unknown as { mock: { calls: Array<[{ text: string }]> } }).mock
      .calls[0]?.[0];
    expect(call?.text).toBe('/new');
    expect((document.body.textContent ?? '').includes('the runtime received the command text literally')).toBe(true);
  });

  it('shows the whole catalog with cost class and route, including hidden rows', async () => {
    await renderInteractive(view(0));
    const catalog = container.querySelector('.command-catalog');
    expect(catalog?.textContent).toContain('109 engine commands');
    expect(container.querySelector('[data-testid="catalog-new"]')?.textContent).toContain('/new');
    expect(container.querySelector('[data-testid="catalog-compact"]')?.textContent).toContain('provider request');
    expect(container.querySelector('[data-testid="catalog-status"]')?.textContent).toContain('terminal only');
  });
});

describe('StudioPanel slash command semantics', () => {
  it('exposes a listbox to assistive technology without stealing plain Enter', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('/model');
    const textarea = container.querySelector('#draft') as HTMLTextAreaElement;
    expect(textarea.getAttribute('role')).toBe('combobox');
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe('slash-command-list');
    expect(textarea.getAttribute('aria-activedescendant')).toBe('slash-command-model');
    const list = container.querySelector('#slash-command-list');
    expect(list?.getAttribute('role')).toBe('listbox');
    const options = list?.querySelectorAll('[role="option"]') ?? [];
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="slash-command-count"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('replaces the whole token when the caret sits in the middle', async () => {
    await renderInteractive(view(0));
    const textarea = await typeIntoComposer('/models tail');
    await act(async () => {
      textarea.setSelectionRange(3, 3);
      textarea.dispatchEvent(new Event('select', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await press(textarea, 'Tab');
    expect((container.querySelector('#draft') as HTMLTextAreaElement).value).toBe('/models tail');
  });

  it('does not open the list inside a fenced code block line that is indented', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('    /new');
    expect(container.querySelector('[data-testid="slash-command-list"]')).toBeNull();
  });

  it('does not open on a second line that is a Windows path', async () => {
    await renderInteractive(view(0));
    await typeIntoComposer('Look here:\nC:\\work\\mona');
    expect(container.querySelector('[data-testid="slash-command-list"]')).toBeNull();
  });
});

describe('StudioPanel command dispatch', () => {
  const newUi = {
    currentProjectId: 'prj_a',
    projects: {
      prj_a: {
        sessions: [
          { sessionId: 'ses_new', updatedAt: '2026-11-12T00:00:00.000Z', text: '' },
          { sessionId: 'ses_1', updatedAt: '2026-11-12T00:00:00.000Z', text: '' },
        ],
      },
    },
    preferences: {},
    warning: null,
  } as unknown as UiStateView;

  function receipt(overrides: Record<string, unknown> = {}) {
    return {
      ok: true as const,
      data: {
        projectId: 'prj_a',
        command: 'new',
        via: 'name',
        status: 'done',
        code: 'ok',
        detail: 'Started a new conversation.',
        at: '2026-11-12T00:00:00.000Z',
        operation: 'new-conversation',
        oldSessionId: 'ses_1',
        newSessionId: 'ses_new',
        threadCreated: false,
        providerRequest: false,
        replayed: false,
        ui: newUi,
        ...overrides,
      },
    };
  }

  it('dispatches /new through the typed bridge and follows the recorded session', async () => {
    const seen: Array<{ text: string; operationKey: string }> = [];
    const rotations: Array<{ oldSessionId: string | null; newSessionId: string }> = [];
    await renderInteractive(
      view(0),
      '',
      {
        command: async (input) => {
          seen.push({ text: input.text, operationKey: input.operationKey });
          return receipt();
        },
      },
      (input) => rotations.push({ oldSessionId: input.oldSessionId, newSessionId: input.newSessionId }),
    );
    const textarea = await typeIntoComposer('/new');
    await press(textarea, 'Enter', { ctrlKey: true });

    expect(submitCalls()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe('/new');
    expect(seen[0]?.operationKey).toMatch(/^cmd_[A-Za-z0-9]+$/);
    expect(rotations).toEqual([{ oldSessionId: 'ses_1', newSessionId: 'ses_new' }]);
    expect(document.body.textContent ?? '').toContain('Started a new conversation.');
  });

  it('shows a refusal from the main process without changing sessions', async () => {
    const rotations: unknown[] = [];
    await renderInteractive(
      view(0),
      '',
      {
        command: async () =>
          receipt({
            status: 'refused',
            code: 'busy',
            operation: 'new-conversation',
            newSessionId: null,
            ui: null,
            detail: 'A turn is running in this session. Interrupt it or wait for it to finish.',
          }),
      },
      (input) => rotations.push(input),
    );
    const textarea = await typeIntoComposer('/new');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(rotations).toEqual([]);
    expect(document.body.textContent ?? '').toContain('Interrupt it or wait for it to finish');
  });

  it('reuses one operation key for the same command line instead of minting a second', async () => {
    const keys: string[] = [];
    let attempt = 0;
    await renderInteractive(view(0), '', {
      command: async (input) => {
        keys.push(input.operationKey);
        attempt += 1;
        // The first attempt fails at the bridge; the retry must reuse the key.
        return attempt === 1
          ? { ok: false as const, error: { code: 'internal', message: 'bridge hiccup' } }
          : receipt();
      },
    });
    const textarea = await typeIntoComposer('/new');
    await press(textarea, 'Enter', { ctrlKey: true });
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('opens the catalog drawer for /help', async () => {
    await renderInteractive(view(0), '', {
      command: async () =>
        receipt({
          command: 'help',
          operation: 'show-catalog',
          oldSessionId: null,
          newSessionId: null,
          ui: null,
          detail: 'Opened the catalog.',
        }),
    });
    const details = container.querySelector('.command-catalog') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const textarea = await typeIntoComposer('/help');
    await press(textarea, 'Enter', { ctrlKey: true });
    expect(details.open).toBe(true);
  });
});

describe('StudioPanel Focus and full screen', () => {
  it("reflects the window's observed fullscreen state and asks the shell to change it", async () => {
    const calls: string[] = [];
    await renderInteractive(view(0), '', {}, undefined, {
      focusMode: false,
      fullScreen: true,
      onToggleFocus: () => calls.push('focus'),
      onToggleFullScreen: () => calls.push('fullscreen'),
    });
    const focusButton = container.querySelector('[data-testid="studio-focus-toggle"]') as HTMLButtonElement;
    const fullButton = container.querySelector('[data-testid="studio-fullscreen-toggle"]') as HTMLButtonElement;
    expect(focusButton.textContent).toBe('Focus');
    expect(focusButton.getAttribute('aria-pressed')).toBe('false');
    expect(fullButton.textContent).toBe('Exit full screen');
    expect(fullButton.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      focusButton.click();
      fullButton.click();
    });
    expect(calls).toEqual(['focus', 'fullscreen']);
  });

  it('offers the exit in focus mode and reports the elapsed time from the record', async () => {
    const base = view(0);
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    await renderInteractive(
      {
        ...base,
        run: { ...base.run, state: 'running', detail: 'Working', startedAt, turnId: 'turn_1' },
      },
      '',
      {},
      undefined,
      { focusMode: true },
    );
    expect((container.querySelector('[data-testid="studio-focus-toggle"]') as HTMLElement).textContent).toBe(
      'Exit focus',
    );
    const elapsed = container.querySelector('[data-testid="studio-elapsed"]')?.textContent ?? '';
    expect(elapsed).toMatch(/Elapsed 1m 0\d/);
  });

  it('resizes the composer from the keyboard, clamped and remembered', async () => {
    await renderInteractive(view(0));
    const handle = container.querySelector('[data-testid="composer-resize"]') as HTMLElement;
    const textarea = container.querySelector('#draft') as HTMLTextAreaElement;
    const initial = Number.parseFloat(textarea.style.height);
    expect(initial).toBeGreaterThan(0);

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    const taller = Number.parseFloat((container.querySelector('#draft') as HTMLTextAreaElement).style.height);
    expect(taller).toBe(initial + 24);
    expect(localStorage.getItem('mona.composer.prj_a')).toBe(String(taller));

    for (let press_ = 0; press_ < 20; press_ += 1) {
      await act(async () => {
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
    }
    const shortest = Number.parseFloat((container.querySelector('#draft') as HTMLTextAreaElement).style.height);
    expect(shortest).toBe(72);
    expect(handle.getAttribute('aria-valuenow')).toBe('72');
  });

  it('closes the catalog with Escape before it would leave Focus', async () => {
    const exits: number[] = [];
    await renderInteractive(
      view(0),
      '',
      {
        command: async () => ({
          ok: true as const,
          data: {
            projectId: 'prj_a',
            command: 'help',
            via: 'name',
            status: 'done',
            code: 'ok',
            detail: 'Opened the catalog.',
            at: '2026-11-12T00:00:00.000Z',
            operation: 'show-catalog',
            oldSessionId: null,
            newSessionId: null,
            threadCreated: false,
            providerRequest: false,
            replayed: false,
            ui: null,
          },
        }),
      },
      undefined,
      { focusMode: true, onToggleFocus: () => exits.push(1) },
    );
    const textarea = await typeIntoComposer('/help');
    await press(textarea, 'Enter', { ctrlKey: true });
    const details = container.querySelector('.command-catalog') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(details.open).toBe(false);
    expect(exits).toEqual([]);
  });

  it('leaves Focus on Escape from the page but not while typing in the composer', async () => {
    const exits: number[] = [];
    await renderInteractive(view(0), '', {}, undefined, {
      focusMode: true,
      onToggleFocus: () => exits.push(1),
    });
    const textarea = container.querySelector('#draft') as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(exits).toEqual([]);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(exits).toEqual([1]);
  });
});
