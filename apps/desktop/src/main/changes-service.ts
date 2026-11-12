import { existsSync } from 'node:fs';
import path from 'node:path';
import { errorResult } from '@mona/contracts';
import type { ChangeService, ProjectStore } from '@mona/project-state';
import type {
  BaselineCaptureView,
  ChangeEntry,
  ChangesDiffView,
  ChangesView,
  ReceiptView,
  RepositoryView,
} from '../shared/changes.js';

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
export type ChangesResult<T> = Success<T> | Failure;

const MAX_RECEIPTS = 20;
const MAX_PATH_CHARS = 1_024;

/**
 * Project-relative path check for anything the renderer asks about. A change
 * path is data, but a path is also the one input that can reach outside the
 * workspace, so it is validated here and again by the Git service.
 */
export function isProjectRelativePath(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_PATH_CHARS) return false;
  // Control characters are checked by code point rather than a regex: a regex
  // that spells them out is exactly what `no-control-regex` exists to catch.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..')) return false;
  return true;
}

/** Real line counts from a unified diff body: `+++`/`---` headers are not lines. */
export function countDiffLines(text: string): { lines: number; added: number; removed: number } {
  const rows = text.split('\n');
  // A trailing newline terminates the last line; it does not add an empty one.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  let added = 0;
  let removed = 0;
  for (const line of rows) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { lines: rows.length, added, removed };
}

function toRepositoryView(status: Awaited<ReturnType<ChangeService['gitStatus']>>): RepositoryView {
  return {
    kind: status.kind,
    unavailableReason: status.unavailableReason,
    branch: status.branch,
    head: status.head,
    worktreeOf: status.worktreeOf,
    staged: status.staged.length,
    unstaged: status.unstaged.length,
    untracked: status.untracked.length,
    conflicts: status.conflicts,
  };
}

function toReceiptView(receipt: Awaited<ReturnType<ChangeService['testReceipts']>>[number]): ReceiptView {
  return {
    id: receipt.id,
    command: receipt.command,
    outcome: receipt.outcome,
    exitCode: receipt.exitCode,
    commit: receipt.commit,
    durationMs: receipt.durationMs,
    createdAt: receipt.createdAt,
    outputPath: receipt.outputPath,
    outputSha256: receipt.outputSha256,
    outputTruncated: receipt.outputTruncated,
  };
}

/**
 * The Changes surface: what the workspace actually holds right now, compared
 * with a baseline the user captured, plus the test receipts Mona recorded. It
 * owns no new state and no second snapshot engine — every answer comes from
 * `ChangeService`, and an unavailable answer stays visibly unavailable.
 */
export class ChangesService {
  constructor(
    private readonly store: ProjectStore,
    private readonly changes: ChangeService,
  ) {}

  async view(projectId: string): Promise<ChangesResult<ChangesView>> {
    const project = await this.store.getProject(projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const workspace = project.canonicalPath;
    const workspaceExists = existsSync(workspace);
    const bounds = this.changes.scanBounds;
    const scan = { maxFiles: bounds.maxFiles, excluded: [...bounds.excluded], previewBytes: bounds.previewBytes };
    const receipts = (await this.changes.testReceipts(projectId, MAX_RECEIPTS)).map(toReceiptView);

    if (!workspaceExists) {
      return {
        ok: true,
        data: {
          projectId,
          projectLabel: project.label,
          workspace,
          workspaceExists: false,
          repository: {
            kind: 'none',
            unavailableReason: 'the project folder is missing',
            branch: null,
            head: null,
            worktreeOf: null,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: [],
          },
          baseline: null,
          comparable: false,
          changes: [],
          counts: { added: 0, modified: 0, deleted: 0, toolRecorded: 0, unattributed: 0 },
          skipped: [],
          truncated: false,
          attributionNote:
            'The project folder is missing, so no change list can be read. This is not an empty diff; locate the folder to compare it again.',
          receipts,
          scan,
          unavailableReason: 'The project folder is missing. Changes cannot be read until it is located.',
        },
      };
    }

    try {
      const status = await this.changes.gitStatus(workspace);
      const report = await this.changes.diff({ projectId, workspace });
      const changes: ChangeEntry[] = report.changes.map((entry) => ({
        path: entry.path,
        change: entry.change,
        attribution: entry.attribution,
        bytes: entry.bytes,
        binary: entry.binary,
        preview: entry.preview,
      }));
      return {
        ok: true,
        data: {
          projectId,
          projectLabel: project.label,
          workspace,
          workspaceExists: true,
          repository: toRepositoryView(status),
          baseline: report.baseline
            ? {
                id: report.baseline.id,
                label: report.baseline.label,
                capturedAt: report.baseline.capturedAt,
                fileCount: report.baseline.fileCount,
                truncated: report.baseline.truncated,
              }
            : null,
          comparable: report.comparable,
          changes,
          counts: report.counts,
          skipped: report.skipped,
          truncated: report.truncated,
          attributionNote: report.attributionNote,
          receipts,
          scan,
          unavailableReason: null,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: errorResult(
          'internal',
          'The change list could not be read from the workspace.',
          true,
          error instanceof Error ? error.message.slice(0, 200) : undefined,
        ),
      };
    }
  }

  async diff(projectId: string, relPath: string): Promise<ChangesResult<ChangesDiffView>> {
    if (!isProjectRelativePath(relPath)) {
      return {
        ok: false,
        error: errorResult('invalid_request', 'A diff needs a project-relative path without parent traversal.'),
      };
    }
    const project = await this.store.getProject(projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const workspace = path.resolve(project.canonicalPath);
    const resolved = path.resolve(workspace, relPath);
    if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
      return { ok: false, error: errorResult('invalid_request', 'That path is outside the project workspace.') };
    }
    try {
      const text = await this.changes.diffText(workspace, relPath.replaceAll('\\', '/'));
      const counts = countDiffLines(text.text);
      return {
        ok: true,
        data: {
          path: relPath.replaceAll('\\', '/'),
          available: text.available,
          text: text.text,
          truncated: text.truncated,
          reason: text.reason,
          lines: counts.lines,
          addedLines: counts.added,
          removedLines: counts.removed,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: errorResult(
          'internal',
          'Git could not produce a diff for that path.',
          true,
          error instanceof Error ? error.message.slice(0, 200) : undefined,
        ),
      };
    }
  }

  /**
   * Capture a baseline on the user's explicit request. It writes only to Mona's
   * own project database (a path -> hash map); it never touches the workspace.
   */
  async capture(projectId: string, label?: string): Promise<ChangesResult<BaselineCaptureView>> {
    const project = await this.store.getProject(projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    if (!existsSync(project.canonicalPath)) {
      return {
        ok: false,
        error: errorResult('not_found', 'The project folder is missing, so a baseline cannot be captured.'),
      };
    }
    try {
      const baseline = await this.changes.captureBaseline({
        projectId,
        workspace: project.canonicalPath,
        label: label?.trim() || 'captured from Changes',
      });
      return {
        ok: true,
        data: {
          baselineId: baseline.id,
          label: baseline.label,
          fileCount: baseline.fileCount,
          truncated: baseline.truncated,
          capturedAt: baseline.capturedAt,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: errorResult(
          'internal',
          'The baseline could not be captured.',
          true,
          error instanceof Error ? error.message.slice(0, 200) : undefined,
        ),
      };
    }
  }
}
