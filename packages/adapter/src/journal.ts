import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SubmissionRecord, type SubmissionId } from '@mona/contracts';

/**
 * Durable submission intent. P03 provides an atomic JSON-file journal; P05
 * replaces this with the transactional project store. The interface is kept
 * small so the replacement does not touch adapter logic.
 */
export interface SubmissionJournal {
  put(record: SubmissionRecord): Promise<void>;
  get(id: SubmissionId): Promise<SubmissionRecord | null>;
  update(record: SubmissionRecord): Promise<void>;
  findByOperationKey(threadId: string, operationKey: string): Promise<SubmissionRecord | null>;
}

export class MemorySubmissionJournal implements SubmissionJournal {
  private readonly records = new Map<string, SubmissionRecord>();

  async put(record: SubmissionRecord): Promise<void> {
    this.records.set(record.id, SubmissionRecord.parse(record));
  }

  async get(id: SubmissionId): Promise<SubmissionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async update(record: SubmissionRecord): Promise<void> {
    this.records.set(record.id, SubmissionRecord.parse(record));
  }

  async findByOperationKey(threadId: string, operationKey: string): Promise<SubmissionRecord | null> {
    for (const record of this.records.values()) {
      if (record.threadId === threadId && record.operationKey === operationKey) return record;
    }
    return null;
  }
}

const MAX_SCAN = 10_000;

export class FileSubmissionJournal implements SubmissionJournal {
  constructor(private readonly directory: string) {}

  async put(record: SubmissionRecord): Promise<void> {
    await this.write(record);
  }

  async update(record: SubmissionRecord): Promise<void> {
    await this.write(record);
  }

  async get(id: SubmissionId): Promise<SubmissionRecord | null> {
    try {
      const text = await readFile(this.fileFor(id), 'utf8');
      return SubmissionRecord.parse(JSON.parse(text));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async findByOperationKey(threadId: string, operationKey: string): Promise<SubmissionRecord | null> {
    const entries = await readdir(this.directory).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    const files = entries.filter((name) => name.endsWith('.json')).slice(0, MAX_SCAN);
    for (const name of files) {
      try {
        const text = await readFile(path.join(this.directory, name), 'utf8');
        const record = SubmissionRecord.parse(JSON.parse(text));
        if (record.threadId === threadId && record.operationKey === operationKey) return record;
      } catch {
        // A corrupt journal entry is skipped here; P05's store will surface it.
      }
    }
    return null;
  }

  private fileFor(id: SubmissionId): string {
    return path.join(this.directory, `${id}.json`);
  }

  private async write(record: SubmissionRecord): Promise<void> {
    const parsed = SubmissionRecord.parse(record);
    await mkdir(this.directory, { recursive: true });
    const target = this.fileFor(parsed.id);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, target);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'ENOTDIR')
  );
}
