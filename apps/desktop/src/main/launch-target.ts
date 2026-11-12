/**
 * Shape and reachability of a path the shell selected. Explorer can hand Mona a
 * folder, a drive root, a share root, a distribution root, a junction or a path
 * that has already disappeared. Each answer is different; none of them is
 * "index the whole drive".
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export type LaunchPathShape = 'folder' | 'unc' | 'wsl';

export type LaunchPathProblem =
  'empty' | 'invalid' | 'too_long' | 'missing' | 'not_a_folder' | 'inaccessible' | 'unreachable';

export type LaunchPathInspection =
  | { ok: true; path: string; shape: LaunchPathShape }
  | { ok: false; kind: 'needs-selection'; path: string; detail: string }
  | { ok: false; kind: 'rejected'; path: string | null; code: LaunchPathProblem; detail: string };

export type LaunchPathDeps = {
  cwd: string;
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to fs.promises.stat. */
  stat?: (target: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  /** Local checks are bounded; a disconnected share must not hold the shell. */
  timeoutMs?: number;
};

const MAX_PATH_CHARS = 32_767;

function pathApi(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

type WindowsShape = 'folder' | 'drive-root' | 'share-root' | 'wsl-root' | 'unc' | 'wsl';

/** Classify a resolved Windows path by its root, not by what it contains. */
export function classifyWindowsPath(resolved: string): WindowsShape {
  const analysis = resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
  if (/^[A-Za-z]:[\\/]$/.test(analysis)) return 'drive-root';

  const unc = /^\\\\([^\\/]+)\\([^\\/]+)[\\/]?$/.exec(analysis);
  if (unc) {
    const host = (unc[1] ?? '').toLowerCase();
    if (host === 'wsl$' || host === 'wsl.localhost') return 'wsl-root';
    return 'share-root';
  }
  if (analysis.startsWith('\\\\')) {
    const host = ((analysis.slice(2).split(/[\\/]/)[0] ?? '') as string).toLowerCase();
    return host === 'wsl$' || host === 'wsl.localhost' ? 'wsl' : 'unc';
  }
  return 'folder';
}

function rootProblem(shape: WindowsShape): string | null {
  switch (shape) {
    case 'drive-root':
      return 'That is a whole drive. Choose the project folder inside it; Mona does not open or index an entire drive.';
    case 'share-root':
      return 'That is a network share root. Choose the project folder inside it; Mona does not index an entire share.';
    case 'wsl-root':
      return 'That is a Linux distribution root. Choose the project folder inside it; Mona does not index an entire distribution.';
    default:
      return null;
  }
}

/**
 * Resolve and classify a selected path without touching the filesystem. Broad
 * roots come back as `needs-selection` so the launcher can ask for a project
 * folder instead of opening something enormous.
 */
export function classifyLaunchPath(
  raw: string,
  deps: { cwd: string; platform?: NodeJS.Platform },
): LaunchPathInspection {
  const platform = deps.platform ?? process.platform;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, kind: 'rejected', path: null, code: 'empty', detail: 'The shell did not pass a folder path.' };
  }
  if (trimmed.length > MAX_PATH_CHARS) {
    return {
      ok: false,
      kind: 'rejected',
      path: null,
      code: 'too_long',
      detail: 'That path is longer than Windows can open.',
    };
  }
  if (hasControlCharacters(trimmed)) {
    return {
      ok: false,
      kind: 'rejected',
      path: null,
      code: 'invalid',
      detail: 'That path contains control characters and cannot name a folder.',
    };
  }

  const resolved = pathApi(platform).resolve(deps.cwd, trimmed);
  if (platform !== 'win32') return { ok: true, path: resolved, shape: 'folder' };

  const shape = classifyWindowsPath(resolved);
  const problem = rootProblem(shape);
  if (problem) return { ok: false, kind: 'needs-selection', path: resolved, detail: problem };
  return { ok: true, path: resolved, shape: shape === 'wsl' ? 'wsl' : shape === 'unc' ? 'unc' : 'folder' };
}

function statErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolve, classify and verify that the selected path is a folder Mona can
 * inspect. Network paths are bounded: an unreachable share is reported, never
 * awaited indefinitely.
 */
export async function inspectLaunchPath(raw: string, deps: LaunchPathDeps): Promise<LaunchPathInspection> {
  const classified = classifyLaunchPath(raw, deps);
  if (!classified.ok) return classified;

  const timeoutMs = deps.timeoutMs ?? (classified.shape === 'folder' ? 2_500 : 5_000);
  const stat = deps.stat ?? ((target: string) => fsp.stat(target));
  let stats: { isDirectory(): boolean; isFile(): boolean };
  try {
    stats = await withTimeout(stat(classified.path), timeoutMs);
  } catch (error) {
    const code = statErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ok: false,
        kind: 'rejected',
        path: classified.path,
        code: 'missing',
        detail: `${classified.path} was not found. It may have been moved, renamed, or disconnected.`,
      };
    }
    if (code === 'ETIMEDOUT') {
      return {
        ok: false,
        kind: 'rejected',
        path: classified.path,
        code: 'unreachable',
        detail: `${classified.path} did not answer within ${timeoutMs} ms. Check that the location is reachable, then launch again.`,
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        kind: 'rejected',
        path: classified.path,
        code: 'inaccessible',
        detail: `${classified.path} cannot be read with this Windows account.`,
      };
    }
    return {
      ok: false,
      kind: 'rejected',
      path: classified.path,
      code: 'unreachable',
      detail: `${classified.path} could not be inspected${code ? ` (${code})` : ''}.`,
    };
  }

  if (stats.isFile()) {
    return {
      ok: false,
      kind: 'rejected',
      path: classified.path,
      code: 'not_a_folder',
      detail: `${classified.path} is a file. Mona opens project folders; selecting a file to open its parent project arrives in a later milestone.`,
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      kind: 'rejected',
      path: classified.path,
      code: 'not_a_folder',
      detail: `${classified.path} is not a folder.`,
    };
  }
  return classified;
}

/** The honest caveat for a workspace the pinned runtime has not qualified. */
export function workspaceCaveat(shape: LaunchPathShape): string | null {
  if (shape === 'unc') {
    return 'Network workspaces are not qualified for the pinned runtime; Mona opens the folder but will not copy or index it.';
  }
  if (shape === 'wsl') {
    return 'WSL workspaces are reached through a UNC path that the pinned runtime has not qualified; Mona opens the folder but will not copy or index it.';
  }
  return null;
}
