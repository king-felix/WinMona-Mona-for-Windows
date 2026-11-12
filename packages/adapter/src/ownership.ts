import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Machine-local ownership record for one owned runtime. It deliberately stores
 * no token: only a digest, so a copied state directory cannot impersonate a
 * runtime. Records live under the app's private data directory, never in a
 * project repository.
 */
export const RuntimeOwnershipRecord = z
  .object({
    schema_version: z.literal(1),
    runtime_id: z.string().regex(/^rt_[0-9a-f]{24}$/),
    workspace: z.string().min(1),
    workspace_key: z.string().regex(/^[0-9a-f]{24}$/),
    executable: z.string().min(1),
    executable_real_path: z.string().min(1),
    executable_size: z.number().int().nonnegative(),
    executable_mtime_ms: z.number().nonnegative(),
    version: z.string().min(1),
    commit: z.string().min(7),
    pid: z.number().int().positive(),
    process_creation_time: z.string().min(1).nullable(),
    parent_pid: z.number().int().positive().nullable(),
    desktop_instance_id: z.string().min(8),
    endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    started_at: z.string().min(1),
    updated_at: z.string().min(1),
    state: z.enum(['starting', 'running', 'crashed', 'stopped', 'stale']),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type RuntimeOwnershipRecord = z.infer<typeof RuntimeOwnershipRecord>;

export type OwnershipReadResult =
  { ok: true; record: RuntimeOwnershipRecord } | { ok: false; reason: 'missing' | 'invalid'; detail?: string };

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function workspaceKeyFor(normalizedWorkspace: string): string {
  return createHash('sha256').update(normalizedWorkspace, 'utf8').digest('hex').slice(0, 24);
}

export function normalizeWorkspacePath(workspace: string): string {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function resolveWorkspace(workspace: string): Promise<string | null> {
  try {
    const { realpath, stat } = await import('node:fs/promises');
    const real = await realpath(workspace);
    const info = await stat(real);
    if (!info.isDirectory()) return null;
    return normalizeWorkspacePath(real);
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export class OwnershipStore {
  constructor(private readonly root: string) {}

  directory(): string {
    return path.join(this.root, 'runtime-ownership');
  }

  fileFor(workspaceKey: string): string {
    return path.join(this.directory(), `${workspaceKey}.json`);
  }

  async write(record: RuntimeOwnershipRecord): Promise<void> {
    await mkdir(this.directory(), { recursive: true });
    const parsed = RuntimeOwnershipRecord.parse(record);
    await writeAtomic(this.fileFor(parsed.workspace_key), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async read(workspaceKey: string): Promise<OwnershipReadResult> {
    try {
      const text = await readFile(this.fileFor(workspaceKey), 'utf8');
      const parsed = RuntimeOwnershipRecord.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return { ok: false, reason: 'invalid', detail: parsed.error.issues.map((issue) => issue.message).join('; ') };
      }
      return { ok: true, record: parsed.data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'invalid', detail: String(error).slice(0, 300) };
    }
  }

  async list(): Promise<{ records: RuntimeOwnershipRecord[]; invalid: string[] }> {
    let entries: string[];
    try {
      entries = await readdir(this.directory());
    } catch {
      return { records: [], invalid: [] };
    }
    const records: RuntimeOwnershipRecord[] = [];
    const invalid: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const key = entry.slice(0, -'.json'.length);
      const result = await this.read(key);
      if (result.ok) records.push(result.record);
      else if (result.reason === 'invalid') invalid.push(entry);
    }
    return { records, invalid };
  }

  async remove(workspaceKey: string): Promise<void> {
    try {
      await unlink(this.fileFor(workspaceKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function emptyRecord(input: {
  runtimeId: string;
  workspace: string;
  workspaceKey: string;
  executable: string;
  executableRealPath: string;
  executableSize: number;
  executableMtimeMs: number;
  version: string;
  commit: string;
  pid: number;
  processCreationTime: string | null;
  parentPid: number | null;
  desktopInstanceId: string;
  endpoint: string;
  token: string;
  startedAt: string;
  state: RuntimeOwnershipRecord['state'];
  reason?: string;
}): RuntimeOwnershipRecord {
  return RuntimeOwnershipRecord.parse({
    schema_version: 1,
    runtime_id: input.runtimeId,
    workspace: input.workspace,
    workspace_key: input.workspaceKey,
    executable: input.executable,
    executable_real_path: input.executableRealPath,
    executable_size: input.executableSize,
    executable_mtime_ms: input.executableMtimeMs,
    version: input.version,
    commit: input.commit,
    pid: input.pid,
    process_creation_time: input.processCreationTime,
    parent_pid: input.parentPid,
    desktop_instance_id: input.desktopInstanceId,
    endpoint: input.endpoint,
    token_sha256: tokenDigest(input.token),
    started_at: input.startedAt,
    updated_at: input.startedAt,
    state: input.state,
    ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
  });
}
