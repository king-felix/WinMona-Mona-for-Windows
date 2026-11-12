import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { redactText } from './redaction.js';
import type { ProjectStore } from './store.js';

/**
 * Local diagnostic bundle.
 *
 * A preview is assembled from known local state and already-redacted engine
 * facts. Nothing is uploaded, no environment dump is included, and no provider
 * key, runtime token or credential path belongs in the text. Export writes the
 * exact preview bytes so a human can inspect what will leave the machine before
 * sharing it.
 */

export type DiagnosticsAppInfo = {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
};

export type DiagnosticsEngineInfo = {
  status: string;
  detail: string;
  version: string | null;
  commit: string | null;
  endpoint: string | null;
  pid: number | null;
  compatibility: string | null;
};

export type DiagnosticsLog = { name: string; text: string };

export type DiagnosticsInput = {
  store: ProjectStore;
  app: DiagnosticsAppInfo;
  engine: DiagnosticsEngineInfo;
  /** Where artifact metadata points; absence is reported, never hidden. */
  artifactRoot?: string;
  logs?: readonly DiagnosticsLog[];
  /** Hash artifact files as well as checking existence. Default false. */
  verifyArtifacts?: boolean;
  now?: Date;
  /** Extra already-redacted lines (for example a probe result). */
  notes?: readonly string[];
};

export type DiagnosticSection = { name: string; lines: string[] };

export type DiagnosticPreview = {
  generatedAt: string;
  redacted: true;
  sections: DiagnosticSection[];
  text: string;
  bytes: number;
  sha256: string;
  redaction: { rules: string[]; redactions: number };
  artifacts: {
    records: number;
    checked: number;
    truncated: boolean;
    missing: string[];
    digestMismatches: string[];
    verification: 'metadata' | 'digests' | 'unavailable';
  };
};

const MAX_LOG_BYTES = 8 * 1024;
const MAX_TOTAL_TEXT = 160 * 1024;

export async function buildDiagnosticPreview(input: DiagnosticsInput): Promise<DiagnosticPreview> {
  const now = input.now ?? new Date();
  const facts = await input.store.read((db) => {
    const schema = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version?: number | null;
    };
    const counts = {
      projects: countOf(db, 'projects'),
      tasks: countOf(db, 'tasks'),
      decisions: countOf(db, 'decisions'),
      taskEvidence: countOf(db, 'task_evidence'),
      problems: countOf(db, 'problems'),
      attempts: countOf(db, 'attempts'),
      usageRecords: countOf(db, 'usage_records'),
      timelineItems: countOf(db, 'timeline_items'),
      memoryDocuments: countOf(db, 'memory_documents'),
      settingsVersions: countOf(db, 'settings_versions'),
    };
    const taskStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status')
      .all() as Array<{ status: string; count: number }>;
    const usage = db
      .prepare(
        `SELECT COUNT(*) AS records, COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_micros ELSE 0 END), 0) AS known,
                COALESCE(SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END), 0) AS unknown
           FROM usage_records`,
      )
      .get() as { records: number; known: number; unknown: number };
    const artifacts = db
      .prepare(
        `SELECT sha256, relative_path, bytes, media_type, retention, pruned_at
           FROM artifacts WHERE pruned_at IS NULL ORDER BY created_at DESC, sha256 LIMIT 201`,
      )
      .all() as Array<{
      sha256: string;
      relative_path: string;
      bytes: number;
      media_type: string;
      retention: string;
      pruned_at: string | null;
    }>;
    return { schema, counts, taskStatus, usage, artifacts };
  });

  const sections: DiagnosticSection[] = [];
  const app = input.app;
  sections.push({
    name: 'Application',
    lines: [
      `name: ${app.name}`,
      `version: ${app.version}`,
      `electron: ${app.electron}`,
      `chromium: ${app.chrome}`,
      `node: ${app.node}`,
      `platform: ${app.platform}`,
      `arch: ${app.arch}`,
    ],
  });

  sections.push({
    name: 'Engine (reported, not probed)',
    lines: [
      `status: ${input.engine.status}`,
      `detail: ${input.engine.detail}`,
      `version: ${input.engine.version ?? 'unknown'}`,
      `commit: ${input.engine.commit ?? 'unknown'}`,
      `endpoint: ${input.engine.endpoint ?? 'none'}`,
      `pid: ${input.engine.pid ?? 'none'}`,
      `compatibility: ${input.engine.compatibility ?? 'unknown'}`,
    ],
  });

  const fileBytes: number | null = (() => {
    try {
      return statSync(input.store.file).size;
    } catch {
      return null;
    }
  })();
  const integrity = safeIntegrityCheck(input.store);
  sections.push({
    name: 'Local state',
    lines: [
      `schema: ${facts.schema.version ?? 'unknown'}`,
      `store revision: ${input.store.storeRevision()}`,
      `database bytes: ${fileBytes ?? 'unavailable'}`,
      `integrity: ${integrity}`,
      `projects: ${facts.counts.projects}`,
      `tasks: ${facts.counts.tasks} (${facts.taskStatus.map((row) => `${row.status}=${row.count}`).join(', ') || 'none'})`,
      `decisions: ${facts.counts.decisions}`,
      `task evidence: ${facts.counts.taskEvidence}`,
      `problems: ${facts.counts.problems}`,
      `attempts: ${facts.counts.attempts}`,
      `timeline items: ${facts.counts.timelineItems}`,
      `memory documents: ${facts.counts.memoryDocuments}`,
      `settings versions: ${facts.counts.settingsVersions}`,
      `usage records: ${facts.usage.records} (known microUSD ${Number(facts.usage.known)}, unknown ${Number(facts.usage.unknown)})`,
    ],
  });

  const artifactSection: string[] = [];
  const missing: string[] = [];
  const digestMismatches: string[] = [];
  const records = facts.artifacts.slice(0, 200);
  const verification: DiagnosticPreview['artifacts']['verification'] = input.artifactRoot
    ? input.verifyArtifacts === true
      ? 'digests'
      : 'metadata'
    : 'unavailable';
  if (!existsSync(input.artifactRoot ?? '')) {
    artifactSection.push('artifact root: unavailable');
  } else {
    artifactSection.push(`artifact root: ${input.artifactRoot}`);
  }
  for (const record of records) {
    const absolute = input.artifactRoot ? path.join(input.artifactRoot, record.relative_path) : null;
    let status = 'not-checked';
    if (absolute) {
      if (!existsSync(absolute)) {
        status = 'missing';
        missing.push(record.relative_path);
      } else if (input.verifyArtifacts === true) {
        try {
          const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
          if (actual !== record.sha256) {
            status = 'digest-mismatch';
            digestMismatches.push(record.relative_path);
          } else {
            status = 'verified';
          }
        } catch {
          status = 'unreadable';
        }
      } else {
        status = 'present';
      }
    }
    artifactSection.push(
      `- ${record.sha256.slice(0, 12)}â€¦ ${record.relative_path} ${record.bytes} bytes ${record.media_type} retention=${record.retention} ${status}`,
    );
  }
  if (facts.artifacts.length > records.length) artifactSection.push(`- listing truncated at ${records.length} records`);
  if (records.length === 0) artifactSection.push('- no recorded artifacts');
  sections.push({ name: 'Artifacts', lines: artifactSection });

  const logLines: string[] = [];
  for (const log of input.logs ?? []) {
    const text = log.text.slice(0, MAX_LOG_BYTES);
    logLines.push(`## ${log.name}${log.text.length > text.length ? ' (truncated)' : ''}`);
    logLines.push(text);
  }
  if (logLines.length > 0) sections.push({ name: 'Log excerpts (redacted)', lines: logLines });
  if (input.notes && input.notes.length > 0) {
    sections.push({ name: 'Notes', lines: input.notes.map((note) => `- ${note}`) });
  }

  const assembled = [
    '# Mona diagnostics (local, redacted)',
    `Generated: ${now.toISOString()}`,
    'No provider credentials, runtime tokens, environment dump or full source is included.',
    ...sections.flatMap((section) => ['', `## ${section.name}`, ...section.lines]),
    '',
  ].join('\n');
  const bounded =
    assembled.length > MAX_TOTAL_TEXT ? `${assembled.slice(0, MAX_TOTAL_TEXT)}\n[truncated]\n` : assembled;
  const redacted = redactText(bounded);
  // Redaction runs once over the whole document so a secret assembled from two
  // innocent-looking fields still matches a rule.
  const text = redacted.text;
  return {
    generatedAt: now.toISOString(),
    redacted: true,
    sections: sections.map((section) => ({
      name: section.name,
      lines: section.lines.map((line) => redactText(line).text),
    })),
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    redaction: { rules: redacted.rules, redactions: redacted.redactions },
    artifacts: {
      records: facts.artifacts.length,
      checked: records.length,
      truncated: facts.artifacts.length > records.length,
      missing,
      digestMismatches,
      verification,
    },
  };
}

export function exportDiagnosticBundle(
  preview: DiagnosticPreview,
  file: string,
): { file: string; sha256: string; bytes: number } {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, preview.text, 'utf8');
  renameSync(temporary, target);
  return { file: target, sha256: preview.sha256, bytes: preview.bytes };
}

function countOf(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    // A store from before a table existed reports zero rather than failing the
    // whole bundle.
    return 0;
  }
}

function safeIntegrityCheck(store: ProjectStore): string {
  try {
    return store.integrityCheck();
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'})`;
  }
}
