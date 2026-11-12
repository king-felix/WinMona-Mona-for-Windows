import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { ArtifactStore } from './artifacts.js';
import { stateError } from './errors.js';
import { GitService, type GitStatus, type RestorePreview, type RestoreResult } from './git.js';
import type { ProjectStore } from './store.js';

/**
 * Change receipts, test receipts and restore evidence (spec 5.5, 7, 11).
 *
 * A baseline is a map of project-relative path -> content hash captured at a
 * boundary. A change list is a comparison against that baseline; it never
 * claims that every changed file was written by an agent. Text diffs come from
 * Git when a repository exists; otherwise the report says plainly that no
 * textual baseline is stored instead of showing an empty diff.
 */

export type ChangeKind = 'added' | 'modified' | 'deleted';
export type Attribution = 'tool_recorded' | 'unattributed';

export type FileSnapshot = { path: string; sha256: string; bytes: number; binary: boolean };

export type Baseline = {
  id: string;
  projectId: string;
  taskId: string | null;
  label: string;
  fileCount: number;
  truncated: boolean;
  capturedAt: string;
  entries: FileSnapshot[];
};

export type FileChange = {
  path: string;
  change: ChangeKind;
  attribution: Attribution;
  bytes: number | null;
  binary: boolean | null;
  preview: 'text' | 'binary' | 'oversized' | 'missing';
};

export type ChangeReport = {
  projectId: string;
  /** False when there is no captured baseline; the report is not an empty diff. */
  comparable: boolean;
  baseline: Pick<Baseline, 'id' | 'label' | 'capturedAt' | 'fileCount' | 'truncated'> | null;
  changes: FileChange[];
  counts: { added: number; modified: number; deleted: number; toolRecorded: number; unattributed: number };
  skipped: Array<{ path: string; reason: string }>;
  attributionNote: string;
  truncated: boolean;
};

export type TextDiff = {
  path: string;
  available: boolean;
  text: string;
  truncated: boolean;
  reason: string | null;
};

export type TestReceiptInput = {
  projectId: string;
  taskId?: string | null;
  command: string;
  exitCode: number | null;
  outcome: 'passed' | 'failed' | 'unknown';
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  commit?: string | null;
  output?: string | null;
};

export type TestReceipt = {
  id: string;
  projectId: string;
  taskId: string | null;
  command: string;
  exitCode: number | null;
  outcome: 'passed' | 'failed' | 'unknown';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  commit: string | null;
  outputPath: string | null;
  outputSha256: string | null;
  outputBytes: number | null;
  outputTruncated: boolean;
  createdAt: string;
};

export type ChangeServiceOptions = {
  now?: () => Date;
  git?: GitService;
  artifacts?: ArtifactStore;
  excluded?: readonly string[];
  maxFiles?: number;
  previewBytes?: number;
};

export type CaptureInput = {
  projectId: string;
  workspace: string;
  taskId?: string | null;
  label: string;
};

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.mona', 'dist', 'out', '.vite', 'coverage'];
const DEFAULT_MAX_FILES = 5_000;
const OVERSIZE_PREVIEW = 1_024 * 1_024;
const MAX_RECEIPT_OUTPUT = 256 * 1_024;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8_000);
  for (const byte of window) if (byte === 0) return true;
  return false;
}

function within(root: string, absolute: string): boolean {
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

/**
 * Fresh-revision write. A caller that saw hash H may write only while the file
 * is still H. `expectedSha256: null` means the file must not exist yet.
 */
export function writeFileFresh(input: { file: string; content: string | Buffer; expectedSha256: string | null }): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const absolute = resolve(input.file);
  const exists = existsSync(absolute);
  const buffer = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  if (input.expectedSha256 === null) {
    if (exists) {
      throw stateError('conflict', `${absolute} already exists; this write expected to create it`);
    }
  } else {
    if (!exists) {
      throw stateError('conflict', `${absolute} no longer exists; expected revision ${input.expectedSha256}`);
    }
    const current = sha256(readFileSync(absolute));
    if (current !== input.expectedSha256) {
      throw stateError(
        'conflict',
        `${absolute} changed on disk since it was read`,
        `expected ${input.expectedSha256}, found ${current}`,
      );
    }
  }
  const temp = `${absolute}.${randomUUID().replaceAll('-', '')}.tmp`;
  mkdirSync(dirname(absolute), { recursive: true });
  const descriptor = openSync(temp, 'wx');
  try {
    writeSync(descriptor, buffer);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temp, absolute);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file may already be gone */
    }
    throw error;
  }
  return { path: absolute, sha256: sha256(buffer), bytes: buffer.byteLength };
}

export class ChangeService {
  private readonly now: () => Date;
  private readonly git: GitService;
  private readonly artifacts: ArtifactStore | null;
  private readonly excluded: readonly string[];
  private readonly maxFiles: number;
  private readonly previewBytes: number;

  constructor(
    private readonly store: ProjectStore,
    options: ChangeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.git = options.git ?? new GitService();
    this.artifacts = options.artifacts ?? null;
    this.excluded = options.excluded ?? DEFAULT_EXCLUDES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.previewBytes = options.previewBytes ?? OVERSIZE_PREVIEW;
  }

  /**
   * The bounds this instance actually scans with. A surface that reports a
   * change list has to state these, because "no changes" means something
   * different when the scan stopped at a file cap or skipped a tree.
   */
  get scanBounds(): { excluded: readonly string[]; maxFiles: number; previewBytes: number } {
    return { excluded: this.excluded, maxFiles: this.maxFiles, previewBytes: this.previewBytes };
  }

  /** Capture the current workspace as a baseline. Excluded trees are recorded. */
  async captureBaseline(input: CaptureInput): Promise<Baseline> {
    const label = input.label.trim();
    if (!label) throw stateError('invalid_request', 'a baseline label is required');
    const workspace = resolve(input.workspace);
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw stateError('not_found', `workspace ${workspace} does not exist`);
    }
    const files: FileSnapshot[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let truncated = false;
    const walk = (directory: string): void => {
      if (truncated) return;
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        if (truncated) break;
        const absolute = resolve(directory, entry.name);
        if (!within(workspace, absolute)) {
          skipped.push({ path: relative(workspace, absolute), reason: 'escapes the workspace' });
          continue;
        }
        const rel = relative(workspace, absolute).split(sep).join('/');
        if (this.excluded.includes(entry.name) && entry.isDirectory()) {
          skipped.push({ path: rel, reason: 'excluded directory' });
          continue;
        }
        if (entry.isSymbolicLink()) {
          skipped.push({ path: rel, reason: 'symbolic link is not followed' });
          continue;
        }
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ path: rel, reason: 'not a regular file' });
          continue;
        }
        if (files.length >= this.maxFiles) {
          truncated = true;
          break;
        }
        const buffer = readFileSync(absolute);
        files.push({ path: rel, sha256: sha256(buffer), bytes: buffer.byteLength, binary: isBinary(buffer) });
      }
    };
    walk(workspace);

    return await this.store.write((tx) => {
      const id = `bsl_${randomUUID().replaceAll('-', '')}`;
      const capturedAt = tx.now();
      tx.db
        .prepare(
          `INSERT INTO change_baselines(id, project_id, task_id, label, entries_json, file_count, truncated, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.taskId ?? null,
          label,
          JSON.stringify(files),
          files.length,
          truncated ? 1 : 0,
          capturedAt,
        );
      tx.bumpRevision();
      return {
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        label,
        fileCount: files.length,
        truncated,
        capturedAt,
        entries: files,
      };
    });
  }

  async baselines(projectId: string, options: { taskId?: string | null } = {}): Promise<Baseline[]> {
    return await this.store.read((db) => {
      const rows = options.taskId
        ? (db
            .prepare(
              'SELECT * FROM change_baselines WHERE project_id = ? AND task_id = ? ORDER BY captured_at DESC, id DESC',
            )
            .all(projectId, options.taskId) as Array<Record<string, unknown>>)
        : (db
            .prepare('SELECT * FROM change_baselines WHERE project_id = ? ORDER BY captured_at DESC, id DESC')
            .all(projectId) as Array<Record<string, unknown>>);
      return rows.map((row) => this.rowToBaseline(row));
    });
  }

  /**
   * Compare the workspace to a baseline. `touchedPaths` are the paths recorded
   * by tool events; a change outside that set is reported as unattributed
   * workspace movement, not as agent authorship.
   */
  async diff(input: {
    projectId: string;
    workspace: string;
    baselineId?: string;
    taskId?: string | null;
    touchedPaths?: readonly string[];
    gitStatus?: GitStatus;
  }): Promise<ChangeReport> {
    const baselines = await this.baselines(input.projectId, input.taskId ? { taskId: input.taskId } : {});
    const baseline = input.baselineId
      ? ((await this.baselines(input.projectId)).find((entry) => entry.id === input.baselineId) ?? null)
      : (baselines[0] ?? null);
    const current: FileSnapshot[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let truncated = false;
    const workspace = resolve(input.workspace);
    if (existsSync(workspace)) {
      const walk = (directory: string): void => {
        if (truncated) return;
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (truncated) break;
          const absolute = resolve(directory, entry.name);
          if (!within(workspace, absolute)) continue;
          const rel = relative(workspace, absolute).split(sep).join('/');
          if (this.excluded.includes(entry.name) && entry.isDirectory()) continue;
          if (entry.isSymbolicLink()) {
            skipped.push({ path: rel, reason: 'symbolic link is not followed' });
            continue;
          }
          if (entry.isDirectory()) {
            walk(absolute);
            continue;
          }
          if (!entry.isFile()) continue;
          if (current.length >= this.maxFiles) {
            truncated = true;
            break;
          }
          const buffer = readFileSync(absolute);
          current.push({ path: rel, sha256: sha256(buffer), bytes: buffer.byteLength, binary: isBinary(buffer) });
        }
      };
      walk(workspace);
    }
    const before = new Map((baseline?.entries ?? []).map((entry) => [entry.path, entry] as const));
    const after = new Map(current.map((entry) => [entry.path, entry] as const));
    const touched = new Set((input.touchedPaths ?? []).map((value) => value.replaceAll('\\', '/')));
    const changes: FileChange[] = [];
    const push = (path: string, change: ChangeKind): void => {
      const entry = after.get(path) ?? before.get(path) ?? null;
      const reason: FileChange['preview'] =
        entry === null ? 'missing' : entry.binary ? 'binary' : entry.bytes > this.previewBytes ? 'oversized' : 'text';
      changes.push({
        path,
        change,
        attribution: touched.has(path) ? 'tool_recorded' : 'unattributed',
        bytes: entry?.bytes ?? null,
        binary: entry?.binary ?? null,
        preview: reason,
      });
    };
    for (const [path, entry] of after) {
      if (!baseline) break;
      const prior = before.get(path);
      if (!prior) push(path, 'added');
      else if (prior.sha256 !== entry.sha256) push(path, 'modified');
    }
    if (baseline) {
      for (const path of before.keys()) {
        if (!after.has(path)) push(path, 'deleted');
      }
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));
    const counts = {
      added: changes.filter((entry) => entry.change === 'added').length,
      modified: changes.filter((entry) => entry.change === 'modified').length,
      deleted: changes.filter((entry) => entry.change === 'deleted').length,
      toolRecorded: changes.filter((entry) => entry.attribution === 'tool_recorded').length,
      unattributed: changes.filter((entry) => entry.attribution === 'unattributed').length,
    };
    return {
      projectId: input.projectId,
      comparable: baseline !== null,
      baseline: baseline
        ? {
            id: baseline.id,
            label: baseline.label,
            capturedAt: baseline.capturedAt,
            fileCount: baseline.fileCount,
            truncated: baseline.truncated,
          }
        : null,
      changes,
      counts,
      skipped,
      attributionNote: baseline
        ? 'Only paths recorded by tool events are labeled tool_recorded. Everything else is an unattributed workspace change; pre-existing user edits were already in the baseline and are not shown as agent work.'
        : 'No baseline exists for this project yet, so no change list is available; this is not an empty diff.',
      truncated,
    };
  }

  /**
   * Text diff. Git is the only textual baseline Mona trusts; without it the
   * report says so rather than rendering an empty diff.
   */
  async diffText(workspace: string, path: string, options: { staged?: boolean } = {}): Promise<TextDiff> {
    const status = await this.git.status(workspace);
    if (status.kind === 'none') {
      return {
        path,
        available: false,
        text: '',
        truncated: false,
        reason: `no textual baseline: ${status.unavailableReason ?? 'the workspace is not a Git repository'}`,
      };
    }
    const result = await this.git.diff(workspace, path, {
      ...(options.staged === undefined ? {} : { staged: options.staged }),
      maxBytes: 200_000,
    });
    return { path, ...result };
  }

  async gitStatus(workspace: string): Promise<GitStatus> {
    return await this.git.status(workspace);
  }

  async stage(workspace: string, paths: readonly string[]): Promise<{ staged: string[] }> {
    return await this.git.stage(workspace, paths);
  }

  async commit(workspace: string, input: { message: string; paths: readonly string[] }) {
    const status = await this.git.status(workspace);
    if (status.kind === 'none') {
      throw stateError('invalid_request', 'this folder is not a Git repository; nothing was staged or committed');
    }
    return await this.git.commit(workspace, input);
  }

  /**
   * Restore evidence. Non-Git folders have no native snapshot, and Mona does not
   * build one; the preview says so instead of pretending restore is available.
   */
  async restorePreview(
    workspace: string,
    paths: readonly string[],
    excluded: readonly string[] = [],
  ): Promise<RestorePreview & { unsupported: string[] }> {
    const status = await this.git.status(workspace);
    if (status.kind === 'none') {
      return {
        scope: [...paths],
        excluded: [...excluded],
        conflicts: [],
        current: [],
        head: null,
        unsupported: [
          `restore is unavailable: ${status.unavailableReason ?? 'this folder is not a Git repository'}; Mona has no native snapshot engine`,
        ],
      };
    }
    return await this.git.restorePreview(workspace, paths, excluded);
  }

  async restore(
    projectId: string,
    workspace: string,
    input: { paths: readonly string[]; expectedSha256: Record<string, string | null> },
  ): Promise<RestoreResult> {
    const result = await this.git.restore(workspace, input);
    await this.store.write((tx) => {
      tx.db
        .prepare(
          `INSERT INTO restore_receipts(id, project_id, scope_json, excluded_json, conflicts_json, outcome, detail, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `rst_${randomUUID().replaceAll('-', '')}`,
          projectId,
          JSON.stringify(input.paths),
          JSON.stringify([]),
          JSON.stringify(result.outcome === 'refused' ? [result.detail] : []),
          result.outcome === 'applied' ? 'applied' : 'refused',
          result.detail,
          tx.now(),
        );
      tx.bumpRevision();
    });
    return result;
  }

  /** A test card: the command, its real exit status and a bounded output artifact. */
  async recordTestReceipt(input: TestReceiptInput): Promise<TestReceipt> {
    const command = input.command.trim();
    if (!command) throw stateError('invalid_request', 'a test command is required');
    if (!['passed', 'failed', 'unknown'].includes(input.outcome)) {
      throw stateError('invalid_request', `unknown test outcome ${input.outcome}`);
    }
    if (input.outcome === 'passed' && input.exitCode !== 0) {
      throw stateError('invalid_request', 'a passed receipt must have exit code 0');
    }
    if (input.outcome === 'failed' && input.exitCode === 0) {
      throw stateError('invalid_request', 'a failed receipt must have a non-zero exit code');
    }
    const output = input.output ?? null;
    let outputPath: string | null = null;
    let outputSha256: string | null = null;
    let outputBytes: number | null = null;
    let outputTruncated = false;
    if (output !== null) {
      const buffer = Buffer.from(output, 'utf8');
      outputBytes = buffer.byteLength;
      outputSha256 = sha256(buffer);
      if (this.artifacts && buffer.byteLength <= MAX_RECEIPT_OUTPUT) {
        const artifact = this.artifacts.put({
          content: buffer,
          mediaType: 'text/plain',
          source: `test-receipt:${command}`.slice(0, 200),
          retention: 'task',
          projectId: input.projectId,
          maxBytes: MAX_RECEIPT_OUTPUT,
        });
        outputPath = artifact.relativePath;
      } else if (buffer.byteLength > MAX_RECEIPT_OUTPUT) {
        outputTruncated = true;
      }
    }
    return await this.store.write((tx) => {
      const id = `tst_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO test_receipts(id, project_id, task_id, command, exit_code, outcome, started_at, finished_at,
             duration_ms, commit_sha, output_path, output_sha256, output_bytes, output_truncated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.taskId ?? null,
          command,
          input.exitCode,
          input.outcome,
          input.startedAt ?? null,
          input.finishedAt ?? null,
          input.durationMs ?? null,
          input.commit ?? null,
          outputPath,
          outputSha256,
          outputBytes,
          outputTruncated ? 1 : 0,
          tx.now(),
        );
      tx.bumpRevision();
      return this.rowToReceipt(
        tx.db.prepare('SELECT * FROM test_receipts WHERE id = ?').get(id) as Record<string, unknown>,
      );
    });
  }

  async testReceipts(projectId: string, limit = 100): Promise<TestReceipt[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM test_receipts WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(projectId, Math.max(1, Math.min(limit, 1_000))) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToReceipt(row));
    });
  }

  private rowToBaseline(row: Record<string, unknown>): Baseline {
    const entries = JSON.parse(String(row.entries_json)) as FileSnapshot[];
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      label: String(row.label),
      fileCount: Number(row.file_count),
      truncated: Number(row.truncated) === 1,
      capturedAt: String(row.captured_at),
      entries,
    };
  }

  private rowToReceipt(row: Record<string, unknown>): TestReceipt {
    const nullableString = (value: unknown): string | null =>
      value === null || value === undefined ? null : String(value);
    const nullableNumber = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: nullableString(row.task_id),
      command: String(row.command),
      exitCode: nullableNumber(row.exit_code),
      outcome: String(row.outcome) as TestReceipt['outcome'],
      startedAt: nullableString(row.started_at),
      finishedAt: nullableString(row.finished_at),
      durationMs: nullableNumber(row.duration_ms),
      commit: nullableString(row.commit_sha),
      outputPath: nullableString(row.output_path),
      outputSha256: nullableString(row.output_sha256),
      outputBytes: nullableNumber(row.output_bytes),
      outputTruncated: Number(row.output_truncated) === 1,
      createdAt: String(row.created_at),
    };
  }
}
