import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { stateError } from './errors.js';
import type { ProjectStore } from './store.js';

export type BackupRecord = {
  file: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  schemaVersion: number;
  integrity: string;
  pages: number;
};

export type BackupOptions = {
  directory: string;
  label?: string;
  now?: () => Date;
};

/**
 * Take a consistent snapshot with the maintenance barrier held, using SQLite's
 * online backup API into a temporary file that is verified before promotion.
 */
export async function createBackup(store: ProjectStore, options: BackupOptions): Promise<BackupRecord> {
  return await store.snapshot('backup', async () => {
    const now = (options.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    mkdirSync(options.directory, { recursive: true });
    const target = path.join(options.directory, `mona-${options.label ?? 'state'}-${stamp}.sqlite`);
    const temp = `${target}.partial`;
    rmSync(temp, { force: true });

    const pages = await sqliteBackup(store.database, temp);
    const integrity = verifyDatabaseFile(temp);
    if (integrity !== 'ok') {
      throw stateError('corrupt_state', 'backup did not pass integrity_check', integrity);
    }
    const bytes = statSync(temp).size;
    const sha256 = createHash('sha256').update(readFileSync(temp)).digest('hex');
    renameSync(temp, target);
    return {
      file: target,
      sha256,
      bytes,
      createdAt: now.toISOString(),
      schemaVersion: schemaVersionOf(store.database),
      integrity,
      pages,
    };
  });
}

/** Verify any state file without opening it for writing. */
export function verifyDatabaseFile(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
    const value = row?.integrity_check;
    return typeof value === 'string' ? value : 'unknown';
  } finally {
    db.close();
  }
}

function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version?: number | null } | undefined;
  return typeof row?.version === 'number' ? row.version : 0;
}

export type RestoreOptions = {
  backupFile: string;
  expectedSha256?: string;
  /** Directory used to park the current database before replacement. */
  recoveryDirectory: string;
  now?: () => Date;
};

export type RestoreReceipt = {
  restoredFrom: string;
  parkedCurrentFile: string;
  integrity: string;
  schemaVersion: number;
  completedAt: string;
};

/**
 * Restore replaces the live database only after the replacement verified. The
 * previous database is parked (never deleted) as recovery information, and the
 * backup file itself is left untouched.
 */
export async function restoreBackup(store: ProjectStore, options: RestoreOptions): Promise<RestoreReceipt> {
  return await store.exclusive('restore', async () => {
    if (!existsSync(options.backupFile)) {
      throw stateError('not_found', `backup file does not exist: ${options.backupFile}`);
    }
    if (options.expectedSha256) {
      const actual = createHash('sha256').update(readFileSync(options.backupFile)).digest('hex');
      if (actual !== options.expectedSha256) {
        throw stateError('digest_mismatch', 'backup digest does not match the expected value', actual);
      }
    }
    const integrity = verifyDatabaseFile(options.backupFile);
    if (integrity !== 'ok') {
      throw stateError('corrupt_state', 'backup failed verification; the live database was not touched', integrity);
    }
    const live = store.file;
    const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    mkdirSync(options.recoveryDirectory, { recursive: true });
    const parked = path.join(options.recoveryDirectory, `pre-restore-${stamp}.sqlite`);

    store.close();
    copyFileSync(live, parked);
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = `${live}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${parked}${suffix}`);
    }
    copyFileSync(options.backupFile, live);
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = `${live}${suffix}`;
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
    store.reopen();
    return {
      restoredFrom: options.backupFile,
      parkedCurrentFile: parked,
      integrity,
      schemaVersion: schemaVersionOf(store.database),
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
  });
}
