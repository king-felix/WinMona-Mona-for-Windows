import type { UiStateView } from './catalog.js';

/**
 * Typed command dispatch. A command is a small, named operation with its own
 * validation: Mona never interpolates command text into a shell, never sends a
 * recognized command to the model, and never simulates a terminal-only result.
 */
export const COMMAND_CHANNELS = {
  dispatch: 'mona:command-dispatch',
} as const;

/** Operations Mona actually owns today. */
export type MonaCommandOperation = 'new-conversation' | 'show-catalog';

export type CommandRefusalCode =
  | 'unknown_command'
  | 'not_routed'
  | 'missing_argument'
  | 'unexpected_argument'
  | 'busy'
  | 'not_found'
  | 'invalid_request'
  | 'internal';

export type CommandReceipt = {
  projectId: string;
  /** Canonical catalog name, without the leading slash. */
  command: string;
  via: 'name' | 'alias';
  status: 'done' | 'refused';
  code: 'ok' | CommandRefusalCode;
  detail: string;
  at: string;
  operation: MonaCommandOperation | null;
  oldSessionId: string | null;
  newSessionId: string | null;
  /** False when only local state changed; the runtime opens a thread on first use. */
  threadCreated: boolean;
  providerRequest: false;
  /** True when this receipt replays an earlier dispatch with the same key. */
  replayed: boolean;
  /** Present for a completed new-conversation operation. */
  ui: UiStateView | null;
};

export type CommandDispatchInput = {
  projectId: string;
  sessionId: string;
  text: string;
  /** One per user action; reused by a retry so a lost ack cannot duplicate work. */
  operationKey: string;
};

export type CommandBridge = {
  commandDispatch(
    input: CommandDispatchInput,
  ): Promise<{ ok: true; data: CommandReceipt } | { ok: false; error: { code: string; message: string } }>;
};
