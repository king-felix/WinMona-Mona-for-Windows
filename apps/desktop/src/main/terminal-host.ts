import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { errorResult } from '@mona/contracts';
import {
  TERMINAL_LIMITS,
  type TerminalEvent,
  type TerminalRefresh,
  type TerminalSessionView,
} from '../shared/terminal.js';

export type PtyExitEvent = { exitCode: number; signal?: number };

export type PtyProcess = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(handler: (data: string) => void): void;
  onExit(handler: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type PtySpawnOptions = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty?: boolean;
};

export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

type Session = {
  view: TerminalSessionView;
  process: PtyProcess;
  chunks: string[];
  bytes: number;
  truncated: boolean;
  killed: boolean;
};

type ResolvedPty = { ok: true; factory: PtyFactory; detail: string } | { ok: false; detail: string };

/**
 * Mona-owned Windows terminal. This is a real ConPTY driven by the user; it is
 * deliberately not a runtime route, not a model tool, and not reachable from
 * tool output or Markdown. The engine's own `/v1/terminal` route is tracked
 * separately and stays unavailable on Windows.
 */
export class TerminalHost {
  private readonly injected: PtyFactory | null;
  private readonly emit: (event: TerminalEvent) => void;
  private readonly now: () => Date;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, Session>();
  private resolved: ResolvedPty | null = null;

  constructor(options: {
    emit: (event: TerminalEvent) => void;
    factory?: PtyFactory;
    now?: () => Date;
    environment?: NodeJS.ProcessEnv;
  }) {
    this.emit = options.emit;
    this.injected = options.factory ?? null;
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? process.env;
  }

  /** Whether a real PTY module is usable, with the exact reason either way. */
  availability(): { available: boolean; detail: string } {
    const resolved = this.pty();
    return { available: resolved.ok, detail: resolved.detail };
  }

  list(): TerminalSessionView[] {
    return [...this.sessions.values()].map((session) => ({ ...session.view }));
  }

  create(input: { projectId: string; cwd: string; cols: number; rows: number }): ServiceResult<TerminalSessionView> {
    if (this.sessions.size >= TERMINAL_LIMITS.maxSessions) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          `Mona keeps at most ${TERMINAL_LIMITS.maxSessions} terminal sessions open. Close one first.`,
        ),
      };
    }
    const size = validateSize(input.cols, input.rows);
    if (!size.ok) return size;
    if (!input.cwd || !existsSync(input.cwd)) {
      return {
        ok: false,
        error: errorResult('not_found', 'The project folder no longer exists, so no terminal opened.'),
      };
    }
    const pty = this.pty();
    if (!pty.ok) return { ok: false, error: errorResult('capability_unsupported', pty.detail) };
    const shell = resolveShell(this.environment);
    let child: PtyProcess;
    try {
      child = pty.factory(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: input.cwd,
        env: terminalEnvironment(this.environment),
        useConpty: true,
      });
    } catch (error) {
      return {
        ok: false,
        error: errorResult(
          'capability_unsupported',
          `The terminal process could not start: ${String(error).slice(0, 300)}`,
        ),
      };
    }
    const id = `term_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const session: Session = {
      view: {
        id,
        projectId: input.projectId,
        state: 'running',
        shell: `${shell.file} ${shell.args.join(' ')}`.trim(),
        cwd: input.cwd,
        cols: size.cols,
        rows: size.rows,
        pid: Number.isInteger(child.pid) ? child.pid : null,
        startedAt: this.now().toISOString(),
        exitedAt: null,
        exitCode: null,
        scrollbackBytes: 0,
        scrollbackTruncated: false,
      },
      process: child,
      chunks: [],
      bytes: 0,
      truncated: false,
      killed: false,
    };
    this.sessions.set(id, session);
    child.onData((data) => this.handleData(session, data));
    child.onExit((event) => this.handleExit(session, event));
    this.emit({ kind: 'state', session: { ...session.view } });
    return { ok: true, data: { ...session.view } };
  }

  input(input: { projectId: string; sessionId: string; data: string }): ServiceResult<{ accepted: number }> {
    const found = this.session(input.projectId, input.sessionId);
    if (!found.ok) return found;
    const { session } = found;
    if (session.view.state !== 'running') {
      return { ok: false, error: errorResult('invalid_request', 'That terminal session has already exited.') };
    }
    if (input.data.length === 0) return { ok: true, data: { accepted: 0 } };
    if (Buffer.byteLength(input.data, 'utf8') > TERMINAL_LIMITS.inputBytes) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          `Terminal input is limited to ${TERMINAL_LIMITS.inputBytes} bytes per call; paste a smaller chunk.`,
        ),
      };
    }
    try {
      session.process.write(input.data);
    } catch (error) {
      return {
        ok: false,
        error: errorResult('transport_failed', `Terminal input failed: ${String(error).slice(0, 200)}`),
      };
    }
    return { ok: true, data: { accepted: input.data.length } };
  }

  resize(input: {
    projectId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): ServiceResult<TerminalSessionView> {
    const found = this.session(input.projectId, input.sessionId);
    if (!found.ok) return found;
    const size = validateSize(input.cols, input.rows);
    if (!size.ok) return size;
    const { session } = found;
    if (session.view.state !== 'running') {
      return { ok: false, error: errorResult('invalid_request', 'That terminal session has already exited.') };
    }
    try {
      session.process.resize(size.cols, size.rows);
    } catch (error) {
      return {
        ok: false,
        error: errorResult('transport_failed', `Terminal resize failed: ${String(error).slice(0, 200)}`),
      };
    }
    session.view = { ...session.view, cols: size.cols, rows: size.rows };
    this.emit({ kind: 'state', session: { ...session.view } });
    return { ok: true, data: { ...session.view } };
  }

  kill(input: { projectId: string; sessionId: string }): ServiceResult<TerminalSessionView> {
    const found = this.session(input.projectId, input.sessionId);
    if (!found.ok) return found;
    const { session } = found;
    if (session.view.state === 'running') {
      session.killed = true;
      try {
        session.process.kill();
      } catch {
        // The exit callback still records the outcome; a dead handle is not a new failure.
      }
    }
    return { ok: true, data: { ...session.view } };
  }

  /** Replay bounded output after a renderer reload. Never re-runs anything. */
  refresh(input: { projectId: string; sessionId: string }): ServiceResult<TerminalRefresh> {
    const found = this.session(input.projectId, input.sessionId);
    if (!found.ok) return found;
    const { session } = found;
    return {
      ok: true,
      data: {
        session: { ...session.view },
        data: session.chunks.join(''),
        truncated: session.truncated,
      },
    };
  }

  /** Called on quit: no owned terminal may outlive the app. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      if (session.view.state === 'running') {
        session.killed = true;
        try {
          session.process.kill();
        } catch {
          // Nothing else to do during shutdown.
        }
      }
    }
    this.sessions.clear();
  }

  private pty(): ResolvedPty {
    if (this.resolved) return this.resolved;
    if (this.injected) {
      this.resolved = { ok: true, factory: this.injected, detail: 'A PTY factory is injected (test or probe).' };
      return this.resolved;
    }
    try {
      const loaded = loadNodePty();
      this.resolved = {
        ok: true,
        factory: wrapNodePty(loaded.module),
        detail: `node-pty ${loaded.version} loaded from its shipped prebuilt binary.`,
      };
    } catch (error) {
      this.resolved = { ok: false, detail: `No PTY module is available: ${String(error).slice(0, 300)}` };
    }
    return this.resolved;
  }

  private session(projectId: string, sessionId: string): { ok: true; session: Session } | Failure {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: errorResult('not_found', 'That terminal session is not open.') };
    if (session.view.projectId !== projectId) {
      return {
        ok: false,
        error: errorResult('permission_denied', 'That terminal session belongs to a different project.'),
      };
    }
    return { ok: true, session };
  }

  private handleData(session: Session, data: string): void {
    if (!data) return;
    session.chunks.push(data);
    session.bytes += Buffer.byteLength(data, 'utf8');
    while (session.bytes > TERMINAL_LIMITS.scrollbackBytes && session.chunks.length > 1) {
      const dropped = session.chunks.shift() ?? '';
      session.bytes -= Buffer.byteLength(dropped, 'utf8');
      session.truncated = true;
    }
    session.view = {
      ...session.view,
      scrollbackBytes: session.bytes,
      scrollbackTruncated: session.truncated,
    };
    for (const chunk of splitForEvent(data)) {
      this.emit({
        kind: 'data',
        sessionId: session.view.id,
        data: chunk,
        truncated: session.truncated,
      });
    }
  }

  private handleExit(session: Session, event: PtyExitEvent): void {
    const code = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.view = {
      ...session.view,
      state: 'exited',
      exitedAt: this.now().toISOString(),
      exitCode: code,
    };
    this.emit({
      kind: 'exit',
      session: { ...session.view },
      reason: session.killed ? 'killed' : 'exit',
      detail:
        code === null
          ? 'The terminal ended without an exit code.'
          : code < 0
            ? `The shell was terminated (code ${code}).`
            : `Exited with code ${code}.`,
    });
  }
}

type NodePtyModule = {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
    },
  ): {
    pid: number;
    cols: number;
    rows: number;
    onData(handler: (data: string) => void): void;
    onExit(handler: (event: PtyExitEvent) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
};

/** Adapt node-pty's class instance to the narrow port used above. */
function wrapNodePty(module: NodePtyModule): PtyFactory {
  return (file, args, options) => {
    const child = module.spawn(file, args, options);
    return {
      pid: child.pid,
      cols: child.cols,
      rows: child.rows,
      onData: (handler) => child.onData(handler),
      onExit: (handler) => child.onExit(handler),
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: (signal) => child.kill(signal),
    };
  };
}

function loadNodePty(): { module: NodePtyModule; version: string } {
  const require = createRequire(import.meta.url);
  const module = require('node-pty') as NodePtyModule;
  const version = (require('node-pty/package.json') as { version?: string }).version ?? 'unknown';
  if (typeof module.spawn !== 'function') throw new Error('node-pty did not expose spawn');
  return { module, version };
}

export function resolveShell(environment: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const powershell = joinSystem32(environment, 'WindowsPowerShell\\v1.0\\powershell.exe');
  if (powershell) return { file: powershell, args: ['-NoLogo', '-NoProfile', '-NoExit'] };
  const comspec = environment.COMSPEC?.trim();
  if (comspec && /^[A-Za-z]:\\/.test(comspec) && existsSync(comspec)) return { file: comspec, args: ['/d'] };
  return { file: 'cmd.exe', args: ['/d'] };
}

function joinSystem32(environment: NodeJS.ProcessEnv, relative: string): string | null {
  const root = environment.SystemRoot?.trim();
  if (!root) return null;
  const candidate = `${root}\\System32\\${relative}`;
  return existsSync(candidate) ? candidate : null;
}

/**
 * The terminal inherits the user's own environment, minus credentials that
 * Mona or the engine injected into this process. Those never belong in a shell
 * whose output can be copied elsewhere.
 */
export function terminalEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = new Set([
    'CODEWHALE_RUNTIME_TOKEN',
    'DEEPSEEK_RUNTIME_TOKEN',
    'DEEPSEEK_API_KEY',
    'CODEWHALE_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (blocked.has(key)) continue;
    if (key.startsWith('MONA_') && /TOKEN|KEY|SECRET|PASSWORD/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function validateSize(cols: number, rows: number): { ok: true; cols: number; rows: number } | Failure {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    return { ok: false, error: errorResult('invalid_request', 'Terminal size must be whole numbers.') };
  }
  if (cols < TERMINAL_LIMITS.minCols || cols > TERMINAL_LIMITS.maxCols) {
    return {
      ok: false,
      error: errorResult(
        'invalid_request',
        `Terminal width must be between ${TERMINAL_LIMITS.minCols} and ${TERMINAL_LIMITS.maxCols} columns.`,
      ),
    };
  }
  if (rows < TERMINAL_LIMITS.minRows || rows > TERMINAL_LIMITS.maxRows) {
    return {
      ok: false,
      error: errorResult(
        'invalid_request',
        `Terminal height must be between ${TERMINAL_LIMITS.minRows} and ${TERMINAL_LIMITS.maxRows} rows.`,
      ),
    };
  }
  return { ok: true, cols, rows };
}

function splitForEvent(data: string): string[] {
  if (data.length <= TERMINAL_LIMITS.eventBytes) return [data];
  const chunks: string[] = [];
  for (let index = 0; index < data.length; index += TERMINAL_LIMITS.eventBytes) {
    chunks.push(data.slice(index, index + TERMINAL_LIMITS.eventBytes));
  }
  return chunks;
}
