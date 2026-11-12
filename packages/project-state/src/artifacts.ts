import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateError } from './errors.js';

export type Retention = 'ephemeral' | 'task' | 'evidence' | 'permanent';

export type ArtifactRecord = {
  sha256: string;
  projectId: string | null;
  relativePath: string;
  bytes: number;
  mediaType: string;
  source: string;
  retention: Retention;
  createdAt: string;
  prunedAt: string | null;
};

export type ArtifactStoreOptions = {
  root: string;
  /** Refuse writes when free space on the volume falls below this. */
  minFreeBytes?: number;
  /** Hard cap for one artifact; larger outputs must be streamed or summarized. */
  maxArtifactBytes?: number;
};

export type PutArtifactInput = {
  content: Buffer | string;
  mediaType: string;
  source: string;
  retention?: Retention;
  projectId?: string | null;
  /** Refuse instead of writing when the bounded content is larger than this. */
  maxBytes?: number;
};

const DEFAULT_MAX = 8 * 1024 * 1024;
const DEFAULT_MIN_FREE = 256 * 1024 * 1024;

/**
 * Large outputs live as bounded files beside the database, addressed by content
 * digest. The database keeps metadata only. A write that would leave the disk
 * nearly full is refused up front, so a full disk cannot silently truncate an
 * artifact or fake completion.
 */
export class ArtifactStore {
  private readonly root: string;
  private readonly minFreeBytes: number;
  private readonly maxArtifactBytes: number;

  constructor(options: ArtifactStoreOptions) {
    this.root = options.root;
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX;
  }

  freeBytes(): number | null {
    try {
      const stats = statfsSync(this.root);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      try {
        const stats = statfsSync(dirname(this.root));
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    }
  }

  put(input: PutArtifactInput, now = new Date()): Omit<ArtifactRecord, 'projectId' | 'prunedAt'> {
    const buffer = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
    const limit = Math.min(input.maxBytes ?? this.maxArtifactBytes, this.maxArtifactBytes);
    if (buffer.byteLength > limit) {
      throw stateError(
        'oversize',
        `artifact is ${buffer.byteLength} bytes, above the ${limit}-byte bound`,
        'Stream or summarize large output instead of storing it whole.',
      );
    }
    const free = this.freeBytes();
    if (free !== null && free - buffer.byteLength < this.minFreeBytes) {
      throw stateError(
        'disk_full',
        'not enough free disk space to keep this artifact safely',
        `${free} bytes free, ${this.minFreeBytes} reserved`,
      );
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const relativePath = join(sha256.slice(0, 2), sha256);
    const absolute = join(this.root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    try {
      statSync(absolute);
    } catch {
      writeFileSync(absolute, buffer, { flag: 'wx' });
    }
    return {
      sha256,
      relativePath,
      bytes: buffer.byteLength,
      mediaType: input.mediaType,
      source: input.source,
      retention: input.retention ?? 'task',
      createdAt: now.toISOString(),
    };
  }

  /** Read with an explicit bound; callers must not load unbounded output. */
  read(relativePath: string, maxBytes = DEFAULT_MAX): Buffer {
    const absolute = this.absolute(relativePath);
    const size = statSync(absolute).size;
    if (size > maxBytes) {
      throw stateError('oversize', `artifact is ${size} bytes, above the ${maxBytes}-byte read bound`);
    }
    return readFileSync(absolute);
  }

  stream(relativePath: string): NodeJS.ReadableStream {
    return createReadStream(this.absolute(relativePath));
  }

  absolute(relativePath: string): string {
    const resolved = join(this.root, relativePath);
    if (!resolved.startsWith(this.root)) {
      throw stateError('invalid_request', 'artifact path escapes the artifact root');
    }
    return resolved;
  }

  /**
   * Retention is explicit. Evidence that explains a blocked or unfinished task
   * is never pruned silently: the caller must pass the protected digests.
   */
  planPrune(
    records: readonly ArtifactRecord[],
    policy: { keep: Retention[]; protectedSha256?: readonly string[]; now?: Date; olderThanMs?: number },
  ): { prunable: ArtifactRecord[]; protectedRecords: ArtifactRecord[] } {
    const now = (policy.now ?? new Date()).getTime();
    const olderThanMs = policy.olderThanMs ?? 0;
    const protectedSet = new Set(policy.protectedSha256 ?? []);
    const prunable: ArtifactRecord[] = [];
    const protectedRecords: ArtifactRecord[] = [];
    for (const record of records) {
      if (record.prunedAt !== null) continue;
      if (policy.keep.includes(record.retention)) continue;
      if (protectedSet.has(record.sha256)) {
        protectedRecords.push(record);
        continue;
      }
      const age = now - Date.parse(record.createdAt);
      if (age < olderThanMs) continue;
      prunable.push(record);
    }
    return { prunable, protectedRecords };
  }

  /** Deletes one artifact file. Refuses protected digests by construction. */
  delete(record: ArtifactRecord, protectedSha256: readonly string[] = []): { deleted: boolean } {
    if (protectedSha256.includes(record.sha256)) {
      throw stateError('conflict', 'artifact is protected by an active blocked task');
    }
    try {
      unlinkSync(this.absolute(record.relativePath));
      return { deleted: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: false };
      throw error;
    }
  }
}
