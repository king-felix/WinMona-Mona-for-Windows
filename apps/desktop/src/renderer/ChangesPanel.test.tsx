// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProject } from '../shared/catalog.js';
import type { ChangesDiffView, ChangesView } from '../shared/changes.js';
import { ChangesPanel } from './ChangesPanel.js';

const project: CatalogProject = {
  id: 'prj_a',
  label: 'Changes Lab',
  canonicalPath: 'C:\\work\\changes-lab',
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

const scan = { maxFiles: 5_000, excluded: ['.git', 'node_modules'], previewBytes: 1_024 * 1_024 };

function view(overrides: Partial<ChangesView> = {}): ChangesView {
  return {
    projectId: 'prj_a',
    projectLabel: 'Changes Lab',
    workspace: 'C:\\work\\changes-lab',
    workspaceExists: true,
    repository: {
      kind: 'git',
      unavailableReason: null,
      branch: 'main',
      head: 'a'.repeat(40),
      worktreeOf: null,
      staged: 0,
      unstaged: 2,
      untracked: 0,
      conflicts: [],
    },
    baseline: {
      id: 'bsl_1',
      label: 'task start',
      capturedAt: '2026-11-12T10:00:00.000Z',
      fileCount: 3,
      truncated: false,
    },
    comparable: true,
    changes: [
      {
        path: 'src/app.ts',
        change: 'modified',
        attribution: 'tool_recorded',
        bytes: 120,
        binary: false,
        preview: 'text',
      },
    ],
    counts: { added: 0, modified: 1, deleted: 0, toolRecorded: 1, unattributed: 0 },
    skipped: [],
    truncated: false,
    attributionNote: 'Only paths recorded by tool events are labeled tool_recorded.',
    receipts: [
      {
        id: 'tst_1',
        command: 'npm test',
        outcome: 'passed',
        exitCode: 0,
        commit: 'b'.repeat(40),
        durationMs: 1_200,
        createdAt: '2026-11-12T10:05:00.000Z',
        outputPath: 'artifacts/test-1.txt',
        outputSha256: 'c'.repeat(64),
        outputTruncated: false,
      },
    ],
    scan,
    unavailableReason: null,
    ...overrides,
  };
}

const diff: ChangesDiffView = {
  path: 'src/app.ts',
  available: true,
  text: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  truncated: false,
  reason: null,
  lines: 4,
  addedLines: 1,
  removedLines: 1,
};

const calls: string[] = [];

function installBridge(next: ChangesView): void {
  const bridge = {
    changesView: vi.fn(async () => ({ ok: true as const, data: next })),
    changesDiff: vi.fn(async (input: { path: string }) => {
      calls.push(`diff:${input.path}`);
      return { ok: true as const, data: diff };
    }),
    changesCapture: vi.fn(async () => ({
      ok: true as const,
      data: { baselineId: 'bsl_2', label: 'captured from Changes', fileCount: 3, truncated: false, capturedAt: 'now' },
    })),
  };
  (window as unknown as { mona: unknown }).mona = bridge;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  calls.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(next: ChangesView): Promise<void> {
  installBridge(next);
  await act(async () => {
    root.render(<ChangesPanel project={project} />);
  });
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector(selector) as HTMLElement | null;
  expect(element, `missing ${selector}`).not.toBeNull();
  await act(async () => {
    element?.click();
  });
}

describe('ChangesPanel', () => {
  it('tells "no baseline" apart from "no changes"', async () => {
    await render(
      view({
        comparable: false,
        baseline: null,
        changes: [],
        counts: { added: 0, modified: 0, deleted: 0, toolRecorded: 0, unattributed: 0 },
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Changes unavailable');
    expect(text).not.toContain('No changes since the baseline');
  });

  it('renders a real empty change list as an empty list, not an error', async () => {
    await render(
      view({ changes: [], counts: { added: 0, modified: 0, deleted: 0, toolRecorded: 0, unattributed: 0 } }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('No changes since the baseline');
    expect(text).not.toContain('Changes unavailable');
  });

  it('shows changed paths with attribution and opens the real diff on request', async () => {
    await render(view());
    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('tool-recorded');
    await click('.change-row');
    expect(calls).toEqual(['diff:src/app.ts']);
    const text = container.textContent ?? '';
    expect(text).toContain('+new');
    expect(text).toContain('-old');
    expect(text).toContain('Test receipts');
    expect(text).toContain('npm test');
  });

  it('states that a diff is unavailable instead of showing an empty one', async () => {
    await render(view());
    const bridge = (window as unknown as { mona: { changesDiff: unknown } }).mona;
    bridge.changesDiff = vi.fn(async () => ({
      ok: true as const,
      data: {
        path: 'src/app.ts',
        available: false,
        text: '',
        truncated: false,
        reason: 'no textual baseline: the workspace is not a Git repository',
        lines: 0,
        addedLines: 0,
        removedLines: 0,
      },
    }));
    await click('.change-row');
    const text = container.textContent ?? '';
    expect(text).toContain('Diff unavailable');
    expect(text).toContain('not a Git repository');
  });

  it('reports a missing folder as unavailable', async () => {
    await render(
      view({
        workspaceExists: false,
        unavailableReason: 'The project folder is missing. Changes cannot be read until it is located.',
        comparable: false,
        baseline: null,
        changes: [],
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Changes unavailable');
    expect(text).toContain('project folder is missing');
  });
});
