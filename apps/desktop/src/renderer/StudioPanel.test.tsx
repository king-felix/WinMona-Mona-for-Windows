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

function view(itemCount: number): StudioView {
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
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function installBridge(next: StudioView): void {
  (window as unknown as { mona: unknown }).mona = {
    studioGet: vi.fn(async () => ({ ok: true as const, data: next })),
    onStudioEvent: () => () => undefined,
    projectSpend: vi.fn(async () => ({ ok: true as const, data: null })),
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(next: StudioView): Promise<void> {
  installBridge(next);
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
