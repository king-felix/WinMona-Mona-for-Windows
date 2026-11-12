import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, checksumOf, MIGRATIONS, schemaVersion } from './migrations.js';
import { openDatabase, type OpenDatabase } from './db.js';
import { StateError } from './errors.js';

const cleanup: Array<() => Promise<void>> = [];
const openDbs: OpenDatabase[] = [];

afterEach(async () => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p05-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function open(label: string): Promise<{ store: OpenDatabase; dir: string }> {
  const dir = await tempDir(label);
  const store = openDatabase({ file: path.join(dir, 'state.sqlite') });
  openDbs.push(store);
  return { store, dir };
}

describe('migrations', () => {
  it('applies the schema from empty and reports it as already current on reopen', async () => {
    const { store } = await open('migrate');
    const first = await applyMigrations(store.db);
    expect(first.from).toBe(0);
    expect(first.to).toBe(MIGRATIONS.length);
    expect(first.applied.map((migration) => migration.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);

    const second = await applyMigrations(store.db);
    expect(second.alreadyCurrent).toBe(true);
    expect(second.applied).toEqual([]);

    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    for (const table of [
      'projects',
      'runtime_bindings',
      'threads',
      'turns',
      'submissions',
      'tasks',
      'task_dependencies',
      'requirement_evidence',
      'attempts',
      'decisions',
      'event_cursors',
      'usage_records',
      'capability_snapshots',
      'settings_versions',
      'artifacts',
    ]) {
      expect(names).toContain(table);
    }
    expect(store.integrityCheck()).toBe('ok');
  });

  it('refuses to run when a shipped migration was edited after being applied', async () => {
    const { store } = await open('tamper');
    await applyMigrations(store.db);
    store.db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('f'.repeat(64));
    await expect(applyMigrations(store.db)).rejects.toBeInstanceOf(StateError);
    await expect(applyMigrations(store.db)).rejects.toMatchObject({ code: 'migration_mismatch' });
    expect(checksumOf(MIGRATIONS[0]?.sql ?? '')).not.toBe('f'.repeat(64));
  });

  it('keeps the database at the previous version when a migration fails', async () => {
    const { store } = await open('fail');
    const failing = {
      version: MIGRATIONS.length,
      name: 'broken',
      sql: 'CREATE TABLE ok(id INTEGER); CREATE TABLE ok(id INTEGER);',
    };
    const report = await applyMigrations(store.db, {
      migrations: [...MIGRATIONS.slice(0, -1), failing],
    }).catch((error: unknown) => error);
    expect(report).toBeInstanceOf(StateError);
    expect((report as StateError).code).toBe('migration_failed');
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length - 1);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    expect(tables.map((row) => row.name)).not.toContain('ok');
    expect(store.integrityCheck()).toBe('ok');
  });

  it('takes a snapshot before pending migrations run, and never deletes it', async () => {
    const { store } = await open('snapshot');
    await applyMigrations(store.db);
    const calls: number[] = [];
    const next = {
      version: MIGRATIONS.length + 1,
      name: 'second',
      sql: 'CREATE TABLE extra(id INTEGER PRIMARY KEY);',
    };
    await applyMigrations(store.db, {
      migrations: [...MIGRATIONS, next],
      beforeApply: (context) => {
        calls.push(context.from, context.to);
      },
    });
    expect(calls).toEqual([MIGRATIONS.length, MIGRATIONS.length + 1]);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length + 1);
  });

  it('refuses a database migration this build does not know', async () => {
    const { store } = await open('future');
    await applyMigrations(store.db);
    store.db
      .prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (99, 'future', 'x', '2026-01-01')",
      )
      .run();
    await expect(applyMigrations(store.db)).rejects.toMatchObject({ code: 'migration_mismatch' });
  });
});
