import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { stateError } from './errors.js';
import { redactValue } from './redaction.js';
import type { ProjectStore } from './store.js';

/**
 * Settings backup and restore.
 *
 * A backup is a portable JSON file carrying the newest value of every settings
 * scope, with credential-shaped keys and values removed. A restore verifies the
 * digest, then runs under the maintenance barrier with an IMMEDIATE transaction:
 * no UI writer, ingestion path, worker or task runner can interleave with it.
 * Restore appends new settings versions; it never rewrites the recorded history.
 */

const SettingsEntry = z
  .object({
    scope: z.string().min(1).max(200),
    version: z.number().int().min(1),
    values: z.unknown(),
  })
  .strict();

export const SettingsBackup = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('mona.settings-backup'),
    exported_at: z.string().min(1),
    store_revision: z.number().int().nonnegative(),
    store_schema_version: z.number().int().nonnegative(),
    scopes: z.array(SettingsEntry),
    redactedPaths: z.array(z.string()),
    /** sha256 over the canonical JSON of everything except this field. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SettingsBackup = z.infer<typeof SettingsBackup>;

export type SettingsBackupReceipt = {
  file: string;
  sha256: string;
  bytes: number;
  scopes: string[];
  redactedPaths: string[];
  storeSchemaVersion: number;
  createdAt: string;
};

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

export function digestOfSettings(document: Omit<SettingsBackup, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

export async function backupSettings(
  store: ProjectStore,
  options: { file: string; now?: () => Date },
): Promise<SettingsBackupReceipt> {
  const now = (options.now ?? (() => new Date()))();
  const rows = await store.read(
    (db) =>
      db.prepare('SELECT scope, version, values_json FROM settings_versions ORDER BY scope, version').all() as Array<{
        scope: string;
        version: number;
        values_json: string;
      }>,
  );
  const latest = new Map<string, { scope: string; version: number; values: unknown }>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.values_json) as unknown;
    } catch {
      parsed = { unreadable: true };
    }
    latest.set(row.scope, { scope: row.scope, version: Number(row.version), values: parsed });
  }

  const redactedPaths = new Set<string>();
  const scopes = [...latest.values()]
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .map((entry) => {
      const redacted = redactValue(entry.values);
      for (const item of redacted.redactedPaths) redactedPaths.add(`${entry.scope}:${item}`);
      return { scope: entry.scope, version: entry.version, values: redacted.value };
    });

  const body = {
    schema_version: 1 as const,
    kind: 'mona.settings-backup' as const,
    exported_at: now.toISOString(),
    store_revision: store.storeRevision(),
    store_schema_version: currentSchemaVersion(store.database),
    scopes,
    redactedPaths: [...redactedPaths].sort(),
  };
  const document: SettingsBackup = { ...body, digest: digestOfSettings(body) };
  const file = path.resolve(options.file);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, file);
  return {
    file,
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(serialized, 'utf8'),
    scopes: scopes.map((entry) => entry.scope),
    redactedPaths: [...redactedPaths].sort(),
    storeSchemaVersion: body.store_schema_version,
    createdAt: body.exported_at,
  };
}

export type SettingsRestoreOptions = {
  file: string;
  expectedSha256?: string;
  /** Test hook, called while the maintenance barrier is held. */
  hooks?: { beforeCommit?: () => Promise<void> | void };
  now?: () => Date;
};

export type SettingsRestoreReceipt = {
  file: string;
  sha256: string;
  barrier: 'exclusive';
  restoredScopes: Array<{ scope: string; previousVersion: number; newVersion: number }>;
  redactedPaths: string[];
  completedAt: string;
};

/**
 * Restore settings from a verified backup. A backup made by a newer store
 * schema is refused: silently loading settings the current build does not
 * understand is worse than declining.
 */
export async function restoreSettings(
  store: ProjectStore,
  options: SettingsRestoreOptions,
): Promise<SettingsRestoreReceipt> {
  const file = path.resolve(options.file);
  if (!existsSync(file)) throw stateError('not_found', `settings backup does not exist: ${file}`);
  const raw = readFileSync(file, 'utf8');
  const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (options.expectedSha256 && options.expectedSha256 !== sha256) {
    throw stateError('digest_mismatch', 'settings backup digest does not match the expected value', sha256);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw stateError('invalid_request', 'settings backup is not valid JSON');
  }
  const schema = SettingsBackup.safeParse(parsed);
  if (!schema.success) {
    throw stateError(
      'invalid_request',
      'file is not a Mona settings backup',
      schema.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  const document = schema.data;
  const { digest, ...body } = document;
  if (digestOfSettings(body) !== digest) {
    throw stateError('digest_mismatch', 'settings backup digest does not match its contents');
  }
  const storeSchema = currentSchemaVersion(store.database);
  if (document.store_schema_version > storeSchema) {
    throw stateError(
      'invalid_request',
      `backup was made with store schema ${document.store_schema_version}; this build supports ${storeSchema}`,
      'Update Mona before restoring this backup.',
    );
  }
  const at = (options.now ?? (() => new Date()))().toISOString();

  return await store.exclusive('settings-restore', async () => {
    const db = store.database;
    db.exec('BEGIN IMMEDIATE');
    const restoredScopes: SettingsRestoreReceipt['restoredScopes'] = [];
    try {
      for (const entry of document.scopes) {
        const row = db
          .prepare('SELECT MAX(version) AS version FROM settings_versions WHERE scope = ?')
          .get(entry.scope) as { version?: number | null } | undefined;
        const previousVersion = typeof row?.version === 'number' ? row.version : 0;
        const newVersion = previousVersion + 1;
        db.prepare(
          'INSERT INTO settings_versions(id, scope, version, values_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          `set_${createHash('sha256').update(`${entry.scope}\u0000${newVersion}\u0000${at}`).digest('hex').slice(0, 32)}`,
          entry.scope,
          newVersion,
          JSON.stringify(entry.values ?? null),
          at,
        );
        restoredScopes.push({ scope: entry.scope, previousVersion, newVersion });
      }
      db.prepare("UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
      await options.hooks?.beforeCommit?.();
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw error;
    }
    return {
      file,
      sha256,
      barrier: 'exclusive' as const,
      restoredScopes,
      redactedPaths: document.redactedPaths,
      completedAt: at,
    };
  });
}

function currentSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      { version?: number | null } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch {
    return 0;
  }
}
