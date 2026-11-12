import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stateError } from './errors.js';
import { looksLikeSecretPath, redactText } from './redaction.js';
import type { ProjectStore } from './store.js';

/**
 * Local project memory.
 *
 * Two different operations live here on purpose:
 *
 * - `reindexProject` / `search` cover explicitly indexed project metadata,
 *   decisions, task evidence and bounded history projections. The index is a
 *   deterministic term table in SQLite. No embedding service, model call or
 *   background inference is involved, and a project that was never indexed
 *   reports `indexed: false` rather than pretending to have results.
 * - `searchFiles` walks the project folder on demand and returns only matches.
 *   It never copies repository contents into the database, never follows
 *   symlinks, refuses credential-shaped files and binary content, and writes
 *   nothing.
 */

export type MemoryKind =
  'project' | 'decision' | 'task' | 'evidence' | 'requirement' | 'problem' | 'attempt' | 'timeline';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'project',
  'decision',
  'task',
  'evidence',
  'requirement',
  'problem',
  'attempt',
  'timeline',
];

export type MemoryRetention = 'ephemeral' | 'task' | 'evidence' | 'permanent';

export type MemoryPolicy = {
  /** Only documents with these retention classes are indexed. */
  retention: readonly MemoryRetention[];
  includeTimeline: boolean;
  includeAttempts: boolean;
  /** Newest timeline items considered; the rest stay out of the index. */
  timelineLimit: number;
};

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  retention: ['task', 'evidence', 'permanent'],
  includeTimeline: true,
  includeAttempts: true,
  timelineLimit: 400,
};

export type MemoryIndexReport = {
  projectId: string;
  documents: number;
  terms: number;
  byKind: Record<MemoryKind, number>;
  /** Documents whose text changed during redaction before indexing. */
  redacted: number;
  skippedByRetention: number;
  timelineIncluded: number;
  indexedAt: string;
};

export type MemoryHit = {
  docId: string;
  kind: MemoryKind;
  refId: string;
  title: string;
  snippet: string;
  score: number;
  retention: MemoryRetention;
  redacted: boolean;
  indexedAt: string;
};

export type MemorySearchResult = {
  projectId: string;
  query: string;
  terms: string[];
  /** False when this project was never indexed (or the index is empty). */
  indexed: boolean;
  hits: MemoryHit[];
  truncated: boolean;
  documents: number;
};

export type MemoryStats = {
  projectId: string;
  documents: number;
  distinctTerms: number;
  byKind: Record<MemoryKind, number>;
  lastIndexedAt: string | null;
};

export type FileSearchResult = {
  projectId: string;
  query: string;
  hits: Array<{ path: string; line: number; snippet: string }>;
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
  /** Files skipped because they are credential-shaped or binary. */
  skipped: { secretPath: number; binary: number; oversize: number };
};

export type FileSearchOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxResults?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
};

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.mona',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  'target',
  'vendor',
  '__pycache__',
]);

const SKIPPED_TIMELINE_KINDS = new Set(['status']);

const MAX_TERMS_PER_DOCUMENT = 4_000;
const MAX_TERM_LENGTH = 64;

const KIND_RETENTION: Record<MemoryKind, MemoryRetention> = {
  project: 'permanent',
  decision: 'permanent',
  task: 'task',
  evidence: 'evidence',
  requirement: 'evidence',
  problem: 'evidence',
  attempt: 'evidence',
  timeline: 'task',
};

type DocumentDraft = {
  kind: MemoryKind;
  refId: string;
  title: string;
  body: string;
  retention: MemoryRetention;
};

type DocumentRow = {
  doc_id: string;
  kind: string;
  ref_id: string;
  title: string;
  body: string;
  retention: string;
  redacted: number;
  indexed_at: string;
};

/**
 * Lowercase, deterministic tokenizer. Words keep internal apostrophes and
 * dashes; CJK characters become one term each so a two-character query still
 * intersects. No stemming and no dictionary means the same query gives the same
 * answer on every machine.
 */
export function tokenizeForSearch(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9][a-z0-9_'’-]*/g) ?? [];
  const cjk = lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    const term = word.replace(/['’-]+$/g, '').slice(0, MAX_TERM_LENGTH);
    if (term.length >= 2) terms.push(term);
  }
  // Single CJK characters are meaningful; `terms.slice` bounds the document.
  terms.push(...cjk.slice(0, MAX_TERMS_PER_DOCUMENT));
  return terms.slice(0, MAX_TERMS_PER_DOCUMENT);
}

function queryTerms(query: string): string[] {
  const terms = tokenizeForSearch(query.trim());
  return [...new Set(terms)].slice(0, 12);
}

function stableDocId(projectId: string, kind: MemoryKind, refId: string): string {
  return `mem_${createHash('sha256').update(`${projectId}\u0000${kind}\u0000${refId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function digestOf(draft: DocumentDraft): string {
  return createHash('sha256').update(`${draft.kind}\u0000${draft.title}\u0000${draft.body}`, 'utf8').digest('hex');
}

export class MemoryIndex {
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
  }

  /**
   * Rebuild one project's index from state that is permitted to be searched.
   * The whole rebuild is one transaction: a reader never sees a half index.
   */
  async reindexProject(projectId: string, policy: MemoryPolicy = DEFAULT_MEMORY_POLICY): Promise<MemoryIndexReport> {
    return await this.store.write((tx) => {
      const project = tx.db.prepare('SELECT id, label, repo_kind FROM projects WHERE id = ?').get(projectId) as
        { id: string; label: string; repo_kind: string } | undefined;
      if (!project) throw stateError('not_found', `project ${projectId} does not exist`);

      const drafts = this.collectDocuments(tx.db, projectId, project, policy);
      const now = tx.now();
      tx.db
        .prepare('DELETE FROM memory_terms WHERE doc_id IN (SELECT doc_id FROM memory_documents WHERE project_id = ?)')
        .run(projectId);
      tx.db.prepare('DELETE FROM memory_documents WHERE project_id = ?').run(projectId);

      const insertDoc = tx.db.prepare(
        `INSERT INTO memory_documents(doc_id, project_id, kind, ref_id, title, body, retention, source_digest, redacted, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertTerm = tx.db.prepare('INSERT OR REPLACE INTO memory_terms(term, doc_id, weight) VALUES (?, ?, ?)');

      const byKind = emptyKindCounts();
      let redacted = 0;
      let terms = 0;
      const indexed = new Set<string>();
      for (const draft of drafts) {
        if (!policy.retention.includes(draft.retention)) continue;
        const docId = stableDocId(projectId, draft.kind, draft.refId);
        if (indexed.has(docId)) continue;
        indexed.add(docId);
        const titleReport = redactText(draft.title);
        const bodyReport = redactText(draft.body);
        const wasRedacted = titleReport.redactions + bodyReport.redactions > 0;
        if (wasRedacted) redacted += 1;
        insertDoc.run(
          docId,
          projectId,
          draft.kind,
          draft.refId,
          titleReport.text,
          bodyReport.text,
          draft.retention,
          digestOf(draft),
          wasRedacted ? 1 : 0,
          now,
        );
        for (const [term, weight] of weightsFor(titleReport.text, bodyReport.text)) {
          insertTerm.run(term, docId, weight);
          terms += 1;
        }
        byKind[draft.kind] += 1;
      }

      return {
        projectId,
        documents: indexed.size,
        terms,
        byKind,
        redacted,
        skippedByRetention: drafts.length - indexed.size,
        timelineIncluded: byKind.timeline,
        indexedAt: now,
      };
    });
  }

  async search(projectId: string, query: string, options: { limit?: number } = {}): Promise<MemorySearchResult> {
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
    const terms = queryTerms(query);
    return await this.store.read((db) => {
      const total = db
        .prepare('SELECT COUNT(*) AS count FROM memory_documents WHERE project_id = ?')
        .get(projectId) as {
        count: number;
      };
      const documents = Number(total.count);
      if (terms.length === 0) {
        return { projectId, query, terms, indexed: documents > 0, hits: [], truncated: false, documents };
      }
      const matching = new Set<string>();
      const scores = new Map<string, number>();
      for (const term of terms) {
        const rows = db
          .prepare(
            `SELECT t.doc_id AS doc_id, MAX(t.weight) AS weight
               FROM memory_terms t
               JOIN memory_documents d ON d.doc_id = t.doc_id
              WHERE t.term = ? AND d.project_id = ?
              GROUP BY t.doc_id`,
          )
          .all(term, projectId) as Array<{ doc_id: string; weight: number }>;
        const seen = new Set(rows.map((row) => row.doc_id));
        if (matching.size === 0) {
          for (const row of rows) matching.add(row.doc_id);
        } else {
          for (const id of [...matching]) if (!seen.has(id)) matching.delete(id);
        }
        for (const row of rows) scores.set(row.doc_id, (scores.get(row.doc_id) ?? 0) + Number(row.weight));
        if (matching.size === 0) break;
      }
      const ordered = [...matching]
        .map((docId) => ({ docId, score: scores.get(docId) ?? 0 }))
        .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
      const page = ordered.slice(0, limit);
      const hits: MemoryHit[] = [];
      for (const entry of page) {
        const row = db.prepare('SELECT * FROM memory_documents WHERE doc_id = ?').get(entry.docId) as
          DocumentRow | undefined;
        if (!row) continue;
        hits.push({
          docId: row.doc_id,
          kind: row.kind as MemoryKind,
          refId: row.ref_id,
          title: row.title,
          snippet: snippetFor(row.title, row.body, terms),
          score: entry.score,
          retention: row.retention as MemoryRetention,
          redacted: Number(row.redacted) === 1,
          indexedAt: row.indexed_at,
        });
      }
      return {
        projectId,
        query,
        terms,
        indexed: documents > 0,
        hits,
        truncated: ordered.length > hits.length,
        documents,
      };
    });
  }

  async stats(projectId: string): Promise<MemoryStats> {
    return await this.store.read((db) => {
      const byKind = emptyKindCounts();
      const rows = db
        .prepare('SELECT kind, COUNT(*) AS count FROM memory_documents WHERE project_id = ? GROUP BY kind')
        .all(projectId) as Array<{ kind: string; count: number }>;
      for (const row of rows) {
        if (MEMORY_KINDS.includes(row.kind as MemoryKind)) byKind[row.kind as MemoryKind] = Number(row.count);
      }
      const terms = db
        .prepare(
          'SELECT COUNT(DISTINCT term) AS count FROM memory_terms WHERE doc_id IN (SELECT doc_id FROM memory_documents WHERE project_id = ?)',
        )
        .get(projectId) as { count: number };
      const last = db
        .prepare('SELECT MAX(indexed_at) AS last FROM memory_documents WHERE project_id = ?')
        .get(projectId) as { last: string | null };
      return {
        projectId,
        documents: Object.values(byKind).reduce((sum, value) => sum + value, 0),
        distinctTerms: Number(terms.count),
        byKind,
        lastIndexedAt: last.last,
      };
    });
  }

  /**
   * Search the project folder on demand. Read-only, bounded, deterministic
   * ordering, no symlink traversal, and no credential-shaped files.
   */
  async searchFiles(projectId: string, query: string, options: FileSearchOptions = {}): Promise<FileSearchResult> {
    const maxFiles = Math.max(1, Math.min(5_000, Math.trunc(options.maxFiles ?? 800)));
    const maxFileBytes = Math.max(1_024, Math.min(4 * 1024 * 1024, Math.trunc(options.maxFileBytes ?? 262_144)));
    const maxResults = Math.max(1, Math.min(200, Math.trunc(options.maxResults ?? 40)));
    const maxDepth = Math.max(0, Math.min(20, Math.trunc(options.maxDepth ?? 8)));
    const maxTotalBytes = Math.max(
      maxFileBytes,
      Math.min(32 * 1024 * 1024, Math.trunc(options.maxTotalBytes ?? 8 * 1024 * 1024)),
    );
    const needle = normalizeQuery(query);
    if (needle === null) {
      throw stateError('invalid_request', 'A file search needs at least one letter or number.');
    }
    const project = await this.store.read(
      (db) =>
        db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(projectId) as
          { canonical_path: string } | undefined,
    );
    if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
    let rootStat;
    try {
      rootStat = statSync(project.canonical_path);
    } catch {
      throw stateError('not_found', `project folder does not exist: ${project.canonical_path}`);
    }
    if (!rootStat.isDirectory()) {
      throw stateError('invalid_request', `project folder is not a directory: ${project.canonical_path}`);
    }

    const hits: FileSearchResult['hits'] = [];
    const skipped = { secretPath: 0, binary: 0, oversize: 0 };
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    const lowerNeedle = needle.toLowerCase();
    const stack: Array<{ dir: string; depth: number }> = [{ dir: project.canonical_path, depth: 0 }];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      if (current.depth > maxDepth) continue;
      let entries;
      try {
        entries = readdirSync(current.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      const childDirs: Array<{ dir: string; depth: number }> = [];
      for (const entry of entries) {
        if (hits.length >= maxResults || scannedFiles >= maxFiles || scannedBytes >= maxTotalBytes) {
          truncated = true;
          break;
        }
        const full = path.join(current.dir, entry.name);
        let link: boolean;
        try {
          link = lstatSync(full).isSymbolicLink();
        } catch {
          continue;
        }
        if (link) continue;
        const relative = path.relative(project.canonical_path, full).replaceAll('\\', '/');
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
          if (visited.has(full)) continue;
          visited.add(full);
          childDirs.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        if (looksLikeSecretPath(relative)) {
          skipped.secretPath += 1;
          continue;
        }
        let size: number;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > maxFileBytes || scannedBytes + size > maxTotalBytes) {
          skipped.oversize += 1;
          continue;
        }
        let buffer: Buffer;
        try {
          buffer = readFileSync(full);
        } catch {
          continue;
        }
        scannedFiles += 1;
        scannedBytes += buffer.byteLength;
        if (buffer.includes(0)) {
          skipped.binary += 1;
          continue;
        }
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/);
        let matches = 0;
        for (let index = 0; index < lines.length && matches < 3; index += 1) {
          const line = lines[index] ?? '';
          const at = line.toLowerCase().indexOf(lowerNeedle);
          if (at < 0) continue;
          matches += 1;
          hits.push({
            path: relative,
            line: index + 1,
            snippet: snippetWindow(line, needle),
          });
          if (hits.length >= maxResults) break;
        }
      }
      // Depth-first with deterministic sibling order: push reversed so the
      // smallest name is visited first.
      for (const child of childDirs.reverse()) stack.push(child);
      if (truncated && (hits.length >= maxResults || scannedFiles >= maxFiles || scannedBytes >= maxTotalBytes)) break;
    }

    return {
      projectId,
      query,
      hits,
      scannedFiles,
      scannedBytes,
      truncated: truncated || hits.length >= maxResults,
      skipped,
    };
  }

  private collectDocuments(
    db: DatabaseSync,
    projectId: string,
    project: { label: string; repo_kind: string },
    policy: MemoryPolicy,
  ): DocumentDraft[] {
    const drafts: DocumentDraft[] = [];
    drafts.push({
      kind: 'project',
      refId: projectId,
      title: project.label,
      body: `Project ${project.label}. Repository kind: ${project.repo_kind}.`,
      retention: KIND_RETENTION.project,
    });

    const decisions = db
      .prepare('SELECT id, title, body FROM decisions WHERE project_id = ? ORDER BY decided_at, id')
      .all(projectId) as Array<{ id: string; title: string; body: string }>;
    for (const decision of decisions) {
      drafts.push({
        kind: 'decision',
        refId: decision.id,
        title: decision.title,
        body: decision.body,
        retention: 'permanent',
      });
    }

    const tasks = db
      .prepare(
        'SELECT id, title, description, status, updated_at FROM tasks WHERE project_id = ? ORDER BY ordinal, created_at, id',
      )
      .all(projectId) as Array<{ id: string; title: string; description: string; status: string; updated_at: string }>;
    const criteria = db
      .prepare(
        `SELECT a.task_id AS task_id, a.description AS description
           FROM task_acceptance a JOIN tasks t ON t.id = a.task_id
          WHERE t.project_id = ? ORDER BY a.task_id, a.position`,
      )
      .all(projectId) as Array<{ task_id: string; description: string }>;
    const requirements = db
      .prepare(
        `SELECT r.task_id AS task_id, r.requirement_id AS requirement_id
           FROM task_requirements r JOIN tasks t ON t.id = r.task_id
          WHERE t.project_id = ? ORDER BY r.task_id, r.requirement_id`,
      )
      .all(projectId) as Array<{ task_id: string; requirement_id: string }>;
    for (const task of tasks) {
      const acceptance = criteria
        .filter((entry) => entry.task_id === task.id)
        .map((entry) => entry.description)
        .join('; ');
      const references = requirements
        .filter((entry) => entry.task_id === task.id)
        .map((entry) => entry.requirement_id)
        .join(', ');
      const body = [
        task.description,
        `Status: ${task.status}.`,
        acceptance ? `Acceptance: ${acceptance}` : '',
        references ? `Requirements: ${references}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      drafts.push({ kind: 'task', refId: task.id, title: task.title, body, retention: 'task' });
    }

    const evidence = db
      .prepare(
        `SELECT e.id AS id, e.path AS path, e.kind AS kind, e.note AS note, e.stale_reason AS stale_reason
           FROM task_evidence e JOIN tasks t ON t.id = e.task_id
          WHERE t.project_id = ? ORDER BY e.recorded_at, e.id`,
      )
      .all(projectId) as Array<{
      id: string;
      path: string;
      kind: string;
      note: string | null;
      stale_reason: string | null;
    }>;
    for (const entry of evidence) {
      drafts.push({
        kind: 'evidence',
        refId: entry.id,
        title: entry.path,
        body: [`Evidence ${entry.kind}: ${entry.path}`, entry.note ?? '', entry.stale_reason ?? '']
          .filter(Boolean)
          .join('\n'),
        retention: 'evidence',
      });
    }

    const requirementEvidence = db
      .prepare(
        `SELECT id, requirement_id, criterion_id, path, note
           FROM requirement_evidence WHERE project_id = ? ORDER BY recorded_at, id`,
      )
      .all(projectId) as Array<{
      id: string;
      requirement_id: string;
      criterion_id: string;
      path: string;
      note: string | null;
    }>;
    for (const entry of requirementEvidence) {
      drafts.push({
        kind: 'requirement',
        refId: entry.id,
        title: `${entry.requirement_id} ${entry.criterion_id}`.trim(),
        body: [entry.path, entry.note ?? ''].filter(Boolean).join('\n'),
        retention: 'evidence',
      });
    }

    const problems = db
      .prepare(
        'SELECT id, title, symptom_fingerprint, help_needed, resolution FROM problems WHERE project_id = ? ORDER BY created_at, id',
      )
      .all(projectId) as Array<{
      id: string;
      title: string;
      symptom_fingerprint: string;
      help_needed: string | null;
      resolution: string | null;
    }>;
    for (const problem of problems) {
      drafts.push({
        kind: 'problem',
        refId: problem.id,
        title: problem.title,
        body: [problem.symptom_fingerprint, problem.help_needed ?? '', problem.resolution ?? '']
          .filter(Boolean)
          .join('\n'),
        retention: 'evidence',
      });
    }

    if (policy.includeAttempts) {
      const attempts = db
        .prepare(
          `SELECT id, hypothesis, action, observed_result FROM attempts
            WHERE project_id = ? ORDER BY created_at, id`,
        )
        .all(projectId) as Array<{ id: string; hypothesis: string; action: string; observed_result: string }>;
      for (const attempt of attempts) {
        drafts.push({
          kind: 'attempt',
          refId: attempt.id,
          title: attempt.hypothesis.slice(0, 200),
          body: `${attempt.action}\n${attempt.observed_result}`,
          retention: 'evidence',
        });
      }
    }

    if (policy.includeTimeline) {
      const limit = Math.max(0, Math.min(2_000, Math.trunc(policy.timelineLimit)));
      if (limit > 0) {
        const items = db
          .prepare(
            `SELECT id, kind, title, body FROM timeline_items
              WHERE project_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?`,
          )
          .all(projectId, limit) as Array<{ id: string; kind: string; title: string; body: string }>;
        for (const item of items) {
          if (SKIPPED_TIMELINE_KINDS.has(item.kind)) continue;
          drafts.push({
            kind: 'timeline',
            refId: item.id,
            title: item.title,
            body: item.body.slice(0, 4_000),
            retention: 'task',
          });
        }
      }
    }

    return drafts;
  }
}

function weightsFor(title: string, body: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of tokenizeForSearch(title)) {
    weights.set(term, 3);
  }
  for (const term of tokenizeForSearch(body)) {
    if (!weights.has(term)) weights.set(term, 1);
  }
  return weights;
}

function snippetFor(title: string, body: string, terms: readonly string[]): string {
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  for (const term of terms) {
    const inBody = lowerBody.indexOf(term);
    if (inBody >= 0) return snippetWindow(body, term);
    const inTitle = lowerTitle.indexOf(term);
    if (inTitle >= 0) return title;
  }
  return collapse(title || body).slice(0, 160);
}

function snippetWindow(text: string, needle: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const at = normalized.toLowerCase().indexOf(needle.toLowerCase());
  const start = at >= 0 ? Math.max(0, at - 60) : 0;
  const end = Math.min(normalized.length, start + 180);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed))
    return trimmed.slice(0, 200);
  const compact = trimmed.replace(/\s+/g, ' ');
  if (compact.length < 2) return null;
  return compact.slice(0, 200);
}

function emptyKindCounts(): Record<MemoryKind, number> {
  return {
    project: 0,
    decision: 0,
    task: 0,
    evidence: 0,
    requirement: 0,
    problem: 0,
    attempt: 0,
    timeline: 0,
  };
}
