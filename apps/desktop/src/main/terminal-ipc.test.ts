import { describe, expect, it } from 'vitest';
import { registerTerminalIpc } from './terminal-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { TerminalService } from './terminal-service.js';
import { TERMINAL_CHANNELS, TERMINAL_LIMITS } from '../shared/terminal.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    create: async (input: { projectId: string; cols: number; rows: number }) => {
      calls.push(`create:${input.projectId}:${input.cols}x${input.rows}`);
      return { ok: true as const, data: { id: 'term_1', projectId: input.projectId } };
    },
    input: async (input: { sessionId: string; data: string }) => {
      calls.push(`input:${input.sessionId}:${input.data.length}`);
      return { ok: true as const, data: { accepted: input.data.length } };
    },
    resize: async (input: { cols: number; rows: number }) => {
      calls.push(`resize:${input.cols}x${input.rows}`);
      return { ok: true as const, data: { cols: input.cols, rows: input.rows } };
    },
    kill: async (input: { sessionId: string }) => {
      calls.push(`kill:${input.sessionId}`);
      return { ok: true as const, data: { id: input.sessionId } };
    },
    refresh: async (input: { sessionId: string }) => {
      calls.push(`refresh:${input.sessionId}`);
      return { ok: true as const, data: { data: 'tail' } };
    },
  } as unknown as TerminalService;
  const channels = registerTerminalIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: () => (options.service === false ? null : service),
    clipboard: (text) => {
      calls.push(`copy:${text.length}`);
    },
  });
  const invoke = (channel: string, payload: unknown): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { channels, invoke, calls };
}

describe('terminal IPC surface', () => {
  it('registers exactly the declared invoke channels', () => {
    const { channels } = harness();
    const declared = Object.values(TERMINAL_CHANNELS).filter((channel) => channel !== TERMINAL_CHANNELS.event);
    expect(channels.sort()).toEqual(declared.sort());
  });

  it('writes a user selection to the clipboard through its own channel', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(TERMINAL_CHANNELS.copy, { data: 'PS C:\\> dir' })).toMatchObject({
      ok: true,
      data: { copied: 11 },
    });
    expect(await invoke(TERMINAL_CHANNELS.copy, { data: '' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(calls).toEqual(['copy:11']);
  });

  it('refuses an out-of-range size and an oversized input before the service runs', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(TERMINAL_CHANNELS.create, { projectId: 'prj_1', cols: 2, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      await invoke(TERMINAL_CHANNELS.input, {
        projectId: 'prj_1',
        sessionId: 'term_1',
        data: 'x'.repeat(TERMINAL_LIMITS.inputBytes + 1),
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it('passes a valid create, input and resize through', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(TERMINAL_CHANNELS.create, { projectId: 'prj_1', cols: 100, rows: 30 })).toMatchObject({
      ok: true,
    });
    expect(
      await invoke(TERMINAL_CHANNELS.input, { projectId: 'prj_1', sessionId: 'term_1', data: 'dir\r' }),
    ).toMatchObject({ ok: true });
    expect(
      await invoke(TERMINAL_CHANNELS.resize, { projectId: 'prj_1', sessionId: 'term_1', cols: 120, rows: 40 }),
    ).toMatchObject({ ok: true });
    expect(calls).toEqual(['create:prj_1:100x30', 'input:term_1:4', 'resize:120x40']);
  });

  it('refuses an untrusted sender and an unavailable service', async () => {
    const untrusted = harness({ trusted: false });
    expect(await untrusted.invoke(TERMINAL_CHANNELS.create, { projectId: 'prj_1', cols: 100, rows: 30 })).toMatchObject(
      {
        ok: false,
        error: { code: 'untrusted_sender' },
      },
    );
    const missing = harness({ service: false });
    expect(await missing.invoke(TERMINAL_CHANNELS.create, { projectId: 'prj_1', cols: 100, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  });
});
