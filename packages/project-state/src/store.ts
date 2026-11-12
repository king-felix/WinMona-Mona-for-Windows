import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SubmissionRecord } from '@mona/contracts';
import { MaintenanceBarrier } from './barrier.js';
import { openDatabase, type OpenDatabase } from './db.js';
import { stateError, type StateError, type WriteOptions } from './errors.js';
import { identifyPath, markerPath, hashIdentity, type PathIdentity } from './identity.js';

export type ProjectRow = {
  id: string;
  label: string;
  canonicalPath: string;
  fsIdentity: FilesystemIdentityHash;
  markerId: string | null;
  repoKind: 'none' | 'git' | 'worktree';
  sharedRepoKey: string | null;
  color: string | null;
  monogram: string | null;
  pinned: boolean;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type FilesystemIdentityHash = string;

export type RegisterOutcome =
  | { status: 'created' | 'existing' | 'alias' | 'rebound'; project: ProjectRow }
  | { status: 'relocation_required'; project: ProjectRow; observedPath: string; reason: string };

export type RegisterOptions = {
  label?: string;
  /** Explicit rebind of a known project to a new path (a moved folder). */
  rebind?: boolean;
  /** Write Mona's portable marker into the folder. Defaults to true. */
  writeMarker?: boolean;
};

export type ProjectPatch = {
  label?: string;
  color?: string | null;
  monogram?: string | null;
  pinned?: boolean;
  archived?: boolean;
};

export type TaskRow = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  promptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceInput = {
  requirementId: string;
  criterionId: string;
  path: string;
  sha256: string;
  kind: string;
  note?: string;
};

export type AttemptInput = {
  problemId: string;
  symptomFingerprint: string;
  hypothesis: string;
  action: string;
  observedResult: string;
  evidencePath?: string;
  materialProgress: boolean;
  consecutiveNoProgress: number;
};

export type UsageInput = {
  projectId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  cacheHitTokens?: number | null;
  cacheMissTokens?: number | null;
  outputTokens?: number | null;
  costMicros?: number | null;
  costKnown: boolean;
  source: string;
};

export type RuntimeBindingRow = {
  id: string;
  projectId: string;
  workspace: string;
  endpoint: string | null;
  pid: number | null;
  processCreationTime: string | null;
  engineVersion: string | null;
  engineCommit: string | null;
  owned: boolean;
  tokenSha256: string | null;
  state: string;
  createdAt: string;
  lastSeenAt: string;
};

export type RuntimeBindingInput = {
  projectId: string;
  workspace: string;
  endpoint?: string | null;
  pid?: number | null;
  processCreationTime?: string | null;
  engineVersion?: string | null;
  engineCommit?: string | null;
  owned: boolean;
  tokenSha256?: string | null;
  state: string;
};

export type ProjectUsageRow = {
  turnCount: number;
  knownCostMicros: number;
  unknownCostRecords: number;
};

export type StoreOptions = {
  file: string;
  barrier?: MaintenanceBarrier;
  now?: () => Date;
  /** Injected failure hook for crash tests around the write path. */
  hooks?: {
    afterBegin?: () => void;
    afterStatement?: () => void;
    beforeCommit?: () => void;
  };
};

export type StudioMode = 'agent' | 'plan';

export type StudioThreadRow = {
  id: string;
  projectId: string;
  engineThreadId: string;
  workspace: string;
  sessionId: string | null;
  mode: StudioMode | null;
  profileJson: string | null;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
};

export type StudioThreadInput = {
  id: string;
  projectId: string;
  engineThreadId: string;
  workspace: string;
  sessionId: string;
  mode: StudioMode;
  /** The effective profile observed from the engine, stored verbatim. */
  profileJson: string;
};

export type TimelineItemInput = {
  id: string;
  projectId: string;
  threadId: string;
  turnId: string | null;
  seq: number;
  kind: string;
  title: string;
  body: string;
  status: string | null;
  truncated: boolean;
};

export type TimelineItemRow = {
  id: string;
  projectId: string;
  threadId: string;
  turnId: string | null;
  seq: number;
  kind: string;
  title: string;
  body: string;
  status: string | null;
  truncated: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * The one write path for local project state. Every mutation enters the
 * maintenance barrier and a single IMMEDIATE transaction; project-scoped writes
 * can require an expected revision so a stale writer fails instead of
 * overwriting newer state.
 */
export class ProjectStore {
  readonly barrier: MaintenanceBarrier;
  private open: OpenDatabase;
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly hooks: StoreOptions['hooks'];

  constructor(options: StoreOptions) {
    this.barrier = options.barrier ?? new MaintenanceBarrier();
    this.filePath = options.file;
    this.open = openDatabase({ file: options.file });
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks;
  }

  /** Reopen after a restore replaced the file underneath this connection. */
  reopen(): void {
    this.open = openDatabase({ file: this.filePath });
  }

  get database(): DatabaseSync {
    return this.open.db;
  }

  get file(): string {
    return this.open.file;
  }

  integrityCheck(): string {
    return this.open.integrityCheck();
  }

  close(): void {
    this.open.close();
  }

  async read<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const release = await this.barrier.enter('read');
    try {
      return fn(this.open.db);
    } finally {
      release();
    }
  }

  async write<T>(fn: (tx: WriteTransaction) => T, options: WriteOptions = {}): Promise<T> {
    const release = await this.barrier.enter('write');
    try {
      return this.open.transaction(() => {
        this.hooks?.afterBegin?.();
        const tx = new WriteTransaction(this.open.db, this.now, this.hooks);
        if (options.expectedRevision !== undefined) {
          if (!options.projectId) {
            throw stateError('invalid_request', 'an expected revision requires a project id');
          }
          assertRevision(this.open.db, options.projectId, options.expectedRevision);
        }
        const value = fn(tx);
        this.hooks?.beforeCommit?.();
        return value;
      });
    } finally {
      release();
    }
  }

  /** Maintenance operations must call this instead of `write`. */
  async exclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    return await this.barrier.exclusive(label, fn);
  }

  /** Snapshot-style maintenance: writers quiesced, reads still served. */
  async snapshot<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    return await this.barrier.snapshot(label, fn);
  }

  storeRevision(): number {
    const row = this.open.db.prepare("SELECT value FROM store_meta WHERE key = 'revision'").get() as
      { value?: string } | undefined;
    return Number(row?.value ?? '0');
  }

  /**
   * Register a folder as a project without ever duplicating one. An alias (same
   * filesystem identity or canonical path) resolves to the existing project; a
   * marker at a new path is a relocation that requires a deliberate rebind.
   */
  async registerProject(target: string, options: RegisterOptions = {}): Promise<RegisterOutcome> {
    const identity = identifyPath(target);
    return await this.write((tx) => {
      const byPath = findProjectByPath(tx.db, identity.canonicalPath);
      if (byPath) return { status: 'existing' as const, project: toProject(byPath) };

      const identityHash = hashIdentity(identity.fsIdentity);
      const byIdentity = findByFsIdentity(tx.db, identityHash);
      if (byIdentity && byIdentity.canonical_path !== identity.canonicalPath) {
        // The same filesystem object seen at a new path is a move, not a second
        // project. The old path disappearing is the observable difference
        // between a moved folder and a junction/alias to a live one.
        if (!existsSync(byIdentity.canonical_path)) {
          return {
            status: 'relocation_required' as const,
            project: toProject(byIdentity),
            observedPath: identity.canonicalPath,
            reason: `this folder is project ${byIdentity.id}, last seen at ${byIdentity.canonical_path}; rebind it explicitly instead of creating a second project`,
          };
        }
        return { status: 'alias' as const, project: toProject(byIdentity) };
      }

      if (identity.markerId) {
        const byMarker = tx.db.prepare('SELECT * FROM projects WHERE marker_id = ?').get(identity.markerId) as
          ProjectRecord | undefined;
        if (byMarker) {
          if (!options.rebind) {
            return {
              status: 'relocation_required' as const,
              project: toProject(byMarker),
              observedPath: identity.canonicalPath,
              reason: `this folder carries project ${byMarker.id} (last seen at ${byMarker.canonical_path}); rebind it explicitly instead of creating a second project`,
            };
          }
          rebindProject(tx, byMarker.id, identity);
          const rebound = tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(byMarker.id) as ProjectRecord;
          return { status: 'rebound' as const, project: toProject(rebound) };
        }
      }

      const now = tx.now();
      const id = `prj_${randomUUID().replaceAll('-', '')}`;
      const label = options.label?.trim() || path.basename(identity.canonicalPath) || 'Project';
      tx.db
        .prepare(
          `INSERT INTO projects(id, label, canonical_path, fs_identity, marker_id, repo_kind, shared_repo_key, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          label,
          identity.canonicalPath,
          identityHash,
          identity.markerId ?? id,
          identity.repoKind,
          identity.sharedRepoKey,
          now,
          now,
        );
      tx.bumpRevision();
      if (options.writeMarker !== false && identity.markerId === null) {
        writeMarkerFile(identity, id, label, now);
      }
      const created = tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord;
      return { status: 'created' as const, project: toProject(created) };
    });
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    return await this.read((db) => {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord | undefined;
      return row ? toProject(row) : null;
    });
  }

  async listProjects(options: { includeArchived?: boolean } = {}): Promise<ProjectRow[]> {
    return await this.read((db) => {
      const rows = db
        .prepare(
          `SELECT * FROM projects ${options.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY pinned DESC, lower(label) ASC`,
        )
        .all() as ProjectRecord[];
      return rows.map(toProject);
    });
  }

  async updateProject(id: string, expectedRevision: number, patch: ProjectPatch): Promise<ProjectRow> {
    return await this.write(
      (tx) => {
        const row = tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord | undefined;
        if (!row) throw stateError('not_found', `project ${id} does not exist`);
        if (row.revision !== expectedRevision) {
          throw stateError(
            'stale_revision',
            `project ${id} is at revision ${row.revision}, caller expected ${expectedRevision}`,
          );
        }
        const next = {
          label: patch.label ?? row.label,
          color: patch.color === undefined ? row.color : patch.color,
          monogram: patch.monogram === undefined ? row.monogram : patch.monogram,
          pinned: patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0,
          archived: patch.archived === undefined ? row.archived : patch.archived ? 1 : 0,
        };
        tx.db
          .prepare(
            'UPDATE projects SET label = ?, color = ?, monogram = ?, pinned = ?, archived = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
          )
          .run(next.label, next.color, next.monogram, next.pinned, next.archived, tx.now(), id);
        tx.bumpRevision();
        return toProject(tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord);
      },
      { expectedRevision, projectId: id },
    );
  }

  /** Removing a catalog entry never touches the folder on disk. */
  async removeProject(id: string): Promise<{ removed: boolean }> {
    return await this.write((tx) => {
      const result = tx.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      if (Number(result.changes) > 0) tx.bumpRevision();
      return { removed: Number(result.changes) > 0 };
    });
  }

  /**
   * Deliberately move a catalog entry to a new path (a moved folder). This is
   * the only way a known project changes location; opening a moved folder by
   * itself reports `relocation_required` first.
   */
  async relocateProject(id: string, expectedRevision: number, target: string): Promise<ProjectRow> {
    const identity = identifyPath(target);
    return await this.write(
      (tx) => {
        const row = tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord | undefined;
        if (!row) throw stateError('not_found', `project ${id} does not exist`);
        if (row.revision !== expectedRevision) {
          throw stateError(
            'stale_revision',
            `project ${id} is at revision ${row.revision}, caller expected ${expectedRevision}`,
          );
        }
        rebindProject(tx, id, identity);
        return toProject(tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord);
      },
      { expectedRevision, projectId: id },
    );
  }

  /** Store the latest observed connection for a project; one row per project. */
  async putRuntimeBinding(input: RuntimeBindingInput): Promise<RuntimeBindingRow> {
    return await this.write((tx) => {
      const existing = tx.db
        .prepare('SELECT * FROM runtime_bindings WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1')
        .get(input.projectId) as RuntimeBindingRecord | undefined;
      const now = tx.now();
      if (existing) {
        tx.db
          .prepare(
            `UPDATE runtime_bindings
               SET workspace = ?, endpoint = ?, pid = ?, process_creation_time = ?, engine_version = ?, engine_commit = ?, owned = ?, token_sha256 = ?, state = ?, last_seen_at = ?
             WHERE id = ?`,
          )
          .run(
            input.workspace,
            input.endpoint ?? null,
            input.pid ?? null,
            input.processCreationTime ?? null,
            input.engineVersion ?? null,
            input.engineCommit ?? null,
            input.owned ? 1 : 0,
            input.tokenSha256 ?? null,
            input.state,
            now,
            existing.id,
          );
        tx.bumpRevision();
        return toRuntimeBinding(
          tx.db.prepare('SELECT * FROM runtime_bindings WHERE id = ?').get(existing.id) as RuntimeBindingRecord,
        );
      }
      const id = `rtb_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO runtime_bindings(id, project_id, workspace, endpoint, pid, process_creation_time, engine_version, engine_commit, owned, token_sha256, state, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.workspace,
          input.endpoint ?? null,
          input.pid ?? null,
          input.processCreationTime ?? null,
          input.engineVersion ?? null,
          input.engineCommit ?? null,
          input.owned ? 1 : 0,
          input.tokenSha256 ?? null,
          input.state,
          now,
          now,
        );
      tx.bumpRevision();
      return toRuntimeBinding(
        tx.db.prepare('SELECT * FROM runtime_bindings WHERE id = ?').get(id) as RuntimeBindingRecord,
      );
    });
  }

  async getRuntimeBinding(projectId: string): Promise<RuntimeBindingRow | null> {
    return await this.read((db) => {
      const row = db
        .prepare('SELECT * FROM runtime_bindings WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1')
        .get(projectId) as RuntimeBindingRecord | undefined;
      return row ? toRuntimeBinding(row) : null;
    });
  }

  async listRuntimeBindings(): Promise<RuntimeBindingRow[]> {
    return await this.read((db) => {
      const rows = db
        .prepare('SELECT * FROM runtime_bindings ORDER BY last_seen_at DESC')
        .all() as RuntimeBindingRecord[];
      const seen = new Set<string>();
      const latest: RuntimeBindingRow[] = [];
      for (const row of rows) {
        if (seen.has(row.project_id)) continue;
        seen.add(row.project_id);
        latest.push(toRuntimeBinding(row));
      }
      return latest;
    });
  }

  /** Mark a project's observed runtime as no longer running. */
  async clearRuntimeBinding(projectId: string, state = 'stopped'): Promise<void> {
    await this.write((tx) => {
      const changed = tx.db
        .prepare(
          'UPDATE runtime_bindings SET state = ?, pid = NULL, endpoint = NULL, last_seen_at = ? WHERE project_id = ?',
        )
        .run(state, tx.now(), projectId);
      if (Number(changed.changes) > 0) tx.bumpRevision();
    });
  }

  /** Cost and usage already recorded for one project. Unknown is not zero. */
  async projectUsage(projectId: string): Promise<ProjectUsageRow> {
    return await this.read((db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS turn_count,
                  COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_micros ELSE 0 END), 0) AS known_micros,
                  COALESCE(SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END), 0) AS unknown_records
             FROM usage_records WHERE project_id = ?`,
        )
        .get(projectId) as { turn_count: number; known_micros: number; unknown_records: number };
      return {
        turnCount: Number(row.turn_count ?? 0),
        knownCostMicros: Number(row.known_micros ?? 0),
        unknownCostRecords: Number(row.unknown_records ?? 0),
      };
    });
  }

  /** Usage already recorded for one engine thread. Used to attribute cost deltas. */
  async threadUsageTotals(threadId: string): Promise<{
    cacheHitTokens: number;
    cacheMissTokens: number;
    outputTokens: number;
    knownCostMicros: number;
    records: number;
  }> {
    return await this.read((db) => {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(cache_hit_tokens), 0) AS hit,
                  COALESCE(SUM(cache_miss_tokens), 0) AS miss,
                  COALESCE(SUM(output_tokens), 0) AS out,
                  COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_micros ELSE 0 END), 0) AS known,
                  COUNT(*) AS records
             FROM usage_records WHERE thread_id = ?`,
        )
        .get(threadId) as { hit: number; miss: number; out: number; known: number; records: number };
      return {
        cacheHitTokens: Number(row.hit ?? 0),
        cacheMissTokens: Number(row.miss ?? 0),
        outputTokens: Number(row.out ?? 0),
        knownCostMicros: Number(row.known ?? 0),
        records: Number(row.records ?? 0),
      };
    });
  }

  /** Records one usage row for a turn; costKnown=false never carries a price. */
  async recordUsage(input: UsageInput): Promise<string> {
    return await this.write((tx) => tx.recordUsage(input));
  }

  async countThreads(projectId: string): Promise<number> {
    return await this.read((db) => {
      const row = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE project_id = ?').get(projectId) as {
        count: number;
      };
      return Number(row.count ?? 0);
    });
  }

  async listWorktreeSiblings(sharedRepoKey: string): Promise<ProjectRow[]> {
    return await this.read((db) => {
      const rows = db
        .prepare('SELECT * FROM projects WHERE shared_repo_key = ? ORDER BY canonical_path')
        .all(sharedRepoKey) as ProjectRecord[];
      return rows.map(toProject);
    });
  }

  // --- studio: engine thread bindings and the projected timeline ----------

  /**
   * Bind an engine thread to one Mona session. Re-binding the same session
   * updates the observed profile instead of creating a second thread.
   */
  async putStudioThread(input: StudioThreadInput): Promise<StudioThreadRow> {
    return await this.write((tx) => {
      const now = tx.now();
      tx.db
        .prepare(
          `INSERT INTO threads(id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, mode = excluded.mode, updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.projectId,
          input.engineThreadId,
          input.workspace,
          now,
          now,
          input.sessionId,
          input.mode,
          input.profileJson,
        );
      tx.bumpRevision();
      const row = tx.db.prepare('SELECT * FROM threads WHERE id = ?').get(input.id) as ThreadRecord;
      return toStudioThread(row);
    });
  }

  async getStudioThread(threadId: string): Promise<StudioThreadRow | null> {
    return await this.read((db) => {
      const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as ThreadRecord | undefined;
      return row ? toStudioThread(row) : null;
    });
  }

  async studioThreadForSession(
    projectId: string,
    sessionId: string,
    mode?: StudioMode,
  ): Promise<StudioThreadRow | null> {
    return await this.read((db) => {
      const row = (
        mode
          ? db
              .prepare(
                'SELECT * FROM threads WHERE project_id = ? AND session_id = ? AND mode = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
              )
              .get(projectId, sessionId, mode)
          : db
              .prepare(
                'SELECT * FROM threads WHERE project_id = ? AND session_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
              )
              .get(projectId, sessionId)
      ) as ThreadRecord | undefined;
      return row ? toStudioThread(row) : null;
    });
  }

  /** Advances the replay cursor. This is bookkeeping, not user state. */
  async touchThread(threadId: string, lastSeq: number): Promise<void> {
    await this.write((tx) => {
      tx.db.prepare('UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?').run(lastSeq, tx.now(), threadId);
    });
  }

  /**
   * Inserts a projected event. The (thread_id, seq) index makes a replayed
   * engine event a no-op instead of a duplicate timeline row.
   */
  async putTimelineItem(input: TimelineItemInput): Promise<'inserted' | 'updated' | 'duplicate'> {
    return await this.write((tx) => {
      const now = tx.now();
      const existing = tx.db
        .prepare('SELECT id FROM timeline_items WHERE thread_id = ? AND seq = ?')
        .get(input.threadId, input.seq) as { id?: string } | undefined;
      if (existing?.id) {
        if (existing.id !== input.id) return 'duplicate';
        tx.db
          .prepare(
            'UPDATE timeline_items SET body = ?, title = ?, status = ?, truncated = ?, updated_at = ? WHERE id = ?',
          )
          .run(input.body, input.title, input.status, input.truncated ? 1 : 0, now, input.id);
        return 'updated';
      }
      tx.db
        .prepare(
          `INSERT INTO timeline_items(id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.threadId,
          input.turnId,
          input.seq,
          input.kind,
          input.title,
          input.body,
          input.status,
          input.truncated ? 1 : 0,
          now,
          now,
        );
      return 'inserted';
    });
  }

  async listTimelineItems(threadId: string, limit = 500): Promise<TimelineItemRow[]> {
    const bounded = Math.max(1, Math.min(2000, Math.trunc(limit)));
    return await this.read((db) => {
      const rows = db
        .prepare('SELECT * FROM timeline_items WHERE thread_id = ? ORDER BY seq ASC LIMIT ?')
        .all(threadId, bounded) as TimelineRecord[];
      return rows.map(toTimelineItem);
    });
  }

  async recordTurn(input: { threadId: string; engineTurnId: string; status: string }): Promise<void> {
    await this.write((tx) => {
      const existing = tx.db.prepare('SELECT id FROM turns WHERE engine_turn_id = ?').get(input.engineTurnId) as
        { id?: string } | undefined;
      if (existing?.id) {
        tx.db.prepare('UPDATE turns SET status = ? WHERE id = ?').run(input.status, existing.id);
        return;
      }
      tx.db
        .prepare('INSERT INTO turns(id, thread_id, engine_turn_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(
          `trn_${input.engineTurnId.replace(/^turn_/, '')}`,
          input.threadId,
          input.engineTurnId,
          input.status,
          tx.now(),
        );
    });
  }

  /** Records a settings version; the newest version for a scope wins. */
  async saveSettingVersion(scope: string, version: number, values: unknown): Promise<void> {
    await this.write((tx) => tx.putSettingVersion(scope, version, values));
  }

  /** The newest saved settings blob for a scope, or null when never saved. */
  async latestSettingVersion(scope: string): Promise<{ version: number; values: unknown } | null> {
    return await this.read((db) => {
      const row = db
        .prepare('SELECT version, values_json FROM settings_versions WHERE scope = ? ORDER BY version DESC LIMIT 1')
        .get(scope) as { version?: number; values_json?: string } | undefined;
      if (!row || typeof row.version !== 'number') return null;
      try {
        return { version: row.version, values: JSON.parse(row.values_json ?? 'null') as unknown };
      } catch {
        return null;
      }
    });
  }
}

type ThreadRecord = {
  id: string;
  project_id: string;
  engine_thread_id: string;
  workspace: string;
  last_seq: number;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  mode: string | null;
  profile_json: string | null;
};

function toStudioThread(row: ThreadRecord): StudioThreadRow {
  return {
    id: row.id,
    projectId: row.project_id,
    engineThreadId: row.engine_thread_id,
    workspace: row.workspace,
    sessionId: row.session_id,
    mode: row.mode === 'plan' ? 'plan' : row.mode === 'agent' ? 'agent' : null,
    profileJson: row.profile_json,
    lastSeq: Number(row.last_seq ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type TimelineRecord = {
  id: string;
  project_id: string;
  thread_id: string;
  turn_id: string | null;
  seq: number;
  kind: string;
  title: string;
  body: string;
  status: string | null;
  truncated: number;
  created_at: string;
  updated_at: string;
};

function toTimelineItem(row: TimelineRecord): TimelineItemRow {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    seq: Number(row.seq),
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeMarkerFile(identity: PathIdentity, id: string, label: string, createdAt: string): void {
  const file = markerPath(identity.canonicalPath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ schema_version: 1, project_id: id, label, created_at: createdAt }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    // A marker that cannot be written (read-only folder, or one that appeared
    // concurrently) does not fail registration; identity still comes from the
    // store's path and filesystem records.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
  }
}

function findProjectByPath(db: DatabaseSync, canonicalPath: string): ProjectRecord | undefined {
  return db.prepare('SELECT * FROM projects WHERE canonical_path = ?').get(canonicalPath) as ProjectRecord | undefined;
}

function findByFsIdentity(db: DatabaseSync, identityHash: string): ProjectRecord | undefined {
  return db.prepare('SELECT * FROM projects WHERE fs_identity = ?').get(identityHash) as ProjectRecord | undefined;
}

function rebindProject(tx: WriteTransaction, id: string, identity: PathIdentity): void {
  const conflict = findProjectByPath(tx.db, identity.canonicalPath);
  if (conflict && conflict.id !== id) {
    throw stateError(
      'alias_conflict',
      `path ${identity.canonicalPath} is already registered to project ${conflict.id}`,
    );
  }
  tx.db
    .prepare(
      `UPDATE projects
         SET canonical_path = ?, fs_identity = ?, repo_kind = ?, shared_repo_key = ?, marker_id = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      identity.canonicalPath,
      hashIdentity(identity.fsIdentity),
      identity.repoKind,
      identity.sharedRepoKey,
      identity.markerId ?? id,
      tx.now(),
      id,
    );
  tx.bumpRevision();
}

function assertRevision(db: DatabaseSync, projectId: string, expected: number): void {
  const row = db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId) as
    { revision: number } | undefined;
  if (!row) throw stateError('not_found', `project ${projectId} does not exist`);
  if (row.revision !== expected) {
    throw stateError(
      'stale_revision',
      `project ${projectId} is at revision ${row.revision}, caller expected ${expected}`,
    );
  }
}

/** The transaction handle passed to `write`; it exposes the revision bump. */
export class WriteTransaction {
  constructor(
    readonly db: DatabaseSync,
    readonly clock: () => Date,
    private readonly hooks: StoreOptions['hooks'],
  ) {}

  now(): string {
    return this.clock().toISOString();
  }

  bumpRevision(): number {
    this.db.exec("UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'");
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key = 'revision'").get() as { value?: string };
    return Number(row?.value ?? '0');
  }

  insertTask(input: { projectId: string; title: string; status?: string; promptId?: string | null }): TaskRow {
    const id = `tsk_${randomUUID().replaceAll('-', '')}`;
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO tasks(id, project_id, title, status, prompt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.projectId, input.title, input.status ?? 'pending', input.promptId ?? null, now, now);
    this.bumpRevision();
    return {
      id,
      projectId: input.projectId,
      title: input.title,
      status: input.status ?? 'pending',
      promptId: input.promptId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  addDependency(taskId: string, dependsOn: string): void {
    this.db.prepare('INSERT INTO task_dependencies(task_id, depends_on) VALUES (?, ?)').run(taskId, dependsOn);
    this.bumpRevision();
  }

  addEvidence(projectId: string | null, input: EvidenceInput): string {
    const id = `evd_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare(
        `INSERT INTO requirement_evidence(id, project_id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        input.requirementId,
        input.criterionId,
        input.path,
        input.sha256,
        input.kind,
        input.note ?? null,
        this.now(),
      );
    this.bumpRevision();
    return id;
  }

  addAttempt(projectId: string | null, input: AttemptInput): string {
    const id = `att_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare(
        `INSERT INTO attempts(id, project_id, problem_id, symptom_fingerprint, hypothesis, action, observed_result, evidence_path, material_progress, consecutive_no_progress, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        input.problemId,
        input.symptomFingerprint,
        input.hypothesis,
        input.action,
        input.observedResult,
        input.evidencePath ?? null,
        input.materialProgress ? 1 : 0,
        input.consecutiveNoProgress,
        this.now(),
      );
    this.bumpRevision();
    return id;
  }

  addDecision(projectId: string | null, title: string, body: string): string {
    const id = `dec_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, title, body, this.now());
    this.bumpRevision();
    return id;
  }

  recordUsage(input: UsageInput): string {
    const id = `use_${randomUUID().replaceAll('-', '')}`;
    if (!input.costKnown && input.costMicros !== null && input.costMicros !== undefined) {
      throw stateError('invalid_request', 'a usage record marked unknown must not carry a cost value');
    }
    this.db
      .prepare(
        `INSERT INTO usage_records(id, project_id, thread_id, turn_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micros, cost_known, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId ?? null,
        input.threadId ?? null,
        input.turnId ?? null,
        input.cacheHitTokens ?? null,
        input.cacheMissTokens ?? null,
        input.outputTokens ?? null,
        input.costMicros ?? null,
        input.costKnown ? 1 : 0,
        input.source,
        this.now(),
      );
    this.bumpRevision();
    return id;
  }

  saveCapabilitySnapshot(
    projectId: string | null,
    input: { version: string; commit: string; capabilities: unknown },
  ): string {
    const id = `cap_${randomUUID().replaceAll('-', '')}`;
    this.db
      .prepare(
        'INSERT INTO capability_snapshots(id, project_id, engine_version, engine_commit, capabilities_json, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, projectId, input.version, input.commit, JSON.stringify(input.capabilities), this.now());
    this.bumpRevision();
    return id;
  }

  putSubmission(record: SubmissionRecord, reconciliationRequired = false): void {
    const existing = this.db
      .prepare('SELECT id FROM submissions WHERE engine_thread_id = ? AND operation_key = ?')
      .get(record.threadId, record.operationKey) as { id?: string } | undefined;
    const now = this.now();
    if (existing?.id) {
      this.db
        .prepare(
          'UPDATE submissions SET state = ?, turn_id = ?, intent_json = ?, reconciliation_required = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          record.state,
          record.turnId ?? null,
          JSON.stringify(record),
          reconciliationRequired ? 1 : 0,
          now,
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO submissions(id, thread_id, engine_thread_id, operation_key, turn_id, state, intent_json, reconciliation_required, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.threadId,
          record.threadId,
          record.operationKey,
          record.turnId ?? null,
          record.state,
          JSON.stringify(record),
          reconciliationRequired ? 1 : 0,
          now,
          now,
        );
    }
    this.bumpRevision();
  }

  putSettingVersion(scope: string, version: number, values: unknown): void {
    this.db
      .prepare('INSERT INTO settings_versions(id, scope, version, values_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`set_${randomUUID().replaceAll('-', '')}`, scope, version, JSON.stringify(values), this.now());
    this.bumpRevision();
  }
}

type RuntimeBindingRecord = {
  id: string;
  project_id: string;
  workspace: string;
  endpoint: string | null;
  pid: number | null;
  process_creation_time: string | null;
  engine_version: string | null;
  engine_commit: string | null;
  owned: number;
  token_sha256: string | null;
  state: string;
  created_at: string;
  last_seen_at: string;
};

type ProjectRecord = {
  id: string;
  label: string;
  canonical_path: string;
  fs_identity: string | null;
  marker_id: string | null;
  repo_kind: string;
  shared_repo_key: string | null;
  color: string | null;
  monogram: string | null;
  pinned: number;
  archived: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

function toProject(row: ProjectRecord): ProjectRow {
  return {
    id: row.id,
    label: row.label,
    canonicalPath: row.canonical_path,
    fsIdentity: row.fs_identity ?? '',
    markerId: row.marker_id,
    repoKind: (row.repo_kind as ProjectRow['repoKind']) ?? 'none',
    sharedRepoKey: row.shared_repo_key,
    color: row.color,
    monogram: row.monogram,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRuntimeBinding(row: RuntimeBindingRecord): RuntimeBindingRow {
  return {
    id: row.id,
    projectId: row.project_id,
    workspace: row.workspace,
    endpoint: row.endpoint,
    pid: row.pid,
    processCreationTime: row.process_creation_time,
    engineVersion: row.engine_version,
    engineCommit: row.engine_commit,
    owned: row.owned === 1,
    tokenSha256: row.token_sha256,
    state: row.state,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export type { StateError };
