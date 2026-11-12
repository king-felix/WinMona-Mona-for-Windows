import { execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Process identity is (pid, creation time). A pid alone is reusable, so every
 * lifecycle decision that could terminate a process checks the creation time
 * captured when Mona started it.
 */
export type ProcessProbe = {
  pid: number;
  alive: boolean;
  creationTime: string | null;
  name: string | null;
  executablePath: string | null;
};

export type TerminationOptions = {
  /** Time allowed for the polite tree-termination attempt. */
  graceMs?: number;
  /** Time allowed for the forced tree-termination attempt. */
  forceAfterMs?: number;
  pollMs?: number;
};

export type TerminationResult = {
  pid: number;
  method: 'taskkill' | 'signal' | 'none';
  forced: boolean;
  rootExited: boolean;
  observedDescendants: number[];
  remainingPids: number[];
  outcome: 'stopped' | 'stopped_forced' | 'already_stopped' | 'uncertain';
};

export interface ProcessInspector {
  probe(pid: number): Promise<ProcessProbe>;
  descendants(pid: number): Promise<number[]>;
  terminateTree(pid: number, options?: TerminationOptions): Promise<TerminationResult>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ask the OS for a loopback port with no listener. The caller must still handle
 * a race: the port is re-checked immediately before spawn, and readiness is
 * verified by service identity rather than by "something answered".
 */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not allocate a loopback port'));
      });
    });
  });
}

export async function portOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

type RawProbe = {
  alive?: boolean;
  creationTime?: string | null;
  name?: string | null;
  executablePath?: string | null;
};

const IS_WINDOWS = process.platform === 'win32';
export const platformProcessMechanism = IS_WINDOWS ? 'taskkill-tree' : 'process-group-signal';

/**
 * Windows implementation. Process inspection uses PowerShell/.NET, which is
 * present on supported hosts; termination uses `taskkill /PID <pid> /T`, which
 * walks the OS parent/child relation for that specific pid. No code path selects
 * processes by image name.
 */
async function probeWindows(pid: number): Promise<ProcessProbe> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { Write-Output \'{"alive":false}\'; exit 0 }',
    "$start = $null; try { $start = $p.StartTime.ToUniversalTime().ToString('o') } catch {}",
    '$path = $null; try { $path = $p.Path } catch {}',
    `[pscustomobject]@{ alive = $true; creationTime = $start; name = $p.ProcessName; executablePath = $path } | ConvertTo-Json -Compress`,
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as RawProbe;
    return {
      pid,
      alive: parsed.alive === true,
      creationTime: parsed.creationTime ?? null,
      name: parsed.name ?? null,
      executablePath: parsed.executablePath ?? null,
    };
  } catch {
    const alive = await pidAlive(pid);
    return { pid, alive, creationTime: null, name: null, executablePath: null };
  }
}

async function probePosix(pid: number): Promise<ProcessProbe> {
  const alive = await pidAlive(pid);
  if (!alive) return { pid, alive: false, creationTime: null, name: null, executablePath: null };
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], {
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    const trimmed = stdout.trim();
    const match = /^(.*?)\s{2,}(\S+)$/.exec(trimmed);
    return {
      pid,
      alive: true,
      creationTime: match?.[1] ? new Date(match[1]).toISOString() : null,
      name: match?.[2] ?? null,
      executablePath: null,
    };
  } catch {
    return { pid, alive: true, creationTime: null, name: null, executablePath: null };
  }
}

async function snapshotWindows(): Promise<Array<{ pid: number; parentPid: number }>> {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => row as { ProcessId?: unknown; ParentProcessId?: unknown })
      .filter((row) => typeof row.ProcessId === 'number' && typeof row.ParentProcessId === 'number')
      .map((row) => ({ pid: row.ProcessId as number, parentPid: row.ParentProcessId as number }));
  } catch {
    return [];
  }
}

async function snapshotPosix(): Promise<Array<{ pid: number; parentPid: number }>> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map((parts) => ({ pid: Number(parts[0]), parentPid: Number(parts[1]) }))
      .filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid));
  } catch {
    return [];
  }
}

function collectDescendants(rows: Array<{ pid: number; parentPid: number }>, rootPid: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === rootPid || row.parentPid <= 0) continue;
    const list = byParent.get(row.parentPid) ?? [];
    list.push(row.pid);
    byParent.set(row.parentPid, list);
  }
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

async function terminateWindows(
  pid: number,
  inspector: ProcessInspector,
  options: TerminationOptions,
): Promise<TerminationResult> {
  const graceMs = options.graceMs ?? 1_500;
  const forceAfterMs = options.forceAfterMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  if (!(await pidAlive(pid))) {
    return {
      pid,
      method: 'none',
      forced: false,
      rootExited: true,
      observedDescendants: [],
      remainingPids: [],
      outcome: 'already_stopped',
    };
  }

  const observedDescendants = await inspector.descendants(pid);
  // Capture creation identity before any kill so a reused pid is never forced.
  const identities = new Map<number, string | null>();
  for (const candidate of [pid, ...observedDescendants]) {
    identities.set(candidate, (await inspector.probe(candidate)).creationTime);
  }

  const runTaskkill = async (force: boolean): Promise<void> => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    try {
      await execFileAsync('taskkill', args, { windowsHide: true, timeout: graceMs + 10_000, maxBuffer: 64 * 1024 });
    } catch {
      /* A process that already exited makes taskkill return non-zero; the poll decides. */
    }
  };

  let forced = false;
  await runTaskkill(false);
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (!(await pidAlive(pid))) break;
    await delay(pollMs);
  }
  if (await pidAlive(pid)) {
    forced = true;
    await runTaskkill(true);
  }

  const forceDeadline = Date.now() + forceAfterMs;
  const remaining: number[] = [];
  while (Date.now() < forceDeadline) {
    remaining.length = 0;
    for (const candidate of [pid, ...observedDescendants]) {
      if (!(await pidAlive(candidate))) continue;
      const probe = await inspector.probe(candidate);
      // A live pid whose creation time changed is a stranger, not our child.
      if (probe.alive && probe.creationTime !== null && identities.get(candidate) !== null) {
        if (probe.creationTime !== identities.get(candidate)) continue;
      }
      remaining.push(candidate);
    }
    if (remaining.length === 0) break;
    await delay(pollMs);
  }

  // Bounded last step for descendants that survived the tree walk. Only pids
  // observed as descendants with unchanged creation identity are forced.
  if (remaining.length > 0) {
    for (const candidate of remaining) {
      if (candidate === pid) continue;
      try {
        await execFileAsync('taskkill', ['/PID', String(candidate), '/F'], {
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 32 * 1024,
        });
        forced = true;
      } catch {
        /* reported through remainingPids */
      }
    }
    await delay(pollMs);
    remaining.length = 0;
    for (const candidate of [pid, ...observedDescendants]) {
      if (await pidAlive(candidate)) remaining.push(candidate);
    }
  }

  const rootExited = !(await pidAlive(pid));
  const outcome = remaining.length === 0 ? (forced ? 'stopped_forced' : 'stopped') : 'uncertain';
  return {
    pid,
    method: 'taskkill',
    forced,
    rootExited,
    observedDescendants,
    remainingPids: remaining,
    outcome,
  };
}

async function terminatePosix(
  pid: number,
  inspector: ProcessInspector,
  options: TerminationOptions,
): Promise<TerminationResult> {
  const graceMs = options.graceMs ?? 1_500;
  const forceAfterMs = options.forceAfterMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  if (!(await pidAlive(pid))) {
    return {
      pid,
      method: 'none',
      forced: false,
      rootExited: true,
      observedDescendants: [],
      remainingPids: [],
      outcome: 'already_stopped',
    };
  }
  const observedDescendants = await inspector.descendants(pid);
  let forced = false;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (!(await pidAlive(pid))) break;
    await delay(pollMs);
  }
  if (await pidAlive(pid)) {
    forced = true;
    signalGroup('SIGKILL');
  }
  const forceDeadline = Date.now() + forceAfterMs;
  const remaining: number[] = [];
  while (Date.now() < forceDeadline) {
    remaining.length = 0;
    for (const candidate of [pid, ...observedDescendants]) {
      if (await pidAlive(candidate)) remaining.push(candidate);
    }
    if (remaining.length === 0) break;
    await delay(pollMs);
  }
  const rootExited = !(await pidAlive(pid));
  return {
    pid,
    method: 'signal',
    forced,
    rootExited,
    observedDescendants,
    remainingPids: remaining,
    outcome: remaining.length === 0 ? (forced ? 'stopped_forced' : 'stopped') : 'uncertain',
  };
}

export const systemProcessInspector: ProcessInspector = {
  async probe(pid: number): Promise<ProcessProbe> {
    return IS_WINDOWS ? await probeWindows(pid) : await probePosix(pid);
  },
  async descendants(pid: number): Promise<number[]> {
    const rows = IS_WINDOWS ? await snapshotWindows() : await snapshotPosix();
    return collectDescendants(rows, pid);
  },
  async terminateTree(pid: number, options: TerminationOptions = {}): Promise<TerminationResult> {
    return IS_WINDOWS
      ? await terminateWindows(pid, systemProcessInspector, options)
      : await terminatePosix(pid, systemProcessInspector, options);
  },
};
