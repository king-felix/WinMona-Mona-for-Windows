import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '@mona/project-state';
import { MemoryService, type MemoryDialogs } from './memory-service.js';
import { ProjectStore } from '@mona/project-state';
import { TaskService } from '@mona/project-state';
import { UiStateStore } from './ui-state.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p19-service-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

const APP = {
  name: 'Mona',
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '140.0.0.0',
  node: '26.13.1',
  platform: 'win32',
  arch: 'x64',
};

const SECRET = ['sk', 'servicefixture123456'].join('-');

async function setup() {
  const stateDir = await tempDir('state');
  const store = new ProjectStore({
    file: path.join(stateDir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const workspace = await tempDir('workspace');
  const registered = await store.registerProject(workspace, { label: 'Service Lab' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const ui = new UiStateStore({ file: path.join(stateDir, 'ui-state.json') });
  const artifactRoot = await tempDir('artifacts');
  let savePath: string | null = null;
  let openPath: string | null = null;
  let folderPath: string | null = null;
  const dialogs: MemoryDialogs = {
    saveFile: async () => savePath,
    openFile: async () => openPath,
    chooseFolder: async () => folderPath,
  };
  const service = new MemoryService({
    store,
    ui,
    artifactRoot,
    app: () => APP,
    engine: () => ({
      status: 'connected',
      detail: `owned runtime from C:\\Users\\victor\\AppData\\Local (DEEPSEEK_API_KEY=${SECRET})`,
      version: '0.10.2',
      commit: 'ff466b2ed0bf',
      endpoint: 'http://127.0.0.1:43117',
      pid: 4242,
      compatibility: 'qualified',
    }),
    dialogs,
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  });
  await writeFile(path.join(workspace, 'notes.md'), '# Notes\nThe xylophone release gate.\n', 'utf8');
  await store.write((tx) => {
    tx.db
      .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        'dec_service',
        registered.project.id,
        'Zephyr decision',
        'Keep the zephyr gate local.',
        '2026-11-12T10:00:00.000Z',
      );
  });
  return {
    service,
    store,
    ui,
    workspace,
    projectId: registered.project.id,
    setPaths: (next: { save?: string | null; open?: string | null; folder?: string | null }) => {
      if (next.save !== undefined) savePath = next.save;
      if (next.open !== undefined) openPath = next.open;
      if (next.folder !== undefined) folderPath = next.folder;
    },
  };
}

describe('MemoryService search', () => {
  it('reports an unindexed project and then searches recorded state locally', async () => {
    const { service, projectId } = await setup();
    const before = await service.search({ projectId, query: 'zephyr', mode: 'history' });
    expect(before.ok && before.data.indexed).toBe(false);

    const reindexed = await service.reindex(projectId);
    expect(reindexed.ok).toBe(true);
    if (reindexed.ok) {
      expect(reindexed.data.documents).toBeGreaterThanOrEqual(2);
      expect(reindexed.data.byKind.decision).toBe(1);
    }
    const after = await service.search({ projectId, query: 'zephyr', mode: 'history' });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.data.hits[0]?.kind).toBe('decision');
      expect(after.data.hits[0]?.title).toContain('Zephyr');
    }
  });

  it('searches project files on demand and says what it skipped', async () => {
    const { service, workspace, projectId } = await setup();
    await writeFile(path.join(workspace, '.env'), 'DEEPSEEK_API_KEY=needle-secret\n', 'utf8');
    const result = await service.search({ projectId, query: 'xylophone', mode: 'files' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hits[0]).toMatchObject({ kind: 'file', title: 'notes.md' });
      expect(result.data.skipped.secretPath).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('MemoryService prompt shelf', () => {
  it('saves, previews and versions a prompt, then exports and imports packs', async () => {
    const { service, ui, projectId, setPaths } = await setup();
    const created = await service.promptSave({
      projectId,
      label: 'Review gate',
      template: 'Review {{file}} against {{gate}}.',
      variables: [
        { name: 'file', description: 'Path', required: true, defaultValue: null },
        { name: 'gate', description: 'Gate', required: true, defaultValue: 'release' },
      ],
      acceptance: [{ id: 'acc_1', text: 'The gate is explained' }],
    });
    expect(created.ok).toBe(true);
    const prompt = created.ok ? created.data.projects[projectId]?.favorites[0] : undefined;
    expect(prompt).toMatchObject({ label: 'Review gate', version: 1 });
    expect(prompt?.template).toContain('{{file}}');

    const incomplete = service.promptPreview({ projectId, promptId: prompt?.id as string, values: {} });
    expect(incomplete.ok && incomplete.data.ready).toBe(false);
    if (incomplete.ok) expect(incomplete.data.missing).toEqual(['file']);

    const preview = service.promptPreview({
      projectId,
      promptId: prompt?.id as string,
      values: { file: 'src/app.ts' },
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.text).toContain('Review src/app.ts against release.');
      expect(preview.data.text).toContain('## Acceptance criteria');
      expect(preview.data.ready).toBe(true);
    }

    const revised = await service.promptSave({
      projectId,
      id: prompt?.id as string,
      label: 'Review gate',
      template: 'Review {{file}} against {{gate}} and explain gaps.',
      variables: [
        { name: 'file', description: 'Path', required: true, defaultValue: null },
        { name: 'gate', description: 'Gate', required: true, defaultValue: 'release' },
      ],
      acceptance: [{ id: 'acc_1', text: 'The gate is explained' }],
    });
    expect(revised.ok).toBe(true);
    if (revised.ok) expect(revised.data.projects[projectId]?.favorites[0]?.version).toBe(2);

    const packFile = path.join(await tempDir('pack'), 'prompts.json');
    setPaths({ save: packFile });
    const exported = await service.promptExport(projectId);
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.data.count).toBe(1);
      expect(exported.data.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const raw = JSON.parse(await readFile(packFile, 'utf8')) as { kind: string };
    expect(raw.kind).toBe('mona.prompt-pack');

    setPaths({ open: packFile });
    const imported = await service.promptImport(projectId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.data).toMatchObject({ imported: 1, executed: false });
      expect(imported.data.labels).toEqual(['Review gate']);
    }
    expect(ui.view().projects[projectId]?.favorites).toHaveLength(2);
  });
});

describe('MemoryService portable bundles', () => {
  it('exports a handoff and imports it into another folder with requalification', async () => {
    const { service, store, projectId, setPaths } = await setup();
    const tasks = new TaskService(store);
    await tasks.createTask({
      projectId,
      title: 'Portable task',
      promptText: 'Do the portable work.',
      owner: 'mona_queue',
    });
    const file = path.join(await tempDir('handoff'), 'handoff.json');
    setPaths({ save: file });
    const exported = await service.portableExport({ projectId, kind: 'handoff' });
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.data.kind).toBe('handoff');
      expect(exported.data.includedFiles).toEqual([]);
      expect(exported.data.detail).toContain('1 tasks');
    }
    const target = await tempDir('target');
    // A handoff is meant for a clean profile. Import into a second store so the
    // source project's task ids do not collide with the copy.
    const secondDir = await tempDir('second-state');
    const secondStore = new ProjectStore({
      file: path.join(secondDir, 'mona.sqlite'),
      now: () => new Date('2026-11-12T13:00:00.000Z'),
    });
    stores.push(secondStore);
    await applyMigrations(secondStore.database);
    const secondUi = new UiStateStore({ file: path.join(secondDir, 'ui-state.json') });
    const secondService = new MemoryService({
      store: secondStore,
      ui: secondUi,
      artifactRoot: await tempDir('second-artifacts'),
      app: () => APP,
      engine: () => ({
        status: 'stopped',
        detail: 'not started',
        version: null,
        commit: null,
        endpoint: null,
        pid: null,
        compatibility: null,
      }),
      dialogs: {
        saveFile: async () => null,
        openFile: async () => file,
        chooseFolder: async () => target,
      },
      now: () => new Date('2026-11-12T13:00:00.000Z'),
    });
    const imported = await secondService.portableImport({ kind: 'handoff' });
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.data).toMatchObject({
        kind: 'mona.handoff',
        tasksImported: 1,
        requalified: true,
        autoExecuted: false,
      });
      expect(imported.data.projectId).not.toBe(projectId);
      expect(imported.data.targetFolder?.toLowerCase()).toBe(target.toLowerCase());
    }
  });

  it('backs up and restores settings without exposing credentials', async () => {
    const { service, store, setPaths } = await setup();
    await store.saveSettingVersion('route', 1, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      api_key: SECRET,
    });
    const file = path.join(await tempDir('settings'), 'settings.json');
    setPaths({ save: file });
    const exported = await service.portableExport({ projectId: 'unused', kind: 'settings' });
    expect(exported.ok).toBe(true);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('[redacted]');

    setPaths({ open: file });
    const restored = await service.portableImport({ kind: 'settings' });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.data.kind).toBe('settings');
      expect(restored.data.restoredScopes[0]).toMatchObject({ scope: 'route', newVersion: 2 });
    }
    const latest = await store.latestSettingVersion('route');
    expect(latest?.version).toBe(2);
  });

  it('previews diagnostics with the home path and credentials redacted', async () => {
    const { service } = await setup();
    const preview = await service.diagnosticsPreview({ verifyArtifacts: false });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.redacted).toBe(true);
      expect(preview.data.text).not.toContain('victor');
      expect(preview.data.text).not.toContain(SECRET);
      expect(preview.data.text).toContain('C:\\Users\\[user]');
      expect(preview.data.sections.some((section) => section.name === 'Local state')).toBe(true);
    }
  });

  it('treats a cancelled dialog as a refusal, not a crash', async () => {
    const { service, projectId, setPaths } = await setup();
    setPaths({ save: null, open: null, folder: null });
    const exported = await service.portableExport({ projectId, kind: 'handoff' });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.error.message).toMatch(/cancelled/i);
    const imported = await service.portableImport({ kind: 'handoff' });
    expect(imported.ok).toBe(false);
  });
});
