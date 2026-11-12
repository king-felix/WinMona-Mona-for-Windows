export * from './errors.js';
export * from './barrier.js';
export * from './db.js';
export * from './migrations.js';
export * from './identity.js';
export * from './store.js';
export * from './catalog.js';
export * from './artifacts.js';
export * from './backup.js';
export * from './export.js';
export * from './journal.js';
export * from './tasks.js';
export * from './attempts.js';
export * from './costs.js';
export * from './git.js';
export * from './changes.js';
export * from './briefing.js';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, type BackupRecord } from './backup.js';
import { applyMigrations, type MigrationReport } from './migrations.js';
import { ProjectStore } from './store.js';

export type OpenStateOptions = {
  /** Directory that holds the database, backups, recovery and artifacts. */
  directory: string;
  now?: () => Date;
  /** Take a verified backup before applying pending migrations (default true). */
  backupBeforeMigration?: boolean;
};

export type OpenStateResult = {
  store: ProjectStore;
  migrations: MigrationReport;
  preMigrationBackup: BackupRecord | null;
  schemaVersion: number;
  artifactRoot: string;
  backupRoot: string;
  recoveryRoot: string;
};

/**
 * Open local state the way the desktop does: migrate under the maintenance
 * barrier, keep a verified backup of any pre-migration database, and never
 * delete a recovery file.
 */
export async function openState(options: OpenStateOptions): Promise<OpenStateResult> {
  const databaseFile = join(options.directory, 'mona.sqlite');
  const backupRoot = join(options.directory, 'backups');
  const recoveryRoot = join(options.directory, 'recovery');
  const artifactRoot = join(options.directory, 'artifacts');
  const store = new ProjectStore({ file: databaseFile, ...(options.now ? { now: options.now } : {}) });

  const existingVersion = currentVersion(store);
  let preMigrationBackup: BackupRecord | null = null;
  // The backup takes its own snapshot barrier; nesting it inside the migration's
  // exclusive barrier would deadlock the single maintenance lock. At open time
  // no other writer exists yet, so take the verified backup first and then apply
  // migrations exclusively.
  if (existingVersion > 0 && options.backupBeforeMigration !== false && existsSync(databaseFile)) {
    preMigrationBackup = await createBackup(store, {
      directory: backupRoot,
      label: 'pre-migration',
      ...(options.now ? { now: options.now } : {}),
    });
  }
  const migrations = await store.exclusive('migrate', async () => applyMigrations(store.database));

  return {
    store,
    migrations,
    preMigrationBackup,
    schemaVersion: currentVersion(store),
    artifactRoot,
    backupRoot,
    recoveryRoot,
  };
}

function currentVersion(store: ProjectStore): number {
  try {
    const row = store.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version?: number | null } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch {
    return 0;
  }
}
