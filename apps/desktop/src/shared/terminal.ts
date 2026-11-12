import type { IpcResult } from './catalog.js';

/**
 * Terminal vocabulary. A terminal session is Mona-owned: it is a local ConPTY
 * driven by the user, not an engine feature and not a model tool. Nothing here
 * can read project state or call the runtime API.
 */

export const TERMINAL_CHANNELS = {
  create: 'mona:terminal-create',
  input: 'mona:terminal-input',
  resize: 'mona:terminal-resize',
  kill: 'mona:terminal-kill',
  refresh: 'mona:terminal-refresh',
  /** Writes a user selection to the OS clipboard. The only clipboard path. */
  copy: 'mona:terminal-copy',
  /** Main-process push: output, exit and state changes. */
  event: 'mona:terminal-event',
} as const;

export const TERMINAL_LIMITS = {
  /** Bytes of scrollback kept in main for reconnect replay. */
  scrollbackBytes: 256 * 1024,
  /** Largest single input call accepted from the renderer. */
  inputBytes: 8 * 1024,
  /** Largest single output chunk forwarded per event. */
  eventBytes: 32 * 1024,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  /** Concurrent sessions across the whole app. */
  maxSessions: 4,
} as const;

export type TerminalState = 'running' | 'exited';

export type TerminalSessionView = {
  id: string;
  projectId: string;
  state: TerminalState;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  /** Bytes currently held for reconnect replay. */
  scrollbackBytes: number;
  /** True once older output has been dropped from the replay buffer. */
  scrollbackTruncated: boolean;
};

export type TerminalEvent =
  | { kind: 'data'; sessionId: string; data: string; truncated: boolean }
  | { kind: 'state'; session: TerminalSessionView }
  | { kind: 'exit'; session: TerminalSessionView; reason: 'exit' | 'killed' | 'error'; detail: string | null };

export type TerminalRefresh = {
  session: TerminalSessionView;
  data: string;
  truncated: boolean;
};

export type TerminalBridge = {
  terminalCreate(input: { projectId: string; cols: number; rows: number }): Promise<IpcResult<TerminalSessionView>>;
  terminalInput(input: {
    projectId: string;
    sessionId: string;
    data: string;
  }): Promise<IpcResult<{ accepted: number }>>;
  terminalResize(input: {
    projectId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): Promise<IpcResult<TerminalSessionView>>;
  terminalKill(input: { projectId: string; sessionId: string }): Promise<IpcResult<TerminalSessionView>>;
  terminalRefresh(input: { projectId: string; sessionId: string }): Promise<IpcResult<TerminalRefresh>>;
  terminalCopy(input: { data: string }): Promise<IpcResult<{ copied: number }>>;
  onTerminalEvent(handler: (event: TerminalEvent) => void): () => void;
};
