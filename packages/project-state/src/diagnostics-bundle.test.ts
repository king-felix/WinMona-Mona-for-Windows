import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDiagnosticPreview, exportDiagnosticBundle } from './diagnostics-bundle.js';
import { applyMigrations, MIGRATIONS } from './migrations.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p19-diagnostics-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup() {
  const dir = await tempDir('state');
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const workspace = await tempDir('workspace');
  const registered = await store.registerProject(workspace, { label: 'Diagnostics Lab' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const artifactRoot = await tempDir('artifacts');
  return { store, workspace, projectId: registered.project.id, artifactRoot };
}

async function recordArtifact(
  store: ProjectStore,
  projectId: string,
  root: string,
  relative: string,
  content: string,
): Promise<void> {
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  await store.write((tx) => {
    tx.db
      .prepare(
        `INSERT INTO artifacts(sha256, project_id, relative_path, bytes, media_type, source, retention, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256,
        projectId,
        relative,
        Buffer.byteLength(content),
        'text/plain',
        'test',
        'evidence',
        '2026-11-12T10:00:00.000Z',
      );
  });
}

const FIXTURE_KEY = ['sk', 'diagnosticfixture123456'].join('-');

const APP = {
  name: 'Mona',
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '140.0.0.0',
  node: '26.13.1',
  platform: 'win32',
  arch: 'x64',
};

const ENGINE = {
  status: 'connected',
  detail: 'owned runtime from C:\\Users\\victor\\AppData\\Local\\codewhale.exe',
  version: '0.10.2',
  commit: 'ff466b2ed0bf',
  endpoint: 'http://127.0.0.1:43117',
  pid: 4242,
  compatibility: 'qualified',
};

describe('diagnostic bundle preview', () => {
  it('is local, redacted by default and reports artifact state honestly', async () => {
    const { store, projectId, artifactRoot } = await setup();
    await recordArtifact(store, projectId, artifactRoot, 'aa/present', 'present artifact');
    await recordArtifact(store, projectId, artifactRoot, 'bb/missing', 'will be removed');
    await rm(path.join(artifactRoot, 'bb', 'missing'), { force: true });

    const preview = await buildDiagnosticPreview({
      store,
      app: APP,
      engine: ENGINE,
      artifactRoot,
      now: new Date('2026-11-12T12:00:00.000Z'),
      notes: [`DEEPSEEK_API_KEY=${FIXTURE_KEY} and Authorization: Bearer abcdefghijklmnop`],
    });

    expect(preview.redacted).toBe(true);
    expect(preview.text).toContain('# Mona diagnostics (local, redacted)');
    expect(preview.text).toContain(`schema: ${MIGRATIONS.length}`);
    expect(preview.text).toContain('projects: 1');
    expect(preview.text).toContain('artifact root:');
    expect(preview.artifacts.missing).toEqual(['bb/missing']);
    expect(preview.artifacts.verification).toBe('metadata');
    expect(preview.text).not.toContain('victor');
    expect(preview.text).toContain('C:\\Users\\[user]');
    expect(preview.text).not.toContain(FIXTURE_KEY);
    expect(preview.text).not.toContain('abcdefghijklmnop');
    expect(preview.redaction.redactions).toBeGreaterThan(0);
    expect(preview.sha256).toBe(createHash('sha256').update(preview.text, 'utf8').digest('hex'));
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text, 'utf8'));
  });

  it('verifies artifact digests only when asked and reports mismatches', async () => {
    const { store, projectId, artifactRoot } = await setup();
    await recordArtifact(store, projectId, artifactRoot, 'cc/changed', 'original');
    await writeFile(path.join(artifactRoot, 'cc', 'changed'), 'tampered', 'utf8');
    const preview = await buildDiagnosticPreview({
      store,
      app: APP,
      engine: { ...ENGINE, status: 'stopped', endpoint: null, pid: null },
      artifactRoot,
      verifyArtifacts: true,
      notes: [],
    });
    expect(preview.artifacts.verification).toBe('digests');
    expect(preview.artifacts.digestMismatches).toEqual(['cc/changed']);
    expect(preview.text).toContain('digest-mismatch');
  });

  it('exports exactly the bytes that were previewed', async () => {
    const { store, artifactRoot } = await setup();
    const preview = await buildDiagnosticPreview({ store, app: APP, engine: ENGINE, artifactRoot });
    const file = path.join(await tempDir('out'), 'diagnostics.txt');
    const receipt = exportDiagnosticBundle(preview, file);
    expect(receipt.sha256).toBe(preview.sha256);
    expect(receipt.bytes).toBe(preview.bytes);
    const written = await readFile(file, 'utf8');
    expect(written).toBe(preview.text);
    expect(createHash('sha256').update(written, 'utf8').digest('hex')).toBe(preview.sha256);
  });

  it('still produces a preview when the artifact root is unavailable', async () => {
    const { store } = await setup();
    const preview = await buildDiagnosticPreview({ store, app: APP, engine: ENGINE });
    expect(preview.artifacts.verification).toBe('unavailable');
    expect(preview.text).toContain('artifact root: unavailable');
  });
});
