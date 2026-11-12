import type { IpcResult, PromptFavorite, UiStateView } from './catalog.js';

/**
 * Renderer-facing project memory vocabulary: local search, the prompt shelf,
 * portable bundles and the diagnostic preview. These are already-projected
 * values; the renderer never receives a raw database row, a filesystem handle
 * or a secret.
 */
export const MEMORY_CHANNELS = {
  search: 'mona:memory-search',
  reindex: 'mona:memory-reindex',
  promptSave: 'mona:memory-prompt-save',
  promptRemove: 'mona:memory-prompt-remove',
  promptPreview: 'mona:memory-prompt-preview',
  promptImport: 'mona:memory-prompt-import',
  promptExport: 'mona:memory-prompt-export',
  portableExport: 'mona:memory-portable-export',
  portableImport: 'mona:memory-portable-import',
  diagnosticsPreview: 'mona:memory-diagnostics-preview',
} as const;

export type MemorySearchMode = 'history' | 'files';

export type MemoryKindView =
  'project' | 'decision' | 'task' | 'evidence' | 'requirement' | 'problem' | 'attempt' | 'timeline' | 'file';

export type MemoryHitView = {
  docId: string;
  kind: MemoryKindView;
  refId: string;
  title: string;
  snippet: string;
  score: number;
  retention: 'ephemeral' | 'task' | 'evidence' | 'permanent';
  redacted: boolean;
  indexedAt: string;
};

export type MemorySearchView = {
  mode: MemorySearchMode;
  query: string;
  indexed: boolean;
  terms: string[];
  documents: number;
  hits: MemoryHitView[];
  truncated: boolean;
  /** File mode only: how much of the folder was scanned. */
  scannedFiles: number;
  scannedBytes: number;
  skipped: { secretPath: number; binary: number; oversize: number };
};

export type MemoryIndexedKindView = Exclude<MemoryKindView, 'file'>;

export type MemoryReindexView = {
  documents: number;
  terms: number;
  redacted: number;
  timelineIncluded: number;
  byKind: Record<MemoryIndexedKindView, number>;
  indexedAt: string;
};

export type PromptVariableView = {
  name: string;
  description: string;
  required: boolean;
  defaultValue: string | null;
};

export type PromptAcceptanceView = { id: string; text: string };

export type PromptDraftInput = {
  projectId: string;
  id?: string;
  label: string;
  description?: string;
  template: string;
  variables?: PromptVariableView[];
  acceptance?: PromptAcceptanceView[];
};

export type PromptPreviewView = {
  promptId: string;
  label: string;
  version: number;
  text: string;
  sha256: string;
  characters: number;
  missing: string[];
  undeclared: string[];
  unused: string[];
  unknownValues: string[];
  malformed: string[];
  acceptance: PromptAcceptanceView[];
  ready: boolean;
  notes: string[];
};

export type PromptShelfView = {
  projectId: string;
  prompts: PromptFavorite[];
};

export type PromptImportView = {
  imported: number;
  labels: string[];
  digest: string;
  exportedAt: string;
  /** Import stores text on the shelf; it never sends or executes it. */
  executed: false;
};

export type PromptExportView = {
  file: string;
  count: number;
  bytes: number;
  digest: string;
};

export type PortableExportKind = 'handoff' | 'resume' | 'settings' | 'diagnostics';
export type PortableImportKind = 'handoff' | 'resume' | 'settings';

export type PortableExportView = {
  kind: PortableExportKind;
  file: string;
  bytes: number;
  digest: string;
  detail: string;
  /** Files included only when the caller explicitly selected them. */
  includedFiles: string[];
  notTransferred: string[];
};

export type PortableImportView = {
  kind: 'mona.handoff' | 'mona.resume-packet' | 'settings';
  file: string;
  projectId: string | null;
  projectLabel: string | null;
  targetFolder: string | null;
  tasksImported: number;
  decisionsImported: number;
  evidenceChecked: number;
  missingFiles: string[];
  staleEvidence: Array<{ taskId: string; evidenceId: string; path: string; reason: string }>;
  reopenedTasks: Array<{ taskId: string; reason: string }>;
  restoredScopes: Array<{ scope: string; previousVersion: number; newVersion: number }>;
  requalified: boolean;
  autoExecuted: false;
  notTransferred: string[];
};

export type DiagnosticPreviewView = {
  generatedAt: string;
  redacted: true;
  text: string;
  bytes: number;
  sha256: string;
  sections: Array<{ name: string; lines: string[] }>;
  redaction: { rules: string[]; redactions: number };
  artifacts: {
    records: number;
    checked: number;
    truncated: boolean;
    missing: string[];
    digestMismatches: string[];
    verification: 'metadata' | 'digests' | 'unavailable';
  };
};

export type MemoryBridge = {
  memorySearch(input: {
    projectId: string;
    query: string;
    mode: MemorySearchMode;
    limit?: number;
  }): Promise<IpcResult<MemorySearchView>>;
  memoryReindex(projectId: string): Promise<IpcResult<MemoryReindexView>>;
  promptSave(input: PromptDraftInput): Promise<IpcResult<UiStateView>>;
  promptRemove(input: { projectId: string; promptId: string }): Promise<IpcResult<UiStateView>>;
  promptPreview(input: {
    projectId: string;
    promptId: string;
    values: Record<string, string>;
  }): Promise<IpcResult<PromptPreviewView>>;
  promptImport(projectId: string): Promise<IpcResult<PromptImportView>>;
  promptExport(projectId: string): Promise<IpcResult<PromptExportView>>;
  portableExport(input: {
    projectId: string;
    kind: PortableExportKind;
    includeFiles?: string[];
  }): Promise<IpcResult<PortableExportView>>;
  portableImport(input: {
    kind: PortableImportKind;
    replaceExisting?: boolean;
  }): Promise<IpcResult<PortableImportView>>;
  diagnosticsPreview(input: { verifyArtifacts?: boolean }): Promise<IpcResult<DiagnosticPreviewView>>;
};
