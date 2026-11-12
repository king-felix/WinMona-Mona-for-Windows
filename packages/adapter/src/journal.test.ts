import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newOperationKey, newSubmissionId, type SubmissionRecord } from '@mona/contracts';
import { FileSubmissionJournal } from './journal.js';

const THREAD = 'thr_0123456789abcdef0123456789abcdef';
const dirs: string[] = [];

async function record(overrides: Partial<SubmissionRecord> = {}): Promise<SubmissionRecord> {
  return {
    id: newSubmissionId(),
    projectId: 'prj_00000000000000000000000000000000' as SubmissionRecord['projectId'],
    taskId: null,
    threadId: THREAD as SubmissionRecord['threadId'],
    turnId: null,
    operationKey: newOperationKey('turn'),
    state: 'intent_persisted',
    intentPersistedAt: '2026-11-12T00:00:00Z',
    dispatchedAt: null,
    lastObservedAt: '2026-11-12T00:00:00Z',
    reconciliation: { required: false },
    ...overrides,
  };
}

async function journal(): Promise<{ journal: FileSubmissionJournal; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mona-journal-'));
  dirs.push(dir);
  return { journal: new FileSubmissionJournal(dir), dir };
}

afterEach(async () => {
  // Temporary directories are small; the OS cleans them. Keeping this hook
  // explicit documents that no journal writes into the repository.
  dirs.length = 0;
});

describe('file submission journal', () => {
  it('writes, reads, and updates a submission atomically', async () => {
    const { journal: store, dir } = await journal();
    const intent = await record();
    await store.put(intent);
    expect(await store.get(intent.id)).toEqual(intent);
    const accepted = {
      ...intent,
      state: 'accepted' as const,
      turnId: 'turn_0123456789abcdef0123456789abcdef' as SubmissionRecord['turnId'],
    };
    await store.update(accepted);
    expect((await store.get(intent.id))?.state).toBe('accepted');
    const entries = await readdir(dir);
    expect(entries).toEqual([`${intent.id}.json`]);
    const text = await readFile(path.join(dir, `${intent.id}.json`), 'utf8');
    expect(JSON.parse(text).state).toBe('accepted');
  });

  it('finds a submission by thread and operation key', async () => {
    const { journal: store } = await journal();
    const first = await record();
    const second = await record({ operationKey: newOperationKey('other') });
    await store.put(first);
    await store.put(second);
    const found = await store.findByOperationKey(THREAD, first.operationKey);
    expect(found?.id).toBe(first.id);
    expect(await store.findByOperationKey(THREAD, 'missing-key-1234')).toBeNull();
  });

  it('skips a corrupt journal file without losing a good record', async () => {
    const { journal: store, dir } = await journal();
    const good = await record();
    await store.put(good);
    await writeFile(path.join(dir, 'corrupt.json'), '{not json', 'utf8');
    const found = await store.findByOperationKey(THREAD, good.operationKey);
    expect(found?.id).toBe(good.id);
  });

  it('returns null for a missing record', async () => {
    const { journal: store } = await journal();
    expect(await store.get(newSubmissionId())).toBeNull();
  });
});
