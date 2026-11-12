import { SubmissionRecord, type SubmissionId } from '@mona/contracts';
import type { DatabaseSync } from 'node:sqlite';
import type { WriteTransaction } from './store.js';

/**
 * The adapter's `SubmissionJournal` interface is unchanged since P03; only the
 * storage became the single-write-path database, so submission intent commits
 * with its cursor and projection siblings in one transaction.
 */
export type JournalStore = {
  write<T>(fn: (tx: WriteTransaction) => T): Promise<T>;
  read<T>(fn: (db: DatabaseSync) => T): Promise<T>;
};

export class SqliteSubmissionJournal {
  constructor(private readonly store: JournalStore) {}

  async put(record: SubmissionRecord): Promise<void> {
    const parsed = SubmissionRecord.parse(record);
    await this.store.write((tx) => {
      tx.putSubmission(parsed);
    });
  }

  async update(record: SubmissionRecord): Promise<void> {
    await this.put(record);
  }

  async get(id: SubmissionId): Promise<SubmissionRecord | null> {
    return await this.store.read((db) => {
      const row = db.prepare('SELECT intent_json FROM submissions WHERE id = ?').get(id) as
        { intent_json?: string } | undefined;
      if (!row?.intent_json) return null;
      return SubmissionRecord.parse(JSON.parse(row.intent_json));
    });
  }

  async findByOperationKey(threadId: string, operationKey: string): Promise<SubmissionRecord | null> {
    return await this.store.read((db) => {
      const row = db
        .prepare('SELECT intent_json FROM submissions WHERE engine_thread_id = ? AND operation_key = ?')
        .get(threadId, operationKey) as { intent_json?: string } | undefined;
      if (!row?.intent_json) return null;
      return SubmissionRecord.parse(JSON.parse(row.intent_json));
    });
  }
}
