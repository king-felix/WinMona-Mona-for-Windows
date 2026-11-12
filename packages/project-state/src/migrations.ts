import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { stateError } from './errors.js';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

/**
 * Versioned migrations. Each one is immutable once shipped: the checksum is
 * stored, and a changed checksum means someone edited history, which is a hard
 * failure rather than a silent re-apply.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        fs_identity TEXT,
        marker_id TEXT,
        repo_kind TEXT NOT NULL DEFAULT 'none',
        shared_repo_key TEXT,
        color TEXT,
        monogram TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX projects_canonical_path ON projects(canonical_path);
      CREATE INDEX projects_marker ON projects(marker_id);

      CREATE TABLE runtime_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        endpoint TEXT,
        pid INTEGER,
        process_creation_time TEXT,
        engine_version TEXT,
        engine_commit TEXT,
        owned INTEGER NOT NULL DEFAULT 0,
        token_sha256 TEXT,
        state TEXT NOT NULL DEFAULT 'stopped',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX runtime_bindings_project ON runtime_bindings(project_id);

      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        engine_thread_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX threads_engine ON threads(engine_thread_id);

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        engine_turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX turns_engine ON turns(engine_turn_id);

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        thread_id TEXT,
        engine_thread_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        turn_id TEXT,
        state TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        reconciliation_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX submissions_operation ON submissions(engine_thread_id, operation_key);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        prompt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id <> depends_on)
      );

      CREATE TABLE requirement_evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX requirement_evidence_target ON requirement_evidence(requirement_id, criterion_id);

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        problem_id TEXT NOT NULL,
        symptom_fingerprint TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        action TEXT NOT NULL,
        observed_result TEXT NOT NULL,
        evidence_path TEXT,
        material_progress INTEGER NOT NULL,
        consecutive_no_progress INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );

      CREATE TABLE event_cursors (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        thread_id TEXT,
        turn_id TEXT,
        cache_hit_tokens INTEGER,
        cache_miss_tokens INTEGER,
        output_tokens INTEGER,
        cost_micros INTEGER,
        cost_known INTEGER NOT NULL,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE capability_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        engine_version TEXT NOT NULL,
        engine_commit TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE settings_versions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        version INTEGER NOT NULL,
        values_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE artifacts (
        sha256 TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        source TEXT NOT NULL,
        retention TEXT NOT NULL DEFAULT 'task',
        created_at TEXT NOT NULL,
        pruned_at TEXT
      );

      CREATE TABLE store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO store_meta(key, value) VALUES ('revision', '0');
    `,
  },
  {
    version: 2,
    name: 'studio-timeline',
    sql: `
      -- A studio thread is an engine thread bound to one Mona session. The
      -- session id is Mona's; the engine thread id is an opaque engine id.
      ALTER TABLE threads ADD COLUMN session_id TEXT;
      ALTER TABLE threads ADD COLUMN mode TEXT;
      ALTER TABLE threads ADD COLUMN profile_json TEXT;
      -- A session may hold one thread per mode (Plan and Work), so this is a
      -- lookup index rather than a uniqueness constraint.
      CREATE INDEX threads_session ON threads(project_id, session_id);

      -- Projected engine events. seq is the engine's sequence number, so a
      -- replayed event can never become a second row.
      CREATE TABLE timeline_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX timeline_items_thread_seq ON timeline_items(thread_id, seq);
      CREATE INDEX timeline_items_project ON timeline_items(project_id, created_at);
    `,
  },
];

export type MigrationReport = {
  from: number;
  to: number;
  applied: Migration[];
  alreadyCurrent: boolean;
};

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function schemaVersion(db: DatabaseSync): number {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined;
  if (!hasTable?.name) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version?: number | null } | undefined;
  return typeof row?.version === 'number' ? row.version : 0;
}

export type ApplyMigrationsOptions = {
  migrations?: readonly Migration[];
  /** Called once before the first pending migration, while the barrier is held. */
  beforeApply?: (context: { from: number; to: number; pending: Migration[] }) => Promise<void> | void;
  /** Injected for failure tests: throws to simulate a crashed migration. */
  afterApply?: (migration: Migration) => void;
};

/**
 * Apply pending migrations one transaction each. A failure leaves the database
 * at the last fully applied version; the backup taken by `beforeApply` stays put
 * and is never deleted here.
 */
export async function applyMigrations(
  db: DatabaseSync,
  options: ApplyMigrationsOptions = {},
): Promise<MigrationReport> {
  const migrations = options.migrations ?? MIGRATIONS;
  const verify = new Map<number, string>();
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    verify.set(migration.version, checksumOf(migration.sql));
    if (migration.version !== verify.size) {
      throw stateError('migration_mismatch', 'migration versions must be contiguous starting at 1');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;
  for (const row of applied) {
    const expected = verify.get(row.version);
    if (expected === undefined) {
      throw stateError(
        'migration_mismatch',
        `database has migration ${row.version} (${row.name}) that this build does not know`,
      );
    }
    if (expected !== row.checksum) {
      throw stateError(
        'migration_mismatch',
        `migration ${row.version} (${row.name}) was modified after it was applied`,
        `stored ${row.checksum.slice(0, 12)}, current ${expected.slice(0, 12)}`,
      );
    }
  }

  const current = applied.length > 0 ? Math.max(...applied.map((row) => row.version)) : 0;
  const pending = [...migrations]
    .filter((migration) => migration.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    return { from: current, to: current, applied: [], alreadyCurrent: true };
  }
  await options.beforeApply?.({
    from: current,
    to: pending[pending.length - 1]?.version ?? current,
    pending,
  });

  const done: Migration[] = [];
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        checksumOf(migration.sql),
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw stateError(
        'migration_failed',
        `migration ${migration.version} (${migration.name}) failed; the database stays at version ${current}`,
        String(error).slice(0, 500),
      );
    }
    done.push(migration);
    options.afterApply?.(migration);
  }
  return { from: current, to: done[done.length - 1]?.version ?? current, applied: done, alreadyCurrent: false };
}
