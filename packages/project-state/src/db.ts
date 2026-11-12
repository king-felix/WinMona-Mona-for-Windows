import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateError } from './errors.js';

export type DatabaseOptions = {
  file: string;
  /** Milliseconds SQLite waits for a competing lock before failing. */
  busyTimeoutMs?: number;
  /** Force a specific journal mode; tests use 'wal' like production. */
  journalMode?: 'wal' | 'delete' | 'memory';
  readOnly?: boolean;
};

export type OpenDatabase = {
  db: DatabaseSync;
  file: string;
  close: () => void;
  integrityCheck: () => string;
  transaction: <T>(fn: (db: DatabaseSync) => T) => T;
  inTransaction: () => boolean;
};

const NETWORK_PATH = /^(\\\\|\/\/)/;

/**
 * Open the project database with the pragmas the rest of the layer assumes.
 * A network or cloud-sync location is refused: SQLite locking is not safe there
 * and the specification forbids it.
 */
export function openDatabase(options: DatabaseOptions): OpenDatabase {
  if (NETWORK_PATH.test(options.file)) {
    throw stateError(
      'unsafe_location',
      'the state database must live on a local disk, not a network share',
      options.file,
    );
  }
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const db = new DatabaseSync(options.file, { readOnly: options.readOnly ?? false });
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  db.exec('PRAGMA foreign_keys = ON');
  if (!options.readOnly) {
    db.exec(`PRAGMA journal_mode = ${options.journalMode ?? 'wal'}`);
    db.exec('PRAGMA synchronous = FULL');
  }

  let depth = 0;
  const transaction = <T>(fn: (database: DatabaseSync) => T): T => {
    if (depth > 0) throw stateError('internal', 'nested transactions are not allowed');
    depth += 1;
    // IMMEDIATE takes the write lock up front, so a stale writer fails before it
    // can interleave reads with a newer commit.
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn(db);
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; the original error is what matters */
      }
      throw error;
    } finally {
      depth -= 1;
    }
  };

  return {
    db,
    file: options.file,
    close: () => db.close(),
    integrityCheck: () => {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
      const value = row?.integrity_check;
      return typeof value === 'string' ? value : 'unknown';
    },
    transaction,
    inTransaction: () => depth > 0,
  };
}
