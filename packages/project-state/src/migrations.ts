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
  {
    version: 3,
    name: 'task-execution',
    sql: `
      -- A task is a bounded, single-owner unit of work. The owner is part of the
      -- record: Mona's queue must never independently schedule a task a native
      -- workflow also owns.
      ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN execution_owner TEXT NOT NULL DEFAULT 'mona_queue';
      ALTER TABLE tasks ADD COLUMN prompt_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN current_step TEXT;
      ALTER TABLE tasks ADD COLUMN claimed_at TEXT;
      ALTER TABLE tasks ADD COLUMN started_at TEXT;
      ALTER TABLE tasks ADD COLUMN last_transition_at TEXT;
      ALTER TABLE tasks ADD COLUMN completed_at TEXT;
      ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
      ALTER TABLE tasks ADD COLUMN skipped_reason TEXT;

      CREATE TRIGGER tasks_owner_insert BEFORE INSERT ON tasks
      WHEN NEW.execution_owner NOT IN ('mona_queue', 'native_workflow')
      BEGIN
        SELECT RAISE(ABORT, 'execution_owner must be mona_queue or native_workflow');
      END;
      CREATE TRIGGER tasks_owner_update BEFORE UPDATE OF execution_owner ON tasks
      WHEN NEW.execution_owner NOT IN ('mona_queue', 'native_workflow')
      BEGIN
        SELECT RAISE(ABORT, 'execution_owner must be mona_queue or native_workflow');
      END;
      CREATE TRIGGER tasks_status_insert BEFORE INSERT ON tasks
      WHEN NEW.status NOT IN ('pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped')
      BEGIN
        SELECT RAISE(ABORT, 'unknown task status');
      END;
      CREATE TRIGGER tasks_status_update BEFORE UPDATE OF status ON tasks
      WHEN NEW.status NOT IN ('pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped')
      BEGIN
        SELECT RAISE(ABORT, 'unknown task status');
      END;

      -- One active task per workspace, enforced by the database rather than by
      -- the scheduler's good intentions. Two projects (workspaces) may each run
      -- one task; the same workspace may not.
      CREATE UNIQUE INDEX tasks_active_per_project ON tasks(project_id)
        WHERE status IN ('running', 'verifying');

      CREATE TABLE task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        detail TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, position),
        CHECK (status IN ('pending', 'running', 'done', 'failed'))
      );
      CREATE INDEX task_steps_task ON task_steps(task_id, position);

      CREATE TABLE task_acceptance (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'check',
        required INTEGER NOT NULL DEFAULT 1,
        satisfied_at TEXT,
        satisfied_note TEXT,
        evidence_id TEXT,
        UNIQUE(task_id, position),
        CHECK (kind IN ('check', 'human')),
        CHECK (required IN (0, 1))
      );
      CREATE INDEX task_acceptance_task ON task_acceptance(task_id, position);

      CREATE TABLE task_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        criterion_id TEXT,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT,
        recorded_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        stale_reason TEXT,
        CHECK (stale IN (0, 1))
      );
      CREATE INDEX task_evidence_task ON task_evidence(task_id);
      CREATE INDEX task_evidence_path ON task_evidence(path);

      CREATE TABLE task_requirements (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (task_id, requirement_id, criterion_id)
      );

      CREATE TABLE task_transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX task_transitions_task ON task_transitions(task_id, at);

      CREATE INDEX task_dependencies_reverse ON task_dependencies(depends_on);
    `,
  },
  {
    version: 4,
    name: 'attempt-rule',
    sql: `
      -- One stable problem is one recurring unresolved issue. The problem id is
      -- derived from project + symptom fingerprint so a new session cannot mint
      -- a fresh counter for the same symptom.
      CREATE TABLE problems (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        requirement_id TEXT,
        title TEXT NOT NULL,
        symptom_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        total_attempts INTEGER NOT NULL DEFAULT 0,
        consecutive_no_progress INTEGER NOT NULL DEFAULT 0,
        stop_threshold INTEGER NOT NULL DEFAULT 3,
        help_needed TEXT,
        blocked_at TEXT,
        resolved_at TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('open', 'blocked', 'resolved')),
        CHECK (total_attempts >= 0),
        CHECK (consecutive_no_progress >= 0),
        CHECK (stop_threshold >= 1)
      );
      CREATE UNIQUE INDEX problems_fingerprint ON problems(project_id, symptom_fingerprint);
      CREATE INDEX problems_status ON problems(project_id, status);

      CREATE TABLE problem_transitions (
        id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        evidence_path TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX problem_transitions_problem ON problem_transitions(problem_id, at);

      -- The v1 attempts table is extended rather than replaced so history that
      -- already exists stays where it is. attempt_no is per problem and never
      -- renumbered; a rejected continuation is not written as an attempt.
      ALTER TABLE attempts ADD COLUMN requirement_id TEXT;
      ALTER TABLE attempts ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN progress_reason TEXT;
      ALTER TABLE attempts ADD COLUMN actor TEXT NOT NULL DEFAULT 'mona';
      ALTER TABLE attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'attempt';
      CREATE INDEX attempts_problem ON attempts(problem_id, attempt_no);
    `,
  },
  {
    version: 5,
    name: 'cost-ledger',
    sql: `
      -- Usage rows gain the fields a cost lens needs without rewriting history:
      -- provider/model identity, the token buckets, how the cost was obtained,
      -- and the rate revision that applied when it was recorded.
      ALTER TABLE usage_records ADD COLUMN provider TEXT;
      ALTER TABLE usage_records ADD COLUMN model TEXT;
      ALTER TABLE usage_records ADD COLUMN input_tokens INTEGER;
      ALTER TABLE usage_records ADD COLUMN reasoning_tokens INTEGER;
      ALTER TABLE usage_records ADD COLUMN cache_known INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_records ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE usage_records ADD COLUMN rate_revision TEXT;
      ALTER TABLE usage_records ADD COLUMN dedupe_key TEXT;
      ALTER TABLE usage_records ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
      ALTER TABLE usage_records ADD COLUMN parent_turn_id TEXT;
      ALTER TABLE usage_records ADD COLUMN unknown_reason TEXT;

      -- A replayed turn usage event or a repeated aggregate ingest is the same
      -- cost, not a second one.
      CREATE UNIQUE INDEX usage_records_dedupe ON usage_records(dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX usage_records_project ON usage_records(project_id, recorded_at);
      CREATE INDEX usage_records_turn ON usage_records(turn_id);

      -- Rates are revisioned rows. A price change appends a revision; it never
      -- edits the row an older usage record was priced with.
      CREATE TABLE rate_cards (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        unit_tokens INTEGER NOT NULL DEFAULT 1000000,
        cache_hit_micros INTEGER,
        cache_miss_micros INTEGER NOT NULL,
        output_micros INTEGER NOT NULL,
        reasoning_micros INTEGER,
        source TEXT NOT NULL,
        source_url TEXT,
        revision TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (provider, model, revision),
        CHECK (unit_tokens > 0),
        CHECK (cache_miss_micros >= 0),
        CHECK (output_micros >= 0),
        CHECK (cache_hit_micros IS NULL OR cache_hit_micros >= 0),
        CHECK (reasoning_micros IS NULL OR reasoning_micros >= 0)
      );
      CREATE INDEX rate_cards_lookup ON rate_cards(provider, model, effective_from);

      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        session_id TEXT,
        limit_micros INTEGER NOT NULL,
        warn_micros INTEGER,
        stop_micros INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (scope IN ('session', 'project', 'day')),
        CHECK (limit_micros > 0),
        CHECK (warn_micros IS NULL OR (warn_micros >= 0 AND warn_micros <= limit_micros)),
        CHECK (stop_micros IS NULL OR (stop_micros >= 0 AND stop_micros <= limit_micros))
      );
      CREATE UNIQUE INDEX budgets_scope ON budgets(project_id, scope, COALESCE(session_id, ''));

      CREATE TABLE budget_reservations (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        estimated_micros INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        released_at TEXT,
        CHECK (estimated_micros >= 0)
      );
      CREATE INDEX budget_reservations_budget ON budget_reservations(budget_id, released_at);

      CREATE TABLE budget_events (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        spent_micros INTEGER NOT NULL,
        limit_micros INTEGER NOT NULL,
        detail TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX budget_events_budget ON budget_events(budget_id, at);
    `,
  },
  {
    version: 6,
    name: 'change-receipts',
    sql: `
      -- A baseline is a hash map, not a second snapshot engine: enough to say
      -- what changed and to label attribution honestly, not enough to restore.
      CREATE TABLE change_baselines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT NOT NULL,
        CHECK (file_count >= 0),
        CHECK (truncated IN (0, 1))
      );
      CREATE INDEX change_baselines_project ON change_baselines(project_id, captured_at);
      CREATE INDEX change_baselines_task ON change_baselines(task_id, captured_at);

      CREATE TABLE test_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        command TEXT NOT NULL,
        exit_code INTEGER,
        outcome TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        commit_sha TEXT,
        output_path TEXT,
        output_sha256 TEXT,
        output_bytes INTEGER,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        CHECK (outcome IN ('passed', 'failed', 'unknown')),
        CHECK (output_truncated IN (0, 1))
      );
      CREATE INDEX test_receipts_project ON test_receipts(project_id, created_at);

      CREATE TABLE restore_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scope_json TEXT NOT NULL,
        excluded_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL,
        CHECK (outcome IN ('applied', 'refused', 'partial'))
      );
      CREATE INDEX restore_receipts_project ON restore_receipts(project_id, at);
    `,
  },
  {
    version: 7,
    name: 'project-memory',
    sql: `
      -- Local project memory is an explicit, deterministic text index. It holds
      -- permitted metadata, decisions, task evidence and bounded history
      -- projections. Repository files are never copied here: they are searched
      -- on demand by MemoryIndex.searchFiles.
      CREATE TABLE memory_documents (
        doc_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        retention TEXT NOT NULL DEFAULT 'task',
        source_digest TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL,
        UNIQUE(project_id, kind, ref_id),
        CHECK (retention IN ('ephemeral', 'task', 'evidence', 'permanent')),
        CHECK (redacted IN (0, 1))
      );
      CREATE INDEX memory_documents_project ON memory_documents(project_id, kind);
      CREATE INDEX memory_documents_retention ON memory_documents(project_id, retention);

      -- One row per term per document with a small integer weight (title hits
      -- rank above body hits). No embedding service and no model call is
      -- involved in indexing or search.
      CREATE TABLE memory_terms (
        term TEXT NOT NULL,
        doc_id TEXT NOT NULL REFERENCES memory_documents(doc_id) ON DELETE CASCADE,
        weight INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (term, doc_id),
        CHECK (weight BETWEEN 1 AND 9)
      );
      CREATE INDEX memory_terms_query ON memory_terms(term);
    `,
  },
  {
    version: 8,
    name: 'session-rotations',
    sql: `
      -- A new conversation is a durable local operation, not a side effect of a
      -- keystroke. The operation key makes a retried dispatch (lost ack, two
      -- presses, a restart) return the same new session instead of minting a
      -- second conversation. No engine thread is created here: the runtime opens
      -- one when the new session first submits work.
      CREATE TABLE session_rotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        old_session_id TEXT NOT NULL,
        new_session_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, operation_key),
        UNIQUE(new_session_id)
      );
      CREATE INDEX session_rotations_project ON session_rotations(project_id, created_at);
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
