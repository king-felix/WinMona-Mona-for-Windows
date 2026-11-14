import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';

/**
 * Stored-history paging. These fixtures are synthetic rows written in one
 * transaction so the 10 000-row case exercises the query, not the write path.
 */

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-paging-${label}-`));
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

async function project(store: ProjectStore, label: string): Promise<string> {
  const root = await tempDir(`${label}-folder`);
  const folder = path.join(root, label);
  await mkdir(folder, { recursive: true });
  const outcome = await store.registerProject(folder, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  return outcome.project.id;
}

const THREAD_A = `thr_${'a'.repeat(32)}`;
const THREAD_B = `thr_${'b'.repeat(32)}`;

async function seed(
  store: ProjectStore,
  projectId: string,
  threadId: string,
  count: number,
  options: { startSeq?: number; label?: string } = {},
): Promise<void> {
  const start = options.startSeq ?? 1;
  const label = options.label ?? 'row';
  await store.write((tx) => {
    const statement = tx.db.prepare(
      `INSERT INTO timeline_items(id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    for (let index = 0; index < count; index += 1) {
      const seq = start + index;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString();
      statement.run(
        `tl_${threadId}_${seq}`,
        projectId,
        threadId,
        seq,
        'assistant',
        `Row ${seq}`,
        `${label}-${String(seq).padStart(4, '0')}`,
        'completed',
        at,
        at,
      );
    }
  });
}

describe('stored history paging', () => {
  it('returns the newest window first and pages back to the beginning', async () => {
    const store = await openStore('pages');
    const projectId = await project(store, 'alpha');
    const total = 10_050;
    await seed(store, projectId, THREAD_A, total);

    const newest = await store.timelinePage(THREAD_A, { limit: 500 });
    expect(newest.items).toHaveLength(500);
    expect(newest.items[0]?.seq).toBe(total - 499);
    expect(newest.items[newest.items.length - 1]?.seq).toBe(total);
    expect(newest.total).toBe(total);
    expect(newest.hasOlder).toBe(true);
    expect(newest.hasNewer).toBe(false);

    const older = await store.timelinePage(THREAD_A, { beforeSeq: total - 499, limit: 500 });
    expect(older.items[0]?.seq).toBe(total - 999);
    expect(older.items[older.items.length - 1]?.seq).toBe(total - 500);
    expect(older.hasOlder).toBe(true);
    expect(older.hasNewer).toBe(true);

    // Walking back from the oldest edge reaches row 1 and then stops.
    const last = await store.timelinePage(THREAD_A, { beforeSeq: 101, limit: 500 });
    expect(last.items[0]?.seq).toBe(1);
    expect(last.items).toHaveLength(100);
    expect(last.hasOlder).toBe(false);
  });

  it('walks the whole thread exactly once, in order, without loading it all at once', async () => {
    const store = await openStore('iterate');
    const projectId = await project(store, 'beta');
    await seed(store, projectId, THREAD_A, 3_000);

    const seen: number[] = [];
    let chunks = 0;
    for await (const rows of store.iterateTimelineItems(THREAD_A, 500)) {
      chunks += 1;
      expect(rows.length).toBeLessThanOrEqual(500);
      seen.push(...rows.map((row) => row.seq));
    }
    expect(chunks).toBe(6);
    expect(seen).toHaveLength(3_000);
    expect(new Set(seen).size).toBe(3_000);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBe(3_000);
  });

  it('centres a window on a sequence number and keeps both directions honest', async () => {
    const store = await openStore('around');
    const projectId = await project(store, 'gamma');
    await seed(store, projectId, THREAD_A, 1_000);

    const page = await store.timelinePage(THREAD_A, { aroundSeq: 500, limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.items.some((row) => row.seq === 500)).toBe(true);
    expect(page.items[0]?.seq).toBeLessThan(500);
    expect(page.items[page.items.length - 1]?.seq).toBeGreaterThan(500);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(true);
  });

  it('searches stored text across the whole thread and never returns another thread', async () => {
    const store = await openStore('search');
    const projectId = await project(store, 'delta');
    await seed(store, projectId, THREAD_A, 2_000);
    await seed(store, projectId, THREAD_B, 10, { label: 'other-thread' });

    const match = await store.searchTimelineItems(THREAD_A, 'row-0117', 50);
    expect(match.total).toBe(1);
    expect(match.matches[0]?.seq).toBe(117);
    expect(match.matches[0]?.threadId).toBe(THREAD_A);

    const other = await store.searchTimelineItems(THREAD_A, 'other-thread', 50);
    expect(other.total).toBe(0);

    // LIKE wildcards in the query are matched literally, not as patterns.
    const wildcard = await store.searchTimelineItems(THREAD_A, '%', 50);
    expect(wildcard.total).toBe(0);
  });

  it('moves a known row to its later sequence instead of inserting a second card', async () => {
    const store = await openStore('settle');
    const projectId = await project(store, 'epsilon');
    await seed(store, projectId, THREAD_A, 1);

    const base = {
      id: `tl_${THREAD_A}_1`,
      projectId,
      threadId: THREAD_A,
      turnId: null,
      kind: 'assistant',
      title: 'Assistant',
      status: 'streaming',
      truncated: false,
    };
    expect(await store.putTimelineItem({ ...base, seq: 1, body: 'MONA' })).toBe('updated');
    expect(await store.putTimelineItem({ ...base, seq: 2, body: 'MONA_OK', status: 'completed' })).toBe('updated');

    const page = await store.timelinePage(THREAD_A, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.seq).toBe(2);
    expect(page.items[0]?.body).toBe('MONA_OK');
    expect(await store.countTimelineItems(THREAD_A)).toBe(1);
  });

  it('refuses to overwrite a different row that already owns the sequence', async () => {
    const store = await openStore('duplicate');
    const projectId = await project(store, 'zeta');
    await seed(store, projectId, THREAD_A, 1);

    const outcome = await store.putTimelineItem({
      id: `tl_${THREAD_A}_other`,
      projectId,
      threadId: THREAD_A,
      turnId: null,
      seq: 1,
      kind: 'assistant',
      title: 'Assistant',
      body: 'a replay must not replace the stored row',
      status: 'completed',
      truncated: false,
    });
    expect(outcome).toBe('duplicate');
    const page = await store.timelinePage(THREAD_A, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.body).toBe('row-0001');
  });
});
