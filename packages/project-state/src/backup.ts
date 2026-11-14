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

/** Schema version of a database file, read without opening it for writing. */
export function schemaVersionOfFile(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return schemaVersionOf(db);
  } finally {
    db.close();
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows can briefly refuse a rename while a scanner or another handle lets go.
 * A few short retries turn that into a slower restore instead of a failed one;
 * the last error still propagates, so a real lock is still reported as a lock.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
      await delay(40 * (attempt + 1));
    }
  }
  throw lastError;
}

function removeStagedSidecars(staged: string): void {
  for (const suffix of ['-wal', '-shm'] as const) rmSync(`${staged}${suffix}`, { force: true });
}

function removeStaged(staged: string): void {
  try {
    rmSync(staged, { force: true });
    removeStagedSidecars(staged);
  } catch {
    /* best effort; the error that matters is the original one */
  }
}

export type RestoreOptions = {
  backupFile: string;
  expectedSha256?: string;
  /** Directory used to park the current database before replacement. */
  recoveryDirectory: string;
  now?: () => Date;
  /** Injected checkpoints for failure tests; they run with the store closed. */
  hooks?: {
    afterPark?: () => void;
    afterCopy?: () => void;
    beforeReplace?: () => void;
  };
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
    // A backup written by a newer build carries migrations this build does not
    // have. Restoring it would leave rows the code cannot read, so it is refused
    // before anything is closed or replaced.
    const liveSchema = schemaVersionOf(store.database);
    const backupSchema = schemaVersionOfFile(options.backupFile);
    if (backupSchema > liveSchema) {
      throw stateError(
        'schema_drift',
        `backup schema version ${backupSchema} is newer than this build's ${liveSchema}; the live database was not touched`,
        'Restore this backup with the build that wrote it.',
      );
    }
    const live = store.file;
    const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    mkdirSync(options.recoveryDirectory, { recursive: true });
    const parked = path.join(options.recoveryDirectory, `pre-restore-${stamp}.sqlite`);
    // Stage the replacement beside the live file and rename it into place. A
    // failure before the rename leaves the live database byte-identical; the
    // parked copy and the verified backup both survive for recovery.
    const staged = path.join(path.dirname(live), `.mona-restore-${stamp}.sqlite.tmp`);

    store.close();
    try {
      copyFileSync(live, parked);
      for (const suffix of ['-wal', '-shm'] as const) {
        const sidecar = `${live}${suffix}`;
        if (existsSync(sidecar)) copyFileSync(sidecar, `${parked}${suffix}`);
      }
      options.hooks?.afterPark?.();

      rmSync(staged, { force: true });
      copyFileSync(options.backupFile, staged);
      const stagedIntegrity = verifyDatabaseFile(staged);
      if (stagedIntegrity !== 'ok') {
        throw stateError(
          'corrupt_state',
          'the staged replacement failed verification; the live database was not replaced',
          stagedIntegrity,
        );
      }
      options.hooks?.afterCopy?.();

      for (const suffix of ['-wal', '-shm'] as const) {
        const sidecar = `${live}${suffix}`;
        if (existsSync(sidecar)) rmSync(sidecar, { force: true });
      }
      options.hooks?.beforeReplace?.();
      await renameWithRetry(staged, live);
      removeStagedSidecars(staged);
      try {
        store.reopen();
      } catch (error) {
        // The replacement is already in place. Saying "restore failed" would hide
        // which database is live now, so this reports the real state and keeps the
        // parked copy's path for recovery.
        throw stateError(
          'corrupt_state',
          'the verified backup replaced the live database but could not be reopened',
          `${String(error)}; the previous database is parked at ${parked}`,
        );
      }
    } catch (error) {
      removeStaged(staged);
      try {
        store.reopen();
      } catch {
        /* the caller still sees the original failure */
      }
      throw error;
    }
    return {
      restoredFrom: options.backupFile,
      parkedCurrentFile: parked,
      integrity,
      schemaVersion: schemaVersionOf(store.database),
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
  });
}
