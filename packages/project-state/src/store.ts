import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

  async listWorktreeSiblings(sharedRepoKey: string): Promise<ProjectRow[]> {
    return await this.read((db) => {
      const rows = db
        .prepare('SELECT * FROM projects WHERE shared_repo_key = ? ORDER BY canonical_path')
        .all(sharedRepoKey) as ProjectRecord[];
      return rows.map(toProject);
    });
  }
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

export type { StateError };
