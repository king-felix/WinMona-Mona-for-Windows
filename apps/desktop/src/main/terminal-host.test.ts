import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TERMINAL_LIMITS, type TerminalEvent } from '../shared/terminal.js';
import {
  TerminalHost,
  resolveShell,
  terminalEnvironment,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnOptions,
} from './terminal-host.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mona-terminal-'));
  roots.push(root);
  return root;
}

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(event: PtyExitEvent) => void> = [];

  constructor(
    readonly pid: number,
    readonly cols: number,
    readonly rows: number,
  ) {}

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (event: PtyExitEvent) => void): void {
    this.exitHandlers.push(handler);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    // Windows reports a terminated console process with this NTSTATUS code.
    this.emitExit({ exitCode: -1073741510 });
  }

  emit(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const handler of this.exitHandlers) handler(event);
  }
}

function harness(options: { spawnThrows?: boolean } = {}) {
  const events: TerminalEvent[] = [];
  const spawned: Array<{ file: string; args: string[]; options: PtySpawnOptions }> = [];
  const pty = new FakePty(4242, 100, 30);
  const host = new TerminalHost({
    emit: (event) => events.push(event),
    now: () => new Date('2026-11-12T12:00:00Z'),
    environment: { SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\bin' },
    factory: (file, args, spawnOptions) => {
      spawned.push({ file, args, options: spawnOptions });
      if (options.spawnThrows) throw new Error('spawn failed for fixture');
      return pty;
    },
  });
  return { host, events, spawned, pty };
}

describe('terminal host', () => {
  it('spawns a ConPTY shell in the project folder and reports a running session', async () => {
    const cwd = await workspace();
    const { host, events, spawned } = harness();
    const result = host.create({ projectId: 'prj_1', cwd, cols: 100, rows: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ projectId: 'prj_1', state: 'running', cwd, cols: 100, rows: 30, pid: 4242 });
    expect(spawned[0]?.options.useConpty).toBe(true);
    expect(spawned[0]?.options.name).toBe('xterm-256color');
    expect(spawned[0]?.options.env.CODEWHALE_RUNTIME_TOKEN).toBeUndefined();
    expect(events[0]).toMatchObject({ kind: 'state' });
  });

  it('refuses a missing folder, an out-of-range size and too many sessions', async () => {
    const cwd = await workspace();
    const { host } = harness();
    expect(host.create({ projectId: 'p', cwd: path.join(cwd, 'gone'), cols: 100, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(host.create({ projectId: 'p', cwd, cols: 5, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(host.create({ projectId: 'p', cwd, cols: 100, rows: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    for (let index = 0; index < TERMINAL_LIMITS.maxSessions; index += 1) {
      expect(host.create({ projectId: 'p', cwd, cols: 100, rows: 30 }).ok).toBe(true);
    }
    expect(host.create({ projectId: 'p', cwd, cols: 100, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('reports a spawn failure as unsupported instead of a running session', async () => {
    const cwd = await workspace();
    const { host } = harness({ spawnThrows: true });
    const result = host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    expect(result).toMatchObject({ ok: false, error: { code: 'capability_unsupported' } });
    expect(host.list()).toHaveLength(0);
  });

  it('writes input, refuses oversized input and enforces project ownership', async () => {
    const cwd = await workspace();
    const { host, pty } = harness();
    const created = host.create({ projectId: 'prj_1', cwd, cols: 100, rows: 30 });
    if (!created.ok) throw new Error(created.error.message);
    expect(host.input({ projectId: 'prj_1', sessionId: created.data.id, data: 'dir\r' })).toEqual({
      ok: true,
      data: { accepted: 4 },
    });
    expect(pty.writes).toEqual(['dir\r']);
    expect(
      host.input({ projectId: 'prj_1', sessionId: created.data.id, data: 'x'.repeat(TERMINAL_LIMITS.inputBytes + 1) }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(host.input({ projectId: 'prj_2', sessionId: created.data.id, data: 'dir' })).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
  });

  it('resizes within bounds and rejects an invalid size', async () => {
    const cwd = await workspace();
    const { host, pty, events } = harness();
    const created = host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    if (!created.ok) throw new Error(created.error.message);
    const resized = host.resize({ projectId: 'p', sessionId: created.data.id, cols: 132, rows: 40 });
    expect(resized.ok && resized.data.cols).toBe(132);
    expect(pty.resizes).toEqual([{ cols: 132, rows: 40 }]);
    expect(events.some((event) => event.kind === 'state' && event.session.cols === 132)).toBe(true);
    expect(host.resize({ projectId: 'p', sessionId: created.data.id, cols: 2, rows: 40 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('records an exit with its code and refuses further input', async () => {
    const cwd = await workspace();
    const { host, pty, events } = harness();
    const created = host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    if (!created.ok) throw new Error(created.error.message);
    pty.emitExit({ exitCode: 7 });
    const exit = events.find((event) => event.kind === 'exit');
    expect(exit).toMatchObject({ kind: 'exit', reason: 'exit', session: { state: 'exited', exitCode: 7 } });
    expect(host.input({ projectId: 'p', sessionId: created.data.id, data: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('marks a killed session as killed, not as a clean exit', async () => {
    const cwd = await workspace();
    const { host, pty, events } = harness();
    const created = host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    if (!created.ok) throw new Error(created.error.message);
    host.kill({ projectId: 'p', sessionId: created.data.id });
    expect(pty.killed).toBe(true);
    const exit = events.find((event) => event.kind === 'exit');
    expect(exit).toMatchObject({ reason: 'killed' });
    expect(exit && exit.kind === 'exit' ? exit.detail : '').toContain('terminated');
  });

  it('bounds scrollback, splits large output and replays the tail on refresh', async () => {
    const cwd = await workspace();
    const { host, pty, events } = harness();
    const created = host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    if (!created.ok) throw new Error(created.error.message);
    const big = 'x'.repeat(TERMINAL_LIMITS.eventBytes + 100);
    pty.emit(big);
    const chunks = events.filter((event) => event.kind === 'data');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((event) => event.kind === 'data' && event.data.length <= TERMINAL_LIMITS.eventBytes)).toBe(
      true,
    );
    for (let index = 0; index < 12; index += 1) pty.emit('y'.repeat(40 * 1024));
    const refreshed = host.refresh({ projectId: 'p', sessionId: created.data.id });
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(refreshed.data.truncated).toBe(true);
    expect(Buffer.byteLength(refreshed.data.data, 'utf8')).toBeLessThanOrEqual(TERMINAL_LIMITS.scrollbackBytes);
    expect(refreshed.data.session.scrollbackTruncated).toBe(true);
  });

  it('kills every owned session on closeAll', async () => {
    const cwd = await workspace();
    const { host } = harness();
    host.create({ projectId: 'p', cwd, cols: 100, rows: 30 });
    host.closeAll();
    expect(host.list()).toHaveLength(0);
  });

  it('strips injected credentials from the shell environment only', () => {
    const env = terminalEnvironment({
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      CODEWHALE_RUNTIME_TOKEN: 'secret-token',
      DEEPSEEK_API_KEY: 'sk-live',
      MONA_FIXTURE_TOKEN: 'nope',
      USERPROFILE: 'C:\\Users\\victor',
    });
    expect(env).toMatchObject({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\victor' });
    expect(env.CODEWHALE_RUNTIME_TOKEN).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.MONA_FIXTURE_TOKEN).toBeUndefined();
  });

  it('resolves a real shell on this machine', () => {
    const shell = resolveShell(process.env);
    expect(shell.file.toLowerCase()).toMatch(/powershell\.exe$|cmd\.exe$/);
    expect(Array.isArray(shell.args)).toBe(true);
  });
});
