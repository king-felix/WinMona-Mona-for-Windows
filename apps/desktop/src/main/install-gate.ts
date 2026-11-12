/**
 * A small, honest signal for the per-user installer.
 *
 * The installer must never interrupt work. It therefore needs to know whether
 * Mona is running, and whether a task is in flight. Mona writes one JSON file
 * next to its runtime ownership data; the installer reads it and also checks
 * that the recorded process is still alive, so a crash leaves no false claim.
 *
 * This file is local state only: no network, no inference, no timer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ACTIVE_RUN_STATES = ['preparing', 'running', 'interrupting', 'awaiting_approval'] as const;

export type InstallActivity = {
  schema: 1;
  pid: number;
  version: string;
  state: 'idle' | 'active';
  projectId: string | null;
  runState: string | null;
  updatedUtc: string;
};

export function activityFile(userData: string): string {
  return path.join(userData, 'runtime', 'activity.json');
}

export function isActiveRunState(runState: string | null | undefined): boolean {
  return typeof runState === 'string' && (ACTIVE_RUN_STATES as readonly string[]).includes(runState);
}

/** Write through a temporary file so the installer never reads a half record. */
export function writeActivity(file: string, record: InstallActivity): InstallActivity {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return record;
}

export function readActivity(file: string): InstallActivity | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstallActivity>;
    if (parsed.schema !== 1 || typeof parsed.pid !== 'number') return null;
    if (parsed.state !== 'active' && parsed.state !== 'idle') return null;
    return {
      schema: 1,
      pid: parsed.pid,
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      state: parsed.state,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      runState: typeof parsed.runState === 'string' ? parsed.runState : null,
      updatedUtc: typeof parsed.updatedUtc === 'string' ? parsed.updatedUtc : 'unknown',
    };
  } catch {
    return null;
  }
}

export function clearActivity(file: string): void {
  for (const target of [file, `${file}.tmp`]) {
    try {
      rmSync(target, { force: true });
    } catch {
      // An unusable path or a locked file is not a reason to fail a quit.
    }
  }
}

export type ActivityRecorderDeps = {
  file: string;
  pid?: number;
  version: string;
  now?: () => Date;
};

/**
 * Records the current run state. A quit clears the file; a crash leaves it
 * behind, which the installer resolves by checking the process id.
 */
export class ActivityRecorder {
  private readonly deps: ActivityRecorderDeps;
  private last: InstallActivity | null = null;

  constructor(deps: ActivityRecorderDeps) {
    this.deps = deps;
  }

  record(runState: string | null, projectId: string | null = null): InstallActivity {
    const state = isActiveRunState(runState) ? 'active' : 'idle';
    const next: InstallActivity = {
      schema: 1,
      pid: this.deps.pid ?? process.pid,
      version: this.deps.version,
      state,
      projectId,
      runState: runState ?? null,
      updatedUtc: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    const unchanged =
      this.last !== null &&
      this.last.state === next.state &&
      this.last.projectId === next.projectId &&
      this.last.runState === next.runState;
    this.last = next;
    if (unchanged) return next;
    try {
      writeActivity(this.deps.file, next);
    } catch {
      // Activity reporting must never be able to break a task. The installer
      // falls back to process inspection when the file is missing.
      this.last = null;
    }
    return next;
  }

  clear(): void {
    this.last = null;
    try {
      clearActivity(this.deps.file);
    } catch {
      // Nothing to do: a stale file is resolved by the liveness check.
    }
  }

  current(): InstallActivity | null {
    return this.last;
  }
}
