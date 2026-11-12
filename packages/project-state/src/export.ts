import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { stateError } from './errors.js';
import type { ProjectStore } from './store.js';

const ExportedProject = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    canonical_path: z.string().min(1),
    repo_kind: z.string().min(1),
    shared_repo_key: z.string().nullable(),
    color: z.string().nullable(),
    monogram: z.string().nullable(),
    pinned: z.number().int(),
    archived: z.number().int(),
    revision: z.number().int().nonnegative(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

const ExportedCriterion = z
  .object({
    id: z.string().min(1),
    position: z.number().int().nonnegative(),
    description: z.string().min(1),
    kind: z.enum(['check', 'human']),
    required: z.number().int(),
    satisfied_at: z.string().nullable(),
    satisfied_note: z.string().nullable(),
    evidence_id: z.string().nullable(),
  })
  .strict();

const ExportedStep = z
  .object({
    id: z.string().min(1),
    position: z.number().int().nonnegative(),
    title: z.string().min(1),
    status: z.enum(['pending', 'running', 'done', 'failed']),
    detail: z.string().nullable(),
    updated_at: z.string().min(1),
  })
  .strict();

const ExportedRequirement = z.object({ requirement_id: z.string().min(1), criterion_id: z.string() }).strict();

const ExportedTaskEvidence = z
  .object({
    id: z.string().min(1),
    criterion_id: z.string().nullable(),
    path: z.string().min(1),
    sha256: z.string().min(1),
    kind: z.string().min(1),
    note: z.string().nullable(),
    recorded_at: z.string().min(1),
    stale: z.number().int(),
    stale_reason: z.string().nullable(),
  })
  .strict();

const ExportedTask = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    prompt_id: z.string().nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    description: z.string().optional(),
    execution_owner: z.enum(['mona_queue', 'native_workflow']).optional(),
    prompt_text: z.string().optional(),
    ordinal: z.number().int().nonnegative().optional(),
    current_step: z.string().nullable().optional(),
    claimed_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    last_transition_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    blocked_reason: z.string().nullable().optional(),
    skipped_reason: z.string().nullable().optional(),
    acceptance: z.array(ExportedCriterion).optional(),
    steps: z.array(ExportedStep).optional(),
    requirements: z.array(ExportedRequirement).optional(),
    evidence: z.array(ExportedTaskEvidence).optional(),
  })
  .strict();

const ExportedDecision = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    decided_at: z.string().min(1),
  })
  .strict();

export const ProjectExport = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    kind: z.literal('mona.project-export'),
    exported_at: z.string().min(1),
    store_revision: z.number().int().nonnegative(),
    project: ExportedProject,
    tasks: z.array(ExportedTask),
    dependencies: z.array(z.object({ task_id: z.string(), depends_on: z.string() }).strict()),
    decisions: z.array(ExportedDecision),
    /** sha256 over the canonical JSON of everything except this field. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ProjectExport = z.infer<typeof ProjectExport>;

const TASK_STATUSES = new Set(['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped']);

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

export function digestOfExport(document: Omit<ProjectExport, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

/**
 * Export one project's status without machine-local bindings or secrets: no
 * runtime endpoints, pids, token digests, or absolute scratch paths travel.
 * Task acceptance criteria, requirement traceability and evidence paths travel
 * with the project so a human-authored plan survives a round trip. The file is
 * written atomically and carries a digest plus the store revision.
 */
export async function exportProject(store: ProjectStore, projectId: string, file: string): Promise<ProjectExport> {
  return await store.read((db) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      Record<string, unknown> | undefined;
    if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
    const taskRows = db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY ordinal, created_at, id')
      .all(projectId) as Array<Record<string, unknown>>;
    const tasks = taskRows.map((task) => {
      const taskId = String(task.id);
      const acceptance = (
        db.prepare('SELECT * FROM task_acceptance WHERE task_id = ? ORDER BY position').all(taskId) as Array<
          Record<string, unknown>
        >
      ).map((criterion) => ({
        id: String(criterion.id),
        position: Number(criterion.position),
        description: String(criterion.description),
        kind: criterion.kind === 'human' ? ('human' as const) : ('check' as const),
        required: Number(criterion.required),
        satisfied_at: criterion.satisfied_at === null ? null : String(criterion.satisfied_at),
        satisfied_note: criterion.satisfied_note === null ? null : String(criterion.satisfied_note),
        evidence_id: criterion.evidence_id === null ? null : String(criterion.evidence_id),
      }));
      const steps = (
        db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY position').all(taskId) as Array<
          Record<string, unknown>
        >
      ).map((step) => ({
        id: String(step.id),
        position: Number(step.position),
        title: String(step.title),
        status: String(step.status) as 'pending' | 'running' | 'done' | 'failed',
        detail: step.detail === null ? null : String(step.detail),
        updated_at: String(step.updated_at),
      }));
      const requirements = (
        db
          .prepare(
            'SELECT requirement_id, criterion_id FROM task_requirements WHERE task_id = ? ORDER BY requirement_id, criterion_id',
          )
          .all(taskId) as Array<{ requirement_id: string; criterion_id: string }>
      ).map((requirement) => ({
        requirement_id: requirement.requirement_id,
        criterion_id: requirement.criterion_id,
      }));
      const evidence = (
        db.prepare('SELECT * FROM task_evidence WHERE task_id = ? ORDER BY recorded_at, id').all(taskId) as Array<
          Record<string, unknown>
        >
      ).map((entry) => ({
        id: String(entry.id),
        criterion_id: entry.criterion_id === null ? null : String(entry.criterion_id),
        path: String(entry.path),
        sha256: String(entry.sha256),
        kind: String(entry.kind),
        note: entry.note === null ? null : String(entry.note),
        recorded_at: String(entry.recorded_at),
        stale: Number(entry.stale),
        stale_reason: entry.stale_reason === null ? null : String(entry.stale_reason),
      }));
      return {
        id: taskId,
        title: String(task.title),
        status: String(task.status),
        prompt_id: task.prompt_id === null ? null : String(task.prompt_id),
        created_at: String(task.created_at),
        updated_at: String(task.updated_at),
        description: String(task.description ?? ''),
        execution_owner:
          task.execution_owner === 'native_workflow' ? ('native_workflow' as const) : ('mona_queue' as const),
        prompt_text: String(task.prompt_text ?? ''),
        ordinal: Number(task.ordinal ?? 0),
        current_step: task.current_step === null ? null : String(task.current_step),
        claimed_at: task.claimed_at === null ? null : String(task.claimed_at),
        started_at: task.started_at === null ? null : String(task.started_at),
        last_transition_at: task.last_transition_at === null ? null : String(task.last_transition_at),
        completed_at: task.completed_at === null ? null : String(task.completed_at),
        blocked_reason: task.blocked_reason === null ? null : String(task.blocked_reason),
        skipped_reason: task.skipped_reason === null ? null : String(task.skipped_reason),
        acceptance,
        steps,
        requirements,
        evidence,
      };
    });
    const dependencies = db
      .prepare(
        `SELECT d.task_id, d.depends_on FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.task_id, d.depends_on`,
      )
      .all(projectId) as Array<{ task_id: string; depends_on: string }>;
    const decisions = db
      .prepare('SELECT id, title, body, decided_at FROM decisions WHERE project_id = ? ORDER BY decided_at')
      .all(projectId) as Array<Record<string, unknown>>;

    const document = {
      schema_version: 2 as const,
      kind: 'mona.project-export' as const,
      exported_at: new Date().toISOString(),
      store_revision: store.storeRevision(),
      project: {
        id: String(project.id),
        label: String(project.label),
        canonical_path: String(project.canonical_path),
        repo_kind: String(project.repo_kind),
        shared_repo_key: project.shared_repo_key === null ? null : String(project.shared_repo_key),
        color: project.color === null ? null : String(project.color),
        monogram: project.monogram === null ? null : String(project.monogram),
        pinned: Number(project.pinned),
        archived: Number(project.archived),
        revision: Number(project.revision),
        created_at: String(project.created_at),
        updated_at: String(project.updated_at),
      },
      tasks,
      dependencies,
      decisions: decisions.map((decision) => ({
        id: String(decision.id),
        title: String(decision.title),
        body: String(decision.body),
        decided_at: String(decision.decided_at),
      })),
    };
    const document_ = { ...document, digest: digestOfExport(document) };
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify(document_, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return document_;
  });
}

export type ImportOptions = {
  /** Accept an export whose revision is older than the stored project. */
  allowOlderRevision?: boolean;
};

export type ImportResult = {
  projectId: string;
  importedRevision: number;
  replacedExisting: boolean;
  tasksImported: number;
};

/**
 * Import validates schema, digest, dependencies and completion claims before
 * touching the store, then applies the whole document in one transaction. A
 * task exported while running is imported as interrupted; a machine restart is
 * not evidence that its run is still alive.
 */
export async function importProject(
  store: ProjectStore,
  file: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (!existsSync(file)) throw stateError('not_found', `export file does not exist: ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const parsed = ProjectExport.safeParse(raw);
  if (!parsed.success) {
    throw stateError(
      'invalid_request',
      'export file does not match the project export schema',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const document = parsed.data;
  const { digest, ...body } = document;
  if (digestOfExport(body) !== digest) {
    throw stateError('digest_mismatch', 'export digest does not match its contents');
  }
  validateImport(document);

  return await store.write((tx) => {
    const existing = tx.db.prepare('SELECT * FROM projects WHERE id = ?').get(document.project.id) as
      { revision: number; canonical_path: string } | undefined;
    if (existing && existing.revision > document.project.revision && !options.allowOlderRevision) {
      throw stateError(
        'conflict',
        `local project ${document.project.id} is at revision ${existing.revision}, newer than the import's ${document.project.revision}`,
        'Pass an explicit acceptance to import an older revision.',
      );
    }
    const conflict = tx.db
      .prepare('SELECT id FROM projects WHERE canonical_path = ? AND id <> ?')
      .get(document.project.canonical_path, document.project.id) as { id?: string } | undefined;
    if (conflict?.id) {
      throw stateError('alias_conflict', `path is already registered to project ${conflict.id}`);
    }

    tx.db
      .prepare(
        `INSERT INTO projects(id, label, canonical_path, fs_identity, marker_id, repo_kind, shared_repo_key, color, monogram, pinned, archived, revision, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           canonical_path = excluded.canonical_path,
           repo_kind = excluded.repo_kind,
           shared_repo_key = excluded.shared_repo_key,
           color = excluded.color,
           monogram = excluded.monogram,
           pinned = excluded.pinned,
           archived = excluded.archived,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run(
        document.project.id,
        document.project.label,
        document.project.canonical_path,
        document.project.repo_kind,
        document.project.shared_repo_key,
        document.project.color,
        document.project.monogram,
        document.project.pinned,
        document.project.archived,
        document.project.revision,
        document.project.created_at,
        document.project.updated_at,
      );

    // Child tables are deleted before tasks; foreign keys would cascade, but the
    // explicit order keeps a replace deterministic.
    tx.db
      .prepare('DELETE FROM task_evidence WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db
      .prepare('DELETE FROM task_acceptance WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db
      .prepare('DELETE FROM task_requirements WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db
      .prepare('DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db
      .prepare('DELETE FROM task_transitions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db
      .prepare('DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(document.project.id);
    tx.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(document.project.id);
    for (const task of document.tasks) {
      const status = task.status === 'running' || task.status === 'verifying' ? 'interrupted' : task.status;
      tx.db
        .prepare(
          `INSERT INTO tasks(id, project_id, title, status, prompt_id, description, execution_owner, prompt_text, ordinal,
                             current_step, claimed_at, started_at, last_transition_at, completed_at, blocked_reason,
                             skipped_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          document.project.id,
          task.title,
          status,
          task.prompt_id,
          task.description ?? '',
          task.execution_owner ?? 'mona_queue',
          task.prompt_text ?? '',
          task.ordinal ?? 0,
          task.current_step ?? null,
          task.claimed_at ?? null,
          task.started_at ?? null,
          task.last_transition_at ?? task.updated_at,
          status === 'completed' ? (task.completed_at ?? task.updated_at) : null,
          task.blocked_reason ?? null,
          task.skipped_reason ?? null,
          task.created_at,
          task.updated_at,
        );
      for (const criterion of task.acceptance ?? []) {
        tx.db
          .prepare(
            `INSERT INTO task_acceptance(id, task_id, position, description, kind, required, satisfied_at, satisfied_note, evidence_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            criterion.id,
            task.id,
            criterion.position,
            criterion.description,
            criterion.kind,
            criterion.required,
            criterion.satisfied_at,
            criterion.satisfied_note,
            criterion.evidence_id,
          );
      }
      for (const step of task.steps ?? []) {
        tx.db
          .prepare(
            'INSERT INTO task_steps(id, task_id, position, title, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(step.id, task.id, step.position, step.title, step.status, step.detail, step.updated_at);
      }
      for (const requirement of task.requirements ?? []) {
        tx.db
          .prepare('INSERT INTO task_requirements(task_id, requirement_id, criterion_id) VALUES (?, ?, ?)')
          .run(task.id, requirement.requirement_id, requirement.criterion_id);
      }
      for (const evidence of task.evidence ?? []) {
        tx.db
          .prepare(
            `INSERT INTO task_evidence(id, task_id, criterion_id, path, sha256, kind, note, recorded_at, stale, stale_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidence.id,
            task.id,
            evidence.criterion_id,
            evidence.path,
            evidence.sha256,
            evidence.kind,
            evidence.note,
            evidence.recorded_at,
            evidence.stale,
            evidence.stale_reason,
          );
      }
      tx.db
        .prepare(
          'INSERT INTO task_transitions(id, task_id, from_status, to_status, reason, actor, at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        )
        .run(
          `ttr_${randomUUID().replaceAll('-', '')}`,
          task.id,
          status,
          'imported from project export',
          'import',
          task.updated_at,
        );
    }
    for (const dependency of document.dependencies) {
      tx.db
        .prepare('INSERT INTO task_dependencies(task_id, depends_on) VALUES (?, ?)')
        .run(dependency.task_id, dependency.depends_on);
    }
    tx.db.prepare('DELETE FROM decisions WHERE project_id = ?').run(document.project.id);
    for (const decision of document.decisions) {
      tx.db
        .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
        .run(decision.id, document.project.id, decision.title, decision.body, decision.decided_at);
    }
    tx.bumpRevision();
    return {
      projectId: document.project.id,
      importedRevision: document.project.revision,
      replacedExisting: existing !== undefined,
      tasksImported: document.tasks.length,
    };
  });
}

/**
 * A completed task in an imported document must already satisfy its own
 * required criteria and carry fresh evidence. The importer refuses to launder a
 * completion claim, even when the digest is internally consistent.
 */
function validateImport(document: ProjectExport): void {
  const taskIds = new Set(document.tasks.map((task) => task.id));
  for (const task of document.tasks) {
    if (!TASK_STATUSES.has(task.status)) {
      throw stateError('invalid_request', `task ${task.id} has unknown status ${task.status}`);
    }
    if (task.status === 'completed') {
      const required = (task.acceptance ?? []).filter((criterion) => criterion.required === 1);
      for (const criterion of required) {
        if (criterion.satisfied_at === null) {
          throw stateError(
            'criteria_unsatisfied',
            `task ${task.id} is marked completed but criterion "${criterion.description}" is unsatisfied`,
          );
        }
        if (criterion.evidence_id !== null) {
          const evidence = (task.evidence ?? []).find((entry) => entry.id === criterion.evidence_id);
          if (!evidence) {
            throw stateError(
              'criteria_unsatisfied',
              `task ${task.id} points at missing evidence ${criterion.evidence_id}`,
            );
          }
          if (evidence.stale === 1) {
            throw stateError('criteria_unsatisfied', `task ${task.id} is completed with stale evidence ${evidence.id}`);
          }
        }
      }
    }
  }
  for (const dependency of document.dependencies) {
    if (!taskIds.has(dependency.task_id)) {
      throw stateError('not_found', `dependency records task ${dependency.task_id}, which is not part of the export`);
    }
    if (!taskIds.has(dependency.depends_on)) {
      throw stateError(
        'not_found',
        `task ${dependency.task_id} depends on ${dependency.depends_on}, which is not part of the export`,
      );
    }
  }
  // Cycles are rejected before the graph reaches SQLite.
  const edges = new Map<string, string[]>();
  for (const dependency of document.dependencies) {
    const list = edges.get(dependency.task_id) ?? [];
    list.push(dependency.depends_on);
    edges.set(dependency.task_id, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) throw stateError('dependency_cycle', `dependency cycle detected at task ${node}`);
    visiting.add(node);
    for (const next of edges.get(node) ?? []) visit(next);
    visiting.delete(node);
    done.add(node);
  };
  for (const node of edges.keys()) visit(node);
}
