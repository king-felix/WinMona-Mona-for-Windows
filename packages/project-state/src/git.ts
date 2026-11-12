import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { stateError } from './errors.js';
import type { RepoKind } from './identity.js';

/**
 * Git is read and used as data, never through a shell. Mona stages and commits
 * only the paths the user selected, and never runs reset/clean as a routine
 * operation.
 */
export type GitRunResult = { code: number; stdout: string; stderr: string };

export type GitRunner = (args: string[], options: { cwd: string; timeoutMs?: number }) => GitRunResult;

export function nodeGitRunner(): GitRunner {
  return (args, options) => {
    try {
      const stdout = execFileSync('git', args, {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        code: typeof failure.status === 'number' ? failure.status : 1,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : (failure.stdout?.toString('utf8') ?? ''),
        stderr: typeof failure.stderr === 'string' ? failure.stderr : (failure.stderr?.toString('utf8') ?? ''),
      };
    }
  };
}

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'typechanged' | 'untracked' | 'conflicted';

export type GitFileChange = { path: string; status: GitFileStatus; staged: boolean };

export type GitStatus = {
  kind: RepoKind;
  unavailableReason: string | null;
  branch: string | null;
  head: string | null;
  worktreeOf: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  conflicts: string[];
};

export type RestorePreview = {
  scope: string[];
  excluded: string[];
  conflicts: Array<{ path: string; reason: string }>;
  current: Array<{ path: string; sha256: string | null }>;
  head: string | null;
  unsupported: string[];
};

export type RestoreResult = {
  outcome: 'applied' | 'refused';
  restored: string[];
  detail: string;
};

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function statusChar(char: string): GitFileStatus {
  switch (char) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'T':
      return 'typechanged';
    default:
      return 'modified';
  }
}

function relativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw stateError('invalid_request', `not a project-relative path: ${value}`);
  }
  return normalized;
}

export class GitService {
  private readonly run: GitRunner;

  constructor(options: { run?: GitRunner } = {}) {
    this.run = options.run ?? nodeGitRunner();
  }

  async status(workspace: string): Promise<GitStatus> {
    const inside = await this.git(workspace, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) {
      return {
        kind: 'none',
        unavailableReason: inside.stderr.includes('not a git repository')
          ? 'not a git repository'
          : 'git is unavailable',
        branch: null,
        head: null,
        worktreeOf: null,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
      };
    }
    const branch = (await this.git(workspace, ['branch', '--show-current'])).stdout.trim() || null;
    const headRun = await this.git(workspace, ['rev-parse', '--short', 'HEAD']);
    const head = headRun.code === 0 ? headRun.stdout.trim() : null;
    const common = (await this.git(workspace, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const gitDir = (await this.git(workspace, ['rev-parse', '--git-dir'])).stdout.trim();
    const worktreeOf = common && gitDir && common !== gitDir ? common : null;
    const statusRun = await this.git(workspace, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
    ]);
    if (statusRun.code !== 0) {
      throw stateError('invalid_request', 'git status failed', statusRun.stderr.slice(0, 1_000));
    }
    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const untracked: string[] = [];
    const conflicts: string[] = [];
    for (const entry of statusRun.stdout.split('\u0000')) {
      if (entry.length < 4) continue;
      const x = entry[0] ?? ' ';
      const y = entry[1] ?? ' ';
      const path = relativePath(entry.slice(3));
      if (x === '?' && y === '?') {
        untracked.push(path);
        continue;
      }
      if (CONFLICT_CODES.has(`${x}${y}`)) {
        conflicts.push(path);
        continue;
      }
      if (x !== ' ') staged.push({ path, status: statusChar(x), staged: true });
      if (y !== ' ') unstaged.push({ path, status: statusChar(y), staged: false });
    }
    return {
      kind: worktreeOf ? 'worktree' : 'git',
      unavailableReason: null,
      branch,
      head,
      worktreeOf,
      staged,
      unstaged,
      untracked,
      conflicts,
    };
  }

  /** Stage exactly the given project-relative paths. */
  async stage(workspace: string, paths: readonly string[]): Promise<{ staged: string[] }> {
    const safe = this.requirePaths(paths);
    const result = await this.git(workspace, ['add', '--', ...safe]);
    if (result.code !== 0) {
      throw stateError('invalid_request', 'git add failed', result.stderr.slice(0, 1_000));
    }
    return { staged: safe };
  }

  /**
   * Commit only the selected paths. `git commit -- <paths>` limits the commit
   * to those paths, so unrelated staged entries stay staged and uncommitted.
   */
  async commit(
    workspace: string,
    input: { message: string; paths: readonly string[] },
  ): Promise<{ committed: boolean; commit: string | null; detail: string }> {
    const message = input.message.trim();
    if (!message) throw stateError('invalid_request', 'a commit message is required');
    if (message.length > 2_000) throw stateError('invalid_request', 'the commit message is too long');
    const safe = this.requirePaths(input.paths);
    const result = await this.git(workspace, ['commit', '-m', message, '--', ...safe]);
    if (result.code !== 0) {
      return { committed: false, commit: null, detail: (result.stderr || result.stdout).trim().slice(0, 1_000) };
    }
    const head = await this.git(workspace, ['rev-parse', '--short', 'HEAD']);
    return {
      committed: true,
      commit: head.code === 0 ? head.stdout.trim() : null,
      detail: result.stdout.trim().slice(0, 1_000),
    };
  }

  /** Text diff for one path, bounded. Binary and oversized paths are labeled. */
  async diff(
    workspace: string,
    path: string,
    options: { staged?: boolean; maxBytes?: number } = {},
  ): Promise<{ available: boolean; text: string; truncated: boolean; reason: string | null }> {
    const safe = relativePath(path);
    const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 200_000, 1_000_000));
    const args = ['diff', '--no-color', ...(options.staged ? ['--cached'] : []), '--', safe];
    const result = await this.git(workspace, args);
    if (result.code !== 0) {
      return {
        available: false,
        text: '',
        truncated: false,
        reason: result.stderr.trim().slice(0, 500) || 'git diff failed',
      };
    }
    if (result.stdout.includes('Binary files')) {
      return { available: false, text: '', truncated: false, reason: 'binary file: no text diff' };
    }
    if (result.stdout.length === 0) {
      return { available: false, text: '', truncated: false, reason: 'no recorded baseline for this path' };
    }
    const truncated = Buffer.byteLength(result.stdout, 'utf8') > maxBytes;
    return {
      available: true,
      text: truncated ? result.stdout.slice(0, maxBytes) : result.stdout,
      truncated,
      reason: truncated ? `diff bounded to ${maxBytes} bytes` : null,
    };
  }

  /**
   * Preview a restore before doing anything. Staged changes, untracked files and
   * conflicts are refusals, not silent scope.
   */
  async restorePreview(
    workspace: string,
    paths: readonly string[],
    excluded: readonly string[] = [],
  ): Promise<RestorePreview> {
    const status = await this.status(workspace);
    if (status.kind === 'none') {
      throw stateError('invalid_request', 'restore needs a Git repository; no native snapshot exists for this folder');
    }
    const safe = this.requirePaths(paths);
    const conflicts: RestorePreview['conflicts'] = [];
    const current: RestorePreview['current'] = [];
    for (const path of safe) {
      const file = this.locate(workspace, path);
      current.push({ path, sha256: file.sha256 });
      const staged = status.staged.some((entry) => entry.path === path);
      const conflicted = status.conflicts.includes(path);
      const untracked = status.untracked.includes(path);
      if (conflicted) conflicts.push({ path, reason: 'the path has an unresolved merge conflict' });
      else if (staged) conflicts.push({ path, reason: 'restoring would discard staged changes for this path' });
      else if (untracked)
        conflicts.push({ path, reason: 'the path is untracked and has no committed version to restore' });
    }
    return {
      scope: safe,
      excluded: excluded.map(relativePath),
      conflicts,
      current,
      head: status.head,
      unsupported: [],
    };
  }

  /**
   * Restore the named paths to HEAD only when the caller's expected hashes still
   * match. Any mismatch refuses the whole operation, so a later user edit is
   * never overwritten silently.
   */
  async restore(
    workspace: string,
    input: { paths: readonly string[]; expectedSha256: Record<string, string | null> },
  ): Promise<RestoreResult> {
    const preview = await this.restorePreview(workspace, input.paths);
    if (preview.conflicts.length > 0) {
      return {
        outcome: 'refused',
        restored: [],
        detail: preview.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`).join('; '),
      };
    }
    for (const entry of preview.current) {
      const expected = input.expectedSha256[entry.path];
      if (expected === undefined) {
        return { outcome: 'refused', restored: [], detail: `no expected hash was supplied for ${entry.path}` };
      }
      if (expected !== entry.sha256) {
        return {
          outcome: 'refused',
          restored: [],
          detail: `${entry.path} changed since the preview; refusing to overwrite later work`,
        };
      }
    }
    const result = await this.git(workspace, ['checkout', '--', ...preview.scope]);
    if (result.code !== 0) {
      return {
        outcome: 'refused',
        restored: [],
        detail: result.stderr.trim().slice(0, 1_000) || 'git checkout failed',
      };
    }
    return { outcome: 'applied', restored: preview.scope, detail: 'restored the previewed paths to HEAD' };
  }

  private async git(workspace: string, args: string[]): Promise<GitRunResult> {
    return this.run(args, { cwd: workspace });
  }

  private requirePaths(paths: readonly string[]): string[] {
    const safe = [...new Set(paths.map(relativePath))];
    if (safe.length === 0) throw stateError('invalid_request', 'at least one path is required');
    if (safe.length > 500) throw stateError('invalid_request', 'too many paths in one operation');
    return safe;
  }

  private locate(workspace: string, relative: string): { sha256: string | null } {
    const absolute = resolve(workspace, relative);
    const root = resolve(workspace);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw stateError('invalid_request', 'path escapes the workspace');
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return { sha256: null };
    return { sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
  }
}
