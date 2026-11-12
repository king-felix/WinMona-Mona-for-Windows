// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogProject } from '../shared/catalog.js';
import type { TerminalEvent, TerminalSessionView } from '../shared/terminal.js';
import { TerminalDrawer } from './TerminalDrawer.js';

type Store = {
  events: TerminalEvent[];
  handlers: Array<(event: TerminalEvent) => void>;
  calls: string[];
  session: TerminalSessionView;
  created: Array<{ projectId: string; cols: number; rows: number }>;
};

function project(): CatalogProject {
  return {
    id: 'prj_alpha',
    label: 'alpha',
    canonicalPath: 'x:\\work\\alpha',
    repoKind: 'git',
    sharedRepoKey: null,
    branch: 'main',
    pinned: false,
    archived: false,
    revision: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    folderExists: true,
    markerId: 'prj_alpha',
    color: null,
    monogram: null,
    worktreeSiblingIds: [],
    binding: null,
  };
}

function session(overrides: Partial<TerminalSessionView> = {}): TerminalSessionView {
  return {
    id: 'term_1',
    projectId: 'prj_alpha',
    state: 'running',
    shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo',
    cwd: 'x:\\work\\alpha',
    cols: 80,
    rows: 24,
    pid: 4242,
    startedAt: '2026-11-12T00:00:00.000Z',
    exitedAt: null,
    exitCode: null,
    scrollbackBytes: 0,
    scrollbackTruncated: false,
    ...overrides,
  };
}

function install(store: Store): void {
  (window as unknown as { mona: unknown }).mona = {
    terminalCreate: async (input: { projectId: string; cols: number; rows: number }) => {
      store.created.push(input);
      store.calls.push(`create:${input.projectId}:${input.cols}x${input.rows}`);
      return { ok: true, data: store.session };
    },
    terminalInput: async (input: { sessionId: string; data: string }) => {
      store.calls.push(`input:${input.data}`);
      return { ok: true, data: { accepted: input.data.length } };
    },
    terminalResize: async (input: { cols: number; rows: number }) => {
      store.calls.push(`resize:${input.cols}x${input.rows}`);
      return { ok: true, data: { ...store.session, cols: input.cols, rows: input.rows } };
    },
    terminalKill: async (input: { sessionId: string }) => {
      store.calls.push(`kill:${input.sessionId}`);
      return { ok: true, data: { ...store.session, state: 'exited' as const, exitCode: 1 } };
    },
    terminalRefresh: async () => ({ ok: true, data: { session: store.session, data: '', truncated: false } }),
    terminalCopy: async (input: { data: string }) => {
      store.calls.push(`copy:${input.data.length}`);
      return { ok: true, data: { copied: input.data.length } };
    },
    onTerminalEvent: (handler: (event: TerminalEvent) => void) => {
      store.handlers.push(handler);
      return () => {
        const index = store.handlers.indexOf(handler);
        if (index >= 0) store.handlers.splice(index, 1);
      };
    },
  };
}

async function render(store: Store, open = true) {
  install(store);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TerminalDrawer project={project()} open={open} onClose={() => undefined} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { root, container };
}

function emit(store: Store, event: TerminalEvent): void {
  for (const handler of store.handlers) handler(event);
}

function store(): Store {
  return { events: [], handlers: [], calls: [], session: session(), created: [] };
}

describe('terminal drawer', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('starts one shell in the open project and renders its output', async () => {
    const state = store();
    const { root, container } = await render(state);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]?.projectId).toBe('prj_alpha');
    expect(state.created[0]?.cols).toBeGreaterThanOrEqual(20);
    expect(container.querySelector('.xterm')).toBeTruthy();
    await act(async () => {
      emit(state, { kind: 'data', sessionId: 'term_1', data: 'MONA_TERMINAL_OK\r\n', truncated: false });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.textContent).toContain('MONA_TERMINAL_OK');
    expect(container.querySelector('[data-testid="terminal-cwd"]')?.textContent).toContain('x:\\work\\alpha');
    await act(async () => root.unmount());
  });

  it('ignores output that belongs to another session', async () => {
    const state = store();
    const { root, container } = await render(state);
    await act(async () => {
      emit(state, { kind: 'data', sessionId: 'term_other', data: 'NOT_MINE\r\n', truncated: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).not.toContain('NOT_MINE');
    await act(async () => root.unmount());
  });

  it('shows the exit state and stops claiming the shell is running', async () => {
    const state = store();
    const { root, container } = await render(state);
    await act(async () => {
      emit(state, {
        kind: 'exit',
        session: session({ state: 'exited', exitCode: 3, exitedAt: '2026-11-12T00:01:00.000Z' }),
        reason: 'exit',
        detail: 'Exited with code 3.',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="terminal-exit"]')?.textContent).toContain('exit 3');
    expect(container.textContent).toContain('Exited with code 3.');
    await act(async () => root.unmount());
  });

  it('renders terminal output as inert text: no anchors, no iframes, no commands', async () => {
    const state = store();
    const { root, container } = await render(state);
    await act(async () => {
      emit(state, {
        kind: 'data',
        sessionId: 'term_1',
        data: 'see https://example.test/malicious\r\n',
        truncated: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.textContent).toContain('https://example.test/malicious');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    await act(async () => root.unmount());
  });

  it('ends the session only when the user asks', async () => {
    const state = store();
    const { root, container } = await render(state);
    const end = Array.from(container.querySelectorAll('button')).find(
      (node) => (node.textContent ?? '').trim() === 'End session',
    );
    if (!end) throw new Error('End session button missing');
    await act(async () => {
      end.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(state.calls).toContain('kill:term_1');
    // The exit event, not the kill reply, is what marks the session ended.
    await act(async () => {
      emit(state, {
        kind: 'exit',
        session: session({ state: 'exited', exitCode: 1, exitedAt: '2026-11-12T00:01:00.000Z' }),
        reason: 'killed',
        detail: 'The shell was terminated (code 1).',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('Session ended');
    await act(async () => root.unmount());
  });
});
