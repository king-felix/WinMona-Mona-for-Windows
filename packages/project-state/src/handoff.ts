import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stateError } from './errors.js';
import { looksLikeSecretPath, redactSecretText } from './redaction.js';
import type { ProjectStore } from './store.js';

/**
 * Portable handoff and resume packets.
 *
 * The bundle deliberately carries no machine-local bindings: no runtime
 * endpoint, pid, token digest, engine thread id, absolute project path or
 * engine-owned conversation. An import requires a folder on this machine, makes
 * that folder the project binding, and reconstructs task, decision and evidence
 * pointers without starting the engine, claiming a task or submitting a turn.
 *
 * Selected files may travel inside the bundle. They are extracted only by an
 * explicit call, and every member path is validated before anything is written.
 */

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_FILES = 200;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A bundle member path must stay inside the extraction root on every platform.
 * Rejecting absolute paths, drive letters, UNC prefixes, traversal and Windows
 * device names here means a malicious bundle cannot be imported at all.
 */
export function assertSafeRelativePath(candidate: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw stateError('invalid_request', 'A bundle member path is required.');
  }
  if (candidate.length > 240) {
    throw stateError('invalid_request', 'A bundle member path is longer than 240 characters.');
  }
  if (hasControlCharacter(candidate)) {
    throw stateError('invalid_request', 'A bundle member path contains a control character.');
  }
  if (candidate.includes('\\')) {
    throw stateError('invalid_request', 'Bundle member paths use forward slashes, not backslashes.');
  }
  if (candidate.startsWith('/') || candidate.startsWith('//') || /^[A-Za-z]:/.test(candidate)) {
    throw stateError('invalid_request', 'A bundle member path must be relative.');
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw stateError('invalid_request', 'A bundle member path may not escape the extraction root.');
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw stateError('invalid_request', 'A bundle member path contains an empty or relative segment.');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw stateError('invalid_request', 'A bundle member path segment may not end with a dot or space.');
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw stateError('invalid_request', 'A bundle member path uses a reserved Windows name.');
    }
    if (segment.includes(':')) {
      throw stateError('invalid_request', 'A bundle member path may not contain a drive or stream separator.');
    }
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const PortableFile = z
  .object({
    path: z.string().min(1).max(240),
    mediaType: z.string().min(1).max(120),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string().max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4),
  })
  .strict();
export type PortableFile = z.infer<typeof PortableFile>;

const PortableProject = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    repoKind: z.string().min(1),
    color: z.string().nullable(),
    monogram: z.string().nullable(),
  })
  .strict();

const PortableCriterion = z
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

const PortableStep = z
  .object({
    id: z.string().min(1),
    position: z.number().int().nonnegative(),
    title: z.string().min(1),
    status: z.enum(['pending', 'running', 'done', 'failed']),
    detail: z.string().nullable(),
    updated_at: z.string().min(1),
  })
  .strict();

const PortableEvidence = z
  .object({
    id: z.string().min(1),
    criterion_id: z.string().nullable(),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.string().min(1),
    note: z.string().nullable(),
    recorded_at: z.string().min(1),
  })
  .strict();

const PortableTask = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    promptId: z.string().nullable(),
    description: z.string(),
    executionOwner: z.enum(['mona_queue', 'native_workflow']),
    promptText: z.string(),
    ordinal: z.number().int().nonnegative(),
    currentStep: z.string().nullable(),
    blockedReason: z.string().nullable(),
    skippedReason: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    acceptance: z.array(PortableCriterion),
    steps: z.array(PortableStep),
    requirements: z.array(z.object({ requirementId: z.string(), criterionId: z.string() }).strict()),
    evidence: z.array(PortableEvidence),
  })
  .strict();

const PortableDecision = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    decidedAt: z.string().min(1),
  })
  .strict();

const PortableRequirementEvidence = z
  .object({
    id: z.string().min(1),
    requirementId: z.string().min(1),
    criterionId: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.string().min(1),
    note: z.string().nullable(),
    recordedAt: z.string().min(1),
  })
  .strict();

const PortableResume = z
  .object({
    nextTaskId: z.string().nullable(),
    nextStepId: z.string().nullable(),
    counts: z
      .object({
        tasks: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        interrupted: z.number().int().nonnegative(),
      })
      .strict(),
    blocked: z.array(z.object({ taskId: z.string(), title: z.string(), reason: z.string() }).strict()),
    spend: z
      .object({
        knownMicros: z.number().int().nonnegative(),
        unknownRecords: z.number().int().nonnegative(),
        confidence: z.enum(['none', 'known', 'partial', 'unknown']),
      })
      .strict(),
    nextAction: z.string(),
  })
  .strict();

export const PortableBundle = z
  .object({
    schema_version: z.literal(1),
    kind: z.enum(['mona.handoff', 'mona.resume-packet']),
    exported_at: z.string().min(1),
    storeSchemaVersion: z.number().int().nonnegative(),
    project: PortableProject,
    resume: PortableResume,
    tasks: z.array(PortableTask),
    dependencies: z.array(z.object({ taskId: z.string(), dependsOn: z.string() }).strict()),
    decisions: z.array(PortableDecision),
    requirementEvidence: z.array(PortableRequirementEvidence),
    files: z.array(PortableFile).max(MAX_BUNDLE_FILES),
    /** What this format intentionally cannot carry. */
    notTransferred: z.array(z.string()),
    /** sha256 over the canonical JSON of everything except this field. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PortableBundle = z.infer<typeof PortableBundle>;

const TASK_STATUSES = new Set(['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped']);

const NOT_TRANSFERRED = [
  'Engine-owned thread and turn history (Codewhale remains its authority).',
  'Runtime bindings: endpoint, pid, process identity and token digest.',
  'Provider credentials and environment variables.',
  'The absolute project path and filesystem identity; the importing machine must choose a folder.',
  'Artifacts that were not explicitly selected for inclusion.',
  'Mona UI state: drafts, layout, prompt shelf and notification preferences.',
];

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

export function digestOfPortable(document: Omit<PortableBundle, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

export type PortableExportOptions = {
  file: string;
  kind?: 'mona.handoff' | 'mona.resume-packet';
  /** Project-relative files the human explicitly selected. */
  includeFiles?: readonly string[];
  now?: Date;
};

/**
 * Export one project as a portable bundle. No repository content is included
 * unless a path was explicitly selected, and a credential-shaped file is
 * refused even when selected.
 */
export async function exportPortable(
  store: ProjectStore,
  projectId: string,
  options: PortableExportOptions,
): Promise<PortableBundle> {
  const kind = options.kind ?? 'mona.handoff';
  const now = (options.now ?? new Date()).toISOString();
  const document = await store.read((db) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      Record<string, unknown> | undefined;
    if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
    const projectRoot = String(project.canonical_path);

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
        description: redactSecretText(String(criterion.description)),
        kind: criterion.kind === 'human' ? ('human' as const) : ('check' as const),
        required: Number(criterion.required),
        satisfied_at: criterion.satisfied_at === null ? null : String(criterion.satisfied_at),
        satisfied_note: criterion.satisfied_note === null ? null : redactSecretText(String(criterion.satisfied_note)),
        evidence_id: criterion.evidence_id === null ? null : String(criterion.evidence_id),
      }));
      const steps = (
        db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY position').all(taskId) as Array<
          Record<string, unknown>
        >
      ).map((step) => ({
        id: String(step.id),
        position: Number(step.position),
        title: redactSecretText(String(step.title)),
        status: String(step.status) as 'pending' | 'running' | 'done' | 'failed',
        detail: step.detail === null ? null : redactSecretText(String(step.detail)),
        updated_at: String(step.updated_at),
      }));
      const requirements = (
        db
          .prepare(
            'SELECT requirement_id, criterion_id FROM task_requirements WHERE task_id = ? ORDER BY requirement_id, criterion_id',
          )
          .all(taskId) as Array<{ requirement_id: string; criterion_id: string }>
      ).map((entry) => ({ requirementId: entry.requirement_id, criterionId: entry.criterion_id }));
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
        note: entry.note === null ? null : redactSecretText(String(entry.note)),
        recorded_at: String(entry.recorded_at),
      }));
      return {
        id: taskId,
        title: String(task.title),
        status: String(task.status),
        promptId: task.prompt_id === null ? null : String(task.prompt_id),
        description: redactSecretText(String(task.description ?? '')),
        executionOwner:
          task.execution_owner === 'native_workflow' ? ('native_workflow' as const) : ('mona_queue' as const),
        promptText: redactSecretText(String(task.prompt_text ?? '')),
        ordinal: Number(task.ordinal ?? 0),
        currentStep: task.current_step === null ? null : String(task.current_step),
        blockedReason: task.blocked_reason === null ? null : redactSecretText(String(task.blocked_reason)),
        skippedReason: task.skipped_reason === null ? null : redactSecretText(String(task.skipped_reason)),
        createdAt: String(task.created_at),
        updatedAt: String(task.updated_at),
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
      .prepare('SELECT id, title, body, decided_at FROM decisions WHERE project_id = ? ORDER BY decided_at, id')
      .all(projectId) as Array<Record<string, unknown>>;
    const requirementEvidence = db
      .prepare(
        `SELECT id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at
           FROM requirement_evidence WHERE project_id = ? ORDER BY recorded_at, id`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    const usage = db
      .prepare(
        `SELECT COUNT(*) AS records, COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_micros ELSE 0 END), 0) AS known,
                COALESCE(SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END), 0) AS unknown
           FROM usage_records WHERE project_id = ?`,
      )
      .get(projectId) as { records: number; known: number; unknown: number };

    const files = kind === 'mona.handoff' ? collectFiles(projectRoot, options.includeFiles ?? []) : [];
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const blocked = tasks.filter((task) => task.status === 'blocked');
    const interrupted = tasks.filter((task) => task.status === 'interrupted').length;
    const next =
      tasks.find((task) => task.status === 'running' || task.status === 'verifying') ??
      tasks.find((task) => task.status === 'interrupted') ??
      tasks.find((task) => task.status === 'pending') ??
      null;
    const known = Number(usage.known);
    const unknown = Number(usage.unknown);
    const confidence: 'none' | 'known' | 'partial' | 'unknown' =
      known <= 0 && unknown === 0 ? 'none' : unknown === 0 ? 'known' : known > 0 ? 'partial' : 'unknown';

    return {
      schema_version: 1 as const,
      kind,
      exported_at: now,
      storeSchemaVersion: schemaVersionOf(db),
      project: {
        id: String(project.id),
        label: String(project.label),
        repoKind: String(project.repo_kind),
        color: project.color === null ? null : String(project.color),
        monogram: project.monogram === null ? null : String(project.monogram),
      },
      resume: {
        nextTaskId: next?.id ?? null,
        nextStepId: next ? next.currentStep : null,
        counts: { tasks: tasks.length, completed, blocked: blocked.length, interrupted },
        blocked: blocked.map((task) => ({
          taskId: task.id,
          title: task.title,
          reason: task.blockedReason ?? 'Blocked; no reason recorded.',
        })),
        spend: { knownMicros: known, unknownRecords: unknown, confidence },
        nextAction:
          next === null
            ? 'No open task. Review the imported decisions and evidence before starting new work.'
            : `Reconcile task ${next.id} ("${next.title}") from the recorded step, then continue. Import does not execute it.`,
      },
      tasks,
      dependencies: dependencies.map((entry) => ({ taskId: entry.task_id, dependsOn: entry.depends_on })),
      decisions: decisions.map((decision) => ({
        id: String(decision.id),
        title: redactSecretText(String(decision.title)),
        body: redactSecretText(String(decision.body)),
        decidedAt: String(decision.decided_at),
      })),
      requirementEvidence: requirementEvidence.map((entry) => ({
        id: String(entry.id),
        requirementId: String(entry.requirement_id),
        criterionId: String(entry.criterion_id),
        path: String(entry.path),
        sha256: String(entry.sha256),
        kind: String(entry.kind),
        note: entry.note === null ? null : redactSecretText(String(entry.note)),
        recordedAt: String(entry.recorded_at),
      })),
      files,
      notTransferred: NOT_TRANSFERRED,
    };
  });

  const withDigest: PortableBundle = { ...document, digest: digestOfPortable(document) };
  writeJsonAtomically(options.file, withDigest);
  return withDigest;
}

function collectFiles(projectRoot: string, selected: readonly string[]): PortableFile[] {
  if (selected.length > MAX_BUNDLE_FILES) {
    throw stateError('oversize', `A handoff may include at most ${MAX_BUNDLE_FILES} files.`);
  }
  const files: PortableFile[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const candidate of selected) {
    const relative = assertSafeRelativePath(candidate.replaceAll('\\', '/'));
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (looksLikeSecretPath(relative)) {
      throw stateError('invalid_request', `Refusing to include credential-shaped file ${relative}.`);
    }
    const absolute = path.resolve(projectRoot, relative);
    const inside = path.relative(projectRoot, absolute);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw stateError('invalid_request', `File ${relative} is outside the project folder.`);
    }
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      throw stateError('not_found', `Selected file does not exist: ${relative}`);
    }
    if (!stat.isFile()) throw stateError('invalid_request', `Selected path is not a file: ${relative}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw stateError('oversize', `Selected file ${relative} is ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}.`);
    }
    const buffer = readFileSync(absolute);
    total += buffer.byteLength;
    if (total > MAX_TOTAL_FILE_BYTES) {
      throw stateError('oversize', `Selected files exceed the ${MAX_TOTAL_FILE_BYTES}-byte bundle limit.`);
    }
    const text = buffer.includes(0) ? null : buffer.toString('utf8');
    const roundTrip = text === null ? null : Buffer.from(text, 'utf8');
    const isText = text !== null && roundTrip !== null && roundTrip.equals(buffer);
    files.push({
      path: relative,
      mediaType: isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.byteLength,
      encoding: isText ? 'utf8' : 'base64',
      content: isText ? (text as string) : buffer.toString('base64'),
    });
  }
  return files;
}

/** Extracted members, written only by an explicit call with a validated root. */
export function extractPortableFiles(
  document: PortableBundle,
  root: string,
): { root: string; written: Array<{ path: string; sha256: string; bytes: number }> } {
  const resolvedRoot = path.resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  const written: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const file of document.files) {
    const relative = assertSafeRelativePath(file.path);
    const target = path.resolve(resolvedRoot, relative);
    const inside = path.relative(resolvedRoot, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw stateError('invalid_request', `Bundle member ${relative} would escape the extraction root.`);
    }
    const buffer = file.encoding === 'utf8' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content, 'base64');
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== file.sha256 || buffer.byteLength !== file.bytes) {
      throw stateError('digest_mismatch', `Bundle member ${relative} does not match its recorded digest.`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    try {
      writeFileSync(target, buffer, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw stateError('conflict', `Bundle member ${relative} already exists at the extraction root.`);
      }
      throw error;
    }
    written.push({ path: relative, sha256: digest, bytes: buffer.byteLength });
  }
  return { root: resolvedRoot, written };
}

export type PortableImportOptions = {
  /** A folder on this machine; the imported project binds here, not to a path in the bundle. */
  targetFolder: string;
  /** Replace tasks and decisions of an existing non-empty project. Default false. */
  replaceExisting?: boolean;
  /** Verify evidence artifact digests during import. Default true. */
  verifyEvidence?: boolean;
};

export type PortableImportReport = {
  kind: 'mona.handoff' | 'mona.resume-packet';
  sourceProjectId: string;
  projectId: string;
  projectLabel: string;
  targetFolder: string;
  tasksImported: number;
  decisionsImported: number;
  requirementEvidenceImported: number;
  evidenceChecked: number;
  missingFiles: string[];
  staleEvidence: Array<{ taskId: string; evidenceId: string; path: string; reason: string }>;
  reopenedTasks: Array<{ taskId: string; reason: string }>;
  requalified: true;
  filesExtracted: 0;
  autoExecuted: false;
  notTransferred: string[];
};

/**
 * Import a handoff or resume packet. The document validates before the store is
 * touched. Tasks are written inert: nothing is claimed, dispatched or sent, and
 * evidence whose file is missing or changed is marked stale instead of trusted.
 */
export async function importPortable(
  store: ProjectStore,
  file: string,
  options: PortableImportOptions,
): Promise<PortableImportReport> {
  if (!existsSync(file)) throw stateError('not_found', `bundle file does not exist: ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const document = parsePortableBundle(raw);
  if (!existsSync(options.targetFolder) || !statSync(options.targetFolder).isDirectory()) {
    throw stateError('not_found', `target folder does not exist: ${options.targetFolder}`);
  }

  const outcome = await store.registerProject(options.targetFolder);
  if (outcome.status === 'relocation_required') {
    throw stateError('relocation_required', outcome.reason, outcome.observedPath);
  }
  const project = outcome.project;
  const existing = await store.read((db) => {
    const tasks = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(project.id) as {
      count: number;
    };
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE project_id = ?').get(project.id) as {
      count: number;
    };
    return Number(tasks.count) + Number(decisions.count);
  });
  if (existing > 0 && options.replaceExisting !== true) {
    throw stateError(
      'conflict',
      `${project.label} already has recorded work; import would replace it`,
      'Choose an empty folder, or explicitly allow replacing this project’s tasks and decisions.',
    );
  }

  const taskIds = new Set(document.tasks.map((task) => task.id));
  const root = project.canonicalPath;
  const missingFiles: string[] = [];
  const staleEvidence: PortableImportReport['staleEvidence'] = [];
  const reopenedTasks: PortableImportReport['reopenedTasks'] = [];
  const evidenceState = new Map<string, { stale: boolean; reason: string | null; missing: boolean }>();
  let evidenceChecked = 0;

  for (const task of document.tasks) {
    for (const evidence of task.evidence) {
      evidenceChecked += 1;
      const relative = safeEvidencePath(evidence.path);
      const absolute = path.resolve(root, relative);
      let state: { stale: boolean; reason: string | null; missing: boolean };
      try {
        const stat = statSync(absolute);
        if (!stat.isFile()) throw new Error('not a file');
        const actual =
          options.verifyEvidence === false ? null : createHash('sha256').update(readFileSync(absolute)).digest('hex');
        if (actual !== null && actual !== evidence.sha256) {
          state = {
            stale: true,
            missing: false,
            reason: `artifact ${relative} changed on this machine; its recorded evidence is stale`,
          };
        } else {
          state = { stale: false, missing: false, reason: null };
        }
      } catch {
        state = {
          stale: true,
          missing: true,
          reason: `artifact ${relative} is missing on this machine; its recorded evidence is stale`,
        };
        missingFiles.push(relative);
      }
      evidenceState.set(evidence.id, state);
      if (state.stale) {
        staleEvidence.push({
          taskId: task.id,
          evidenceId: evidence.id,
          path: relative,
          reason: state.reason ?? 'evidence is stale',
        });
      }
    }
  }

  const statuses = new Map<string, string>();
  for (const task of document.tasks) {
    if (!TASK_STATUSES.has(task.status)) {
      throw stateError('invalid_request', `task ${task.id} has unknown status ${task.status}`);
    }
    let status = task.status === 'running' || task.status === 'verifying' ? 'interrupted' : task.status;
    if (status === 'completed') {
      const required = task.acceptance.filter((criterion) => criterion.required === 1);
      for (const criterion of required) {
        if (criterion.satisfied_at === null) {
          throw stateError(
            'criteria_unsatisfied',
            `task ${task.id} is marked completed but criterion "${criterion.description}" is unsatisfied`,
          );
        }
        if (criterion.evidence_id !== null) {
          const evidence = task.evidence.find((entry) => entry.id === criterion.evidence_id);
          if (!evidence) {
            throw stateError('not_found', `task ${task.id} points at missing evidence ${criterion.evidence_id}`);
          }
          if (evidenceState.get(criterion.evidence_id)?.stale) {
            status = 'verifying';
            if (!reopenedTasks.some((entry) => entry.taskId === task.id)) {
              reopenedTasks.push({
                taskId: task.id,
                reason: `required evidence ${criterion.evidence_id} is stale on this machine; completion was not carried over`,
              });
            }
          }
        }
      }
    }
    statuses.set(task.id, status);
  }

  for (const dependency of document.dependencies) {
    if (!taskIds.has(dependency.taskId) || !taskIds.has(dependency.dependsOn)) {
      throw stateError('not_found', 'a dependency names a task that is not part of the bundle');
    }
  }
  assertNoDependencyCycle(document.dependencies.map((entry) => [entry.taskId, entry.dependsOn] as const));

  const report = await store.write((tx) => {
    const foreign = document.tasks
      .map((task) => task.id)
      .filter((id) => {
        const row = tx.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as
          { project_id: string } | undefined;
        return row !== undefined && row.project_id !== project.id;
      });
    if (foreign.length > 0) {
      throw stateError(
        'conflict',
        `task ids in the bundle already belong to another project: ${foreign.slice(0, 5).join(', ')}`,
      );
    }

    tx.db
      .prepare('DELETE FROM task_evidence WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db
      .prepare('DELETE FROM task_acceptance WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db
      .prepare('DELETE FROM task_requirements WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db
      .prepare('DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db
      .prepare('DELETE FROM task_transitions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db
      .prepare('DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)')
      .run(project.id);
    tx.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id);
    tx.db.prepare('DELETE FROM decisions WHERE project_id = ?').run(project.id);
    tx.db.prepare('DELETE FROM requirement_evidence WHERE project_id = ?').run(project.id);

    for (const task of document.tasks) {
      const status = statuses.get(task.id) ?? 'interrupted';
      tx.db
        .prepare(
          `INSERT INTO tasks(id, project_id, title, status, prompt_id, description, execution_owner, prompt_text, ordinal,
                             current_step, claimed_at, started_at, last_transition_at, completed_at, blocked_reason,
                             skipped_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          project.id,
          task.title,
          status,
          task.promptId,
          task.description,
          task.executionOwner,
          task.promptText,
          task.ordinal,
          task.currentStep,
          task.updatedAt,
          status === 'completed' ? task.updatedAt : null,
          task.blockedReason,
          task.skippedReason,
          task.createdAt,
          task.updatedAt,
        );
      for (const criterion of task.acceptance) {
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
      for (const step of task.steps) {
        tx.db
          .prepare(
            'INSERT INTO task_steps(id, task_id, position, title, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(step.id, task.id, step.position, step.title, step.status, step.detail, step.updated_at);
      }
      for (const requirement of task.requirements) {
        tx.db
          .prepare('INSERT INTO task_requirements(task_id, requirement_id, criterion_id) VALUES (?, ?, ?)')
          .run(task.id, requirement.requirementId, requirement.criterionId);
      }
      for (const evidence of task.evidence) {
        const state = evidenceState.get(evidence.id);
        tx.db
          .prepare(
            `INSERT INTO task_evidence(id, task_id, criterion_id, path, sha256, kind, note, recorded_at, stale, stale_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidence.id,
            task.id,
            evidence.criterion_id,
            safeEvidencePath(evidence.path),
            evidence.sha256,
            evidence.kind,
            evidence.note,
            evidence.recorded_at,
            state?.stale ? 1 : 0,
            state?.reason ?? null,
          );
      }
      tx.db
        .prepare(
          'INSERT INTO task_transitions(id, task_id, from_status, to_status, reason, actor, at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        )
        .run(
          `ttr_${randomId()}`,
          task.id,
          status,
          status === 'interrupted'
            ? 'imported from a portable bundle; a previous run is not evidence it is alive'
            : 'imported from a portable bundle',
          'import',
          task.updatedAt,
        );
    }
    for (const dependency of document.dependencies) {
      tx.db
        .prepare('INSERT INTO task_dependencies(task_id, depends_on) VALUES (?, ?)')
        .run(dependency.taskId, dependency.dependsOn);
    }
    for (const decision of document.decisions) {
      tx.db
        .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
        .run(decision.id, project.id, decision.title, decision.body, decision.decidedAt);
    }
    for (const entry of document.requirementEvidence) {
      tx.db
        .prepare(
          `INSERT INTO requirement_evidence(id, project_id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          project.id,
          entry.requirementId,
          entry.criterionId,
          safeEvidencePath(entry.path),
          entry.sha256,
          entry.kind,
          entry.note,
          entry.recordedAt,
        );
    }
    tx.bumpRevision();
    return {
      kind: document.kind,
      sourceProjectId: document.project.id,
      projectId: project.id,
      projectLabel: project.label,
      targetFolder: root,
      tasksImported: document.tasks.length,
      decisionsImported: document.decisions.length,
      requirementEvidenceImported: document.requirementEvidence.length,
      evidenceChecked,
      missingFiles,
      staleEvidence,
      reopenedTasks,
      requalified: true as const,
      filesExtracted: 0 as const,
      autoExecuted: false as const,
      notTransferred: document.notTransferred,
    };
  });
  return report;
}

export function parsePortableBundle(raw: unknown): PortableBundle {
  const parsed = PortableBundle.safeParse(raw);
  if (!parsed.success) {
    throw stateError(
      'invalid_request',
      'The file is not a Mona portable handoff.',
      parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  const { digest, ...body } = parsed.data;
  if (digestOfPortable(body) !== digest) {
    throw stateError('digest_mismatch', 'The handoff digest does not match its contents.');
  }
  for (const file of parsed.data.files) assertSafeRelativePath(file.path);
  for (const task of parsed.data.tasks) {
    if (!TASK_STATUSES.has(task.status)) {
      throw stateError('invalid_request', `task ${task.id} has unknown status ${task.status}`);
    }
    for (const evidence of task.evidence) safeEvidencePath(evidence.path);
  }
  for (const entry of parsed.data.requirementEvidence) safeEvidencePath(entry.path);
  return parsed.data;
}

function safeEvidencePath(candidate: string): string {
  const normalized = candidate.replaceAll('\\', '/');
  if (path.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
    throw stateError('invalid_request', 'evidence paths in a bundle must be project-relative');
  }
  const resolved = path.posix.normalize(normalized);
  if (resolved === '.' || resolved.startsWith('../') || resolved === '..' || resolved.startsWith('/')) {
    throw stateError('invalid_request', 'an evidence path in a bundle may not escape the project folder');
  }
  return resolved;
}

function assertNoDependencyCycle(edges: ReadonlyArray<readonly [string, string]>): void {
  const map = new Map<string, string[]>();
  for (const [task, dependsOn] of edges) {
    const list = map.get(task) ?? [];
    list.push(dependsOn);
    map.set(task, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) throw stateError('dependency_cycle', `dependency cycle detected at task ${node}`);
    visiting.add(node);
    for (const next of map.get(node) ?? []) visit(next);
    visiting.delete(node);
    done.add(node);
  };
  for (const node of map.keys()) visit(node);
}

function schemaVersionOf(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version?: number | null } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch {
    return 0;
  }
}

function randomId(): string {
  return randomUUID().replaceAll('-', '');
}

function writeJsonAtomically(file: string, document: unknown): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}
