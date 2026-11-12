import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type FilesystemIdentity = {
  /** Device/volume identifier from the OS, as a decimal string. */
  device: string;
  /** File index within the device; a move on the same volume keeps it. */
  inode: string;
  size: string;
  mtimeMs: string;
};

export type RepoKind = 'none' | 'git' | 'worktree';

export type PathIdentity = {
  canonicalPath: string;
  fsIdentity: FilesystemIdentity;
  repoKind: RepoKind;
  /** For a worktree, the shared repository root; otherwise null. */
  sharedRepoKey: string | null;
  markerId: string | null;
};

/** Filesystem identity is OS-provided; a copy gets a new inode, a move keeps it. */
export function filesystemIdentity(target: string): FilesystemIdentity {
  const stat = statSync(target, { bigint: true });
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    mtimeMs: String(stat.mtimeMs),
  };
}

export function canonicalize(target: string): string {
  const resolved = realpathSync(path.resolve(target));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * A `.git` file (rather than a directory) marks a linked worktree; its gitdir
 * points into the main repository's `worktrees` directory, which is the shared
 * repository relationship Mona must preserve without merging the two roots.
 */
export function repoInfo(canonicalPath: string): { repoKind: RepoKind; sharedRepoKey: string | null } {
  const dotGit = path.join(canonicalPath, '.git');
  if (!existsSync(dotGit)) return { repoKind: 'none', sharedRepoKey: null };
  const stat = statSync(dotGit);
  // A repository and its linked worktrees all share one repository key: the
  // canonical git directory. The roots stay distinct projects.
  if (stat.isDirectory()) return { repoKind: 'git', sharedRepoKey: normalizeKey(canonicalize(dotGit)) };

  const contents = readFileSync(dotGit, 'utf8');
  const match = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!match?.[1]) return { repoKind: 'git', sharedRepoKey: null };
  const gitDir = path.resolve(canonicalPath, match[1].trim());
  const marker = `${path.sep}worktrees${path.sep}`;
  const index = gitDir.lastIndexOf(marker);
  const shared = index === -1 ? path.dirname(gitDir) : gitDir.slice(0, index);
  return { repoKind: 'worktree', sharedRepoKey: normalizeKey(shared) };
}

function normalizeKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Mona's own marker, written when a folder is registered as a project. */
export function markerPath(canonicalPath: string): string {
  return path.join(canonicalPath, '.mona', 'project', 'project.json');
}

export type ProjectMarker = {
  schema_version: 1;
  project_id: string;
  label: string;
  created_at: string;
};

export function readMarker(canonicalPath: string): ProjectMarker | null {
  const file = markerPath(canonicalPath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectMarker>;
    if (parsed.schema_version !== 1 || typeof parsed.project_id !== 'string') return null;
    return {
      schema_version: 1,
      project_id: parsed.project_id,
      label: typeof parsed.label === 'string' ? parsed.label : path.basename(canonicalPath),
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function identifyPath(target: string): PathIdentity {
  const canonicalPath = canonicalize(target);
  const repo = repoInfo(canonicalPath);
  return {
    canonicalPath,
    fsIdentity: filesystemIdentity(canonicalPath),
    repoKind: repo.repoKind,
    sharedRepoKey: repo.sharedRepoKey,
    markerId: readMarker(canonicalPath)?.project_id ?? null,
  };
}

export function hashIdentity(identity: FilesystemIdentity): string {
  return createHash('sha256').update(`${identity.device}:${identity.inode}`, 'utf8').digest('hex').slice(0, 32);
}
