// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProject, PromptFavorite, UiStateView } from '../shared/catalog.js';
import type { DiagnosticPreviewView, MemorySearchView, PortableExportView } from '../shared/memory.js';
import { MemoryPanel } from './MemoryPanel.js';

const project: CatalogProject = {
  id: 'prj_a',
  label: 'Memory Lab',
  canonicalPath: 'C:\\work\\memory-lab',
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

const prompt: PromptFavorite = {
  id: 'pfv_1',
  label: 'Review gate',
  text: 'Review {{file}} against {{gate}}.',
  createdAt: '2026-11-12T00:00:00.000Z',
  description: 'Focused review',
  template: 'Review {{file}} against {{gate}}.',
  variables: [
    { name: 'file', description: 'Path', required: true, defaultValue: null },
    { name: 'gate', description: 'Gate', required: true, defaultValue: 'release' },
  ],
  acceptance: [{ id: 'acc_1', text: 'The gate is explained' }],
  version: 2,
  updatedAt: '2026-11-12T00:00:00.000Z',
  history: [],
};

const searchView: MemorySearchView = {
  mode: 'history',
  query: 'zephyr',
  indexed: true,
  terms: ['zephyr'],
  documents: 3,
  hits: [
    {
      docId: 'mem_1',
      kind: 'decision',
      refId: 'dec_1',
      title: 'Zephyr decision',
      snippet: 'Keep the zephyr gate local.',
      score: 3,
      retention: 'permanent',
      redacted: false,
      indexedAt: '2026-11-12T00:00:00.000Z',
    },
  ],
  truncated: false,
  scannedFiles: 0,
  scannedBytes: 0,
  skipped: { secretPath: 0, binary: 0, oversize: 0 },
};

const previewView = {
  promptId: 'pfv_1',
  label: 'Review gate',
  version: 2,
  text: 'Review src/app.ts against release.\n\n## Acceptance criteria\n- [ ] The gate is explained\n',
  sha256: 'a'.repeat(64),
  characters: 84,
  missing: [],
  undeclared: [],
  unused: [],
  unknownValues: [],
  malformed: [],
  acceptance: [{ id: 'acc_1', text: 'The gate is explained' }],
  ready: true,
  notes: ['This is the exact text inserted into the composer. Nothing is sent until Submit.'],
};

const diagnostics: DiagnosticPreviewView = {
  generatedAt: '2026-11-12T00:00:00.000Z',
  redacted: true,
  text: '# Mona diagnostics\nC:\\Users\\[user]',
  bytes: 36,
  sha256: 'b'.repeat(64),
  sections: [{ name: 'Local state', lines: ['schema: 7'] }],
  redaction: { rules: ['user-home-path'], redactions: 1 },
  artifacts: { records: 0, checked: 0, truncated: false, missing: [], digestMismatches: [], verification: 'metadata' },
};

const exportView: PortableExportView = {
  kind: 'handoff',
  file: 'C:\\out\\handoff.json',
  bytes: 1024,
  digest: 'c'.repeat(64),
  detail: '1 tasks, 1 decisions, 0 selected files.',
  includedFiles: [],
  notTransferred: ['Engine-owned thread and turn history'],
};

function view(prompts: PromptFavorite[]): UiStateView {
  return {
    currentProjectId: 'prj_a',
    projects: {
      prj_a: {
        view: 'memory',
        layout: 'standard',
        currentSessionId: 'ses_1',
        sessions: [],
        favorites: prompts,
        lastOpenedAt: null,
        lastSeenAt: null,
      },
    },
    preferences: {
      notificationsEnabled: true,
      quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: 'UTC' },
      density: 'comfortable',
      firstCloseNotified: false,
    },
    warning: null,
  };
}

const calls: string[] = [];

function installBridge(): void {
  const bridge = {
    memorySearch: vi.fn(async () => ({ ok: true, data: searchView })),
    memoryReindex: vi.fn(async () => ({
      ok: true,
      data: { documents: 3, terms: 9, redacted: 1, timelineIncluded: 0, byKind: {}, indexedAt: 'now' },
    })),
    promptPreview: vi.fn(async (input: { promptId: string; values: Record<string, string> }) => {
      calls.push(`preview:${Object.keys(input.values).join(',')}`);
      return { ok: true, data: previewView };
    }),
    promptSave: vi.fn(async () => ({ ok: true, data: view([prompt]) })),
    promptRemove: vi.fn(async () => ({ ok: true, data: view([]) })),
    promptImport: vi.fn(async () => ({
      ok: true,
      data: { imported: 1, labels: ['Imported'], digest: 'd'.repeat(64), exportedAt: 'now', executed: false },
    })),
    promptExport: vi.fn(async () => ({
      ok: true,
      data: { file: 'C:\\out\\prompts.json', count: 1, bytes: 100, digest: 'e'.repeat(64) },
    })),
    portableExport: vi.fn(async (input: { kind: string }) => {
      calls.push(`export:${input.kind}`);
      return { ok: true, data: exportView };
    }),
    portableImport: vi.fn(async () => ({ ok: true, data: null })),
    diagnosticsPreview: vi.fn(async () => ({ ok: true, data: diagnostics })),
    getUiState: vi.fn(async () => ({ ok: true, data: view([prompt]) })),
    saveDraft: vi.fn(async () => ({ ok: true, data: view([prompt]) })),
    setProjectView: vi.fn(async () => ({ ok: true, data: view([prompt]) })),
  };
  (window as unknown as { mona: unknown }).mona = bridge;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  installBridge();
  calls.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onUsePrompt: (text: string) => void = () => undefined): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryPanel
        project={project}
        prompts={[prompt]}
        onUsePrompt={onUsePrompt}
        onPromptsChanged={() => undefined}
        onCatalogChanged={() => undefined}
      />,
    );
  });
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector(selector) as HTMLElement | null;
  if (!element) throw new Error(`missing ${selector}`);
  await act(async () => {
    element.click();
  });
}

describe('MemoryPanel', () => {
  it('previews the exact prompt and inserts it only on request', async () => {
    const inserted: string[] = [];
    await render((text) => inserted.push(text));
    const buttons = [...container.querySelectorAll('button')];
    const previewButton = buttons.find((button) => button.textContent === 'Preview');
    expect(previewButton).toBeDefined();
    await act(async () => {
      previewButton?.click();
    });
    const previewText = container.querySelector('.memory-text')?.textContent ?? '';
    expect(previewText).toContain('Review src/app.ts against release.');
    expect(previewText).toContain('## Acceptance criteria');
    expect(container.textContent).toContain('ready');
    expect(inserted).toEqual([]);
    await click('[data-testid="prompt-use"]');
    expect(inserted).toEqual([previewView.text]);
  });

  it('runs a local search and shows the hit with its kind', async () => {
    await render();
    const input = container.querySelector('[data-testid="memory-search-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'zephyr');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[data-testid="memory-search-run"]');
    expect(container.textContent).toContain('Zephyr decision');
    expect(container.textContent).toContain('decision');
  });

  it('exports a handoff and previews diagnostics with a redacted path', async () => {
    await render();
    await click('[data-testid="export-handoff"]');
    expect(calls).toContain('export:handoff');
    expect(container.textContent).toContain('C:\\out\\handoff.json');
    await click('[data-testid="diagnostics-preview"]');
    expect(container.textContent).toContain('C:\\Users\\[user]');
    expect(container.textContent).toContain('redaction(s)');
  });
});
