import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p08-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

async function project(store: ProjectStore, label: string): Promise<{ id: string; path: string }> {
  const root = await tempDir(`${label}-folder`);
  const folder = path.join(root, label);
  await mkdir(folder, { recursive: true });
  const outcome = await store.registerProject(folder, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  return { id: outcome.project.id, path: outcome.project.canonicalPath };
}

describe('studio persistence', () => {
  it('ships new migrations without editing the first', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(versions.length).toBeGreaterThanOrEqual(3);
    expect(MIGRATIONS[0]?.sql).not.toContain('timeline_items');
    expect(MIGRATIONS[1]?.sql).toContain('timeline_items');
    expect(MIGRATIONS[2]?.sql).toContain('task_acceptance');
    expect(MIGRATIONS[1]?.sql).not.toContain('task_acceptance');
  });

  it('binds one engine thread per project session and updates the observed profile', async () => {
    const store = await openStore('thread');
    const alpha = await project(store, 'alpha');
    const bound = await store.putStudioThread({
      id: 'thr_engine1',
      projectId: alpha.id,
      engineThreadId: 'thr_engine1',
      workspace: alpha.path,
      sessionId: 'ses_one',
      mode: 'agent',
      profileJson: JSON.stringify({ permissionPosture: 'full_access' }),
    });
    expect(bound.sessionId).toBe('ses_one');
    expect(bound.mode).toBe('agent');

    await store.putStudioThread({
      id: 'thr_engine1',
      projectId: alpha.id,
      engineThreadId: 'thr_engine1',
      workspace: alpha.path,
      sessionId: 'ses_one',
      mode: 'agent',
      profileJson: JSON.stringify({ permissionPosture: 'read_only' }),
    });
    const reread = await store.studioThreadForSession(alpha.id, 'ses_one');
    expect(reread?.profileJson).toContain('read_only');
    expect(await store.countThreads(alpha.id)).toBe(1);
    expect(await store.studioThreadForSession(alpha.id, 'ses_two')).toBeNull();
  });

  it('keeps a replayed engine sequence out of the timeline', async () => {
    const store = await openStore('timeline');
    const alpha = await project(store, 'alpha');
    await store.putStudioThread({
      id: 'thr_timeline',
      projectId: alpha.id,
      engineThreadId: 'thr_timeline',
      workspace: alpha.path,
      sessionId: 'ses_one',
      mode: 'agent',
      profileJson: '{}',
    });

    const first = await store.putTimelineItem({
      id: 'tl_1',
      projectId: alpha.id,
      threadId: 'thr_timeline',
      turnId: 'turn_1',
      seq: 7,
      kind: 'assistant',
      title: 'Assistant',
      body: 'hello',
      status: 'in_progress',
      truncated: false,
    });
    expect(first).toBe('inserted');

    const replay = await store.putTimelineItem({
      id: 'tl_1',
      projectId: alpha.id,
      threadId: 'thr_timeline',
      turnId: 'turn_1',
      seq: 7,
      kind: 'assistant',
      title: 'Assistant',
      body: 'hello world',
      status: 'completed',
      truncated: false,
    });
    expect(replay).toBe('updated');

    const duplicate = await store.putTimelineItem({
      id: 'tl_other',
      projectId: alpha.id,
      threadId: 'thr_timeline',
      turnId: 'turn_1',
      seq: 7,
      kind: 'assistant',
      title: 'Assistant',
      body: 'a second row for the same engine event',
      status: 'completed',
      truncated: false,
    });
    expect(duplicate).toBe('duplicate');

    const items = await store.listTimelineItems('thr_timeline');
    expect(items).toHaveLength(1);
    expect(items[0]?.body).toBe('hello world');
    expect(items[0]?.status).toBe('completed');
  });

  it('advances the thread cursor and records a turn exactly once', async () => {
    const store = await openStore('cursor');
    const alpha = await project(store, 'alpha');
    await store.putStudioThread({
      id: 'thr_cursor',
      projectId: alpha.id,
      engineThreadId: 'thr_cursor',
      workspace: alpha.path,
      sessionId: 'ses_one',
      mode: 'plan',
      profileJson: '{}',
    });
    await store.touchThread('thr_cursor', 42);
    const reread = await store.getStudioThread('thr_cursor');
    expect(reread?.lastSeq).toBe(42);
    expect(reread?.mode).toBe('plan');

    await store.recordTurn({ threadId: 'thr_cursor', engineTurnId: 'turn_abc', status: 'in_progress' });
    await store.recordTurn({ threadId: 'thr_cursor', engineTurnId: 'turn_abc', status: 'completed' });
    const rows = store.database.prepare('SELECT engine_turn_id, status FROM turns').all() as Array<{
      engine_turn_id: string;
      status: string;
    }>;
    expect(rows).toEqual([{ engine_turn_id: 'turn_abc', status: 'completed' }]);
  });

  it('reads the newest saved settings version for a scope', async () => {
    const store = await openStore('settings');
    expect(await store.latestSettingVersion('profile')).toBeNull();
    await store.saveSettingVersion('profile', 1, { label: 'DS Full Access' });
    const latest = await store.latestSettingVersion('profile');
    expect(latest).toEqual({ version: 1, values: { label: 'DS Full Access' } });
  });

  it('cascades timeline rows when a project is removed from the catalog', async () => {
    const store = await openStore('cascade');
    const alpha = await project(store, 'alpha');
    await store.putStudioThread({
      id: 'thr_cascade',
      projectId: alpha.id,
      engineThreadId: 'thr_cascade',
      workspace: alpha.path,
      sessionId: 'ses_one',
      mode: 'agent',
      profileJson: '{}',
    });
    await store.putTimelineItem({
      id: 'tl_cascade',
      projectId: alpha.id,
      threadId: 'thr_cascade',
      turnId: null,
      seq: 1,
      kind: 'status',
      title: 'Turn started',
      body: '',
      status: null,
      truncated: false,
    });
    await store.removeProject(alpha.id);
    const remaining = store.database.prepare('SELECT COUNT(*) AS count FROM timeline_items').get() as {
      count: number;
    };
    expect(Number(remaining.count)).toBe(0);
  });
});
