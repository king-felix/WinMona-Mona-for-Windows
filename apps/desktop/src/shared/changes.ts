import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing change vocabulary. Everything here is a fact the main process
 * read from the workspace or the product database: a change list, a Git text
 * diff, a recorded test receipt. Nothing is inferred from agent claims, and an
 * unavailable diff is never presented as an empty one.
 */
export const CHANGES_CHANNELS = {
  view: 'mona:changes-view',
  diff: 'mona:changes-diff',
  capture: 'mona:changes-capture',
} as const;

export type ChangeKindView = 'added' | 'modified' | 'deleted';
export type ChangeAttribution = 'tool_recorded' | 'unattributed';
export type ChangePreview = 'text' | 'binary' | 'oversized' | 'missing';

export type ChangeEntry = {
  path: string;
  change: ChangeKindView;
  attribution: ChangeAttribution;
  bytes: number | null;
  binary: boolean | null;
  preview: ChangePreview;
};

export type BaselineView = {
  id: string;
  label: string;
  capturedAt: string;
  fileCount: number;
  truncated: boolean;
};

export type RepositoryView = {
  kind: 'none' | 'git' | 'worktree';
  /** Present when the workspace is not a usable repository. */
  unavailableReason: string | null;
  branch: string | null;
  head: string | null;
  worktreeOf: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: string[];
};

export type ReceiptView = {
  id: string;
  command: string;
  outcome: 'passed' | 'failed' | 'unknown';
  exitCode: number | null;
  commit: string | null;
  durationMs: number | null;
  createdAt: string;
  outputPath: string | null;
  outputSha256: string | null;
  outputTruncated: boolean;
};

export type ChangesView = {
  projectId: string;
  projectLabel: string;
  workspace: string;
  workspaceExists: boolean;
  /** Null only when the project itself could not be read. */
  repository: RepositoryView;
  baseline: BaselineView | null;
  /** False when there is no captured baseline: this is not an empty diff. */
  comparable: boolean;
  changes: ChangeEntry[];
  counts: { added: number; modified: number; deleted: number; toolRecorded: number; unattributed: number };
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
  attributionNote: string;
  receipts: ReceiptView[];
  /** Bounds this scan actually used, so the UI can state them. */
  scan: { maxFiles: number; excluded: string[]; previewBytes: number };
  /** Non-null when the view is degraded: a missing folder, a refused scan. */
  unavailableReason: string | null;
};

export type ChangesDiffView = {
  path: string;
  available: boolean;
  /** Unified diff text exactly as Git produced it; empty when unavailable. */
  text: string;
  truncated: boolean;
  reason: string | null;
  lines: number;
  /** Added/removed line counts counted from the diff body, not estimated. */
  addedLines: number;
  removedLines: number;
};

export type BaselineCaptureView = {
  baselineId: string;
  label: string;
  fileCount: number;
  truncated: boolean;
  capturedAt: string;
};

export type ChangesBridge = {
  changesView(input: { projectId: string }): Promise<IpcResult<ChangesView>>;
  changesDiff(input: { projectId: string; path: string }): Promise<IpcResult<ChangesDiffView>>;
  changesCapture(input: { projectId: string; label?: string }): Promise<IpcResult<BaselineCaptureView>>;
};
