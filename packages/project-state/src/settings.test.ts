import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations.js';
import type { StateError } from './errors.js';
import { backupSettings, digestOfSettings, restoreSettings, type SettingsBackup } from './settings.js';
import { ProjectStore } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p19-settings-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

const SECRET = 'sk-abcdefghijklmnop123456';

describe('settings backup', () => {
  it('writes a digest-checked backup with credential-shaped values removed', async () => {
    const store = await openStore('backup');
    await store.saveSettingVersion('route', 2, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      api_key: SECRET,
      nested: { password: 'hunter2', note: 'leave me' },
    });
    await store.saveSettingVersion('attention', 1, { notificationsEnabled: true });
    const file = path.join(await tempDir('backup-out'), 'settings.json');
    const receipt = await backupSettings(store, { file });

    expect(receipt.scopes).toEqual(['attention', 'route']);
    expect(receipt.redactedPaths).toContain('route:api_key');
    expect(receipt.redactedPaths).toContain('route:nested.password');
    expect(receipt.redactedPaths).not.toContain('route:nested.note');

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('hunter2');
    const document = JSON.parse(raw) as SettingsBackup;
    const route = document.scopes.find((entry) => entry.scope === 'route');
    expect(route?.version).toBe(2);
    expect(route?.values).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      api_key: '[redacted]',
      nested: { password: '[redacted]', note: 'leave me' },
    });
    const { digest, ...body } = document;
    expect(digestOfSettings(body)).toBe(digest);
  });

  it('rejects a tampered backup and a digest that does not match', async () => {
    const store = await openStore('tamper');
    await store.saveSettingVersion('route', 1, { provider: 'deepseek' });
    const file = path.join(await tempDir('tamper-out'), 'settings.json');
    await backupSettings(store, { file });
    const document = JSON.parse(await readFile(file, 'utf8')) as SettingsBackup;
    document.scopes[0] = { scope: 'route', version: 1, values: { provider: 'other' } };
    await writeFile(file, JSON.stringify(document), 'utf8');
    await expect(restoreSettings(store, { file })).rejects.toMatchObject({ code: 'digest_mismatch' });
    await expect(restoreSettings(store, { file, expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
  });
});

describe('settings restore', () => {
  it('takes the maintenance barrier and appends a new settings version', async () => {
    const source = await openStore('source');
    await source.saveSettingVersion('route', 3, { provider: 'deepseek', model: 'deepseek-flash', api_key: SECRET });
    const file = path.join(await tempDir('restore-out'), 'settings.json');
    await backupSettings(source, { file });

    const target = await openStore('target');
    await target.saveSettingVersion('route', 7, { provider: 'old' });
    let refused: unknown = null;
    const receipt = await restoreSettings(target, {
      file,
      hooks: {
        beforeCommit: async () => {
          refused = await target
            .write((tx) => {
              tx.db.prepare('SELECT 1').get();
            })
            .catch((error: unknown) => error);
        },
      },
    });
    expect((refused as StateError).code).toBe('maintenance');
    expect(receipt.barrier).toBe('exclusive');
    expect(receipt.restoredScopes).toEqual([{ scope: 'route', previousVersion: 7, newVersion: 8 }]);
    const latest = await target.latestSettingVersion('route');
    expect(latest?.version).toBe(8);
    expect(latest?.values).toMatchObject({ provider: 'deepseek', api_key: '[redacted]' });
  });

  it('refuses a backup from a newer store schema and a missing file', async () => {
    const store = await openStore('schema');
    const file = path.join(await tempDir('schema-out'), 'settings.json');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { digest: _digest, ...body } = {
      schema_version: 1 as const,
      kind: 'mona.settings-backup' as const,
      exported_at: '2026-11-12T10:00:00.000Z',
      store_revision: 0,
      store_schema_version: 999,
      scopes: [{ scope: 'route', version: 1, values: { provider: 'deepseek' } }],
      redactedPaths: [],
      digest: '',
    };
    await writeFile(file, JSON.stringify({ ...body, digest: digestOfSettings(body) }), 'utf8');
    await expect(restoreSettings(store, { file })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(restoreSettings(store, { file: path.join(path.dirname(file), 'missing.json') })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });

  it('does not leave a partial version when the transaction fails', async () => {
    const source = await openStore('rollback-source');
    await source.saveSettingVersion('route', 1, { provider: 'deepseek' });
    const file = path.join(await tempDir('rollback-out'), 'settings.json');
    await backupSettings(source, { file });
    const target = await openStore('rollback-target');
    await expect(
      restoreSettings(target, {
        file,
        hooks: {
          beforeCommit: () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrowError('injected failure');
    expect(await target.latestSettingVersion('route')).toBeNull();
    // The barrier was released, so a normal write still works.
    await target.saveSettingVersion('route', 1, { provider: 'deepseek' });
    expect((await target.latestSettingVersion('route'))?.version).toBe(1);
  });
});
