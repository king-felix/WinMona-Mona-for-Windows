import { describe, expect, it } from 'vitest';
import { registerCommandIpc } from './command-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { CommandService } from './command-service.js';
import { COMMAND_CHANNELS } from '../shared/commands.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    dispatch: async (input: Record<string, unknown>) => {
      calls.push(input);
      return { ok: true as const, data: { status: 'done', command: 'new', operation: 'new-conversation' } };
    },
  } as unknown as CommandService;

  const channels = registerCommandIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: () => (options.service === false ? null : service),
  });

  const invoke = (channel: string, payload: unknown): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { channels, invoke, calls };
}

const valid = {
  projectId: 'prj_1',
  sessionId: 'ses_1',
  text: '/new',
  operationKey: 'cmd_0123456789abcdef',
};

describe('command IPC surface', () => {
  it('registers exactly one typed dispatch channel', () => {
    const { channels } = harness();
    expect([...channels]).toEqual([COMMAND_CHANNELS.dispatch]);
  });

  it('rejects an untrusted sender before the service runs', async () => {
    const h = harness({ trusted: false });
    const result = await h.invoke(COMMAND_CHANNELS.dispatch, valid);
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(h.calls).toEqual([]);
  });

  it('refuses an unknown field, a short key, a long text or an empty project', async () => {
    const h = harness();
    const cases = [
      { ...valid, path: 'C:\\Windows' },
      { ...valid, operationKey: 'short' },
      { ...valid, operationKey: 'bad key' },
      { ...valid, text: 'x'.repeat(1_001) },
      { ...valid, projectId: '' },
      { ...valid, sessionId: '' },
      { ...valid, text: '' },
    ];
    for (const payload of cases) {
      const result = await h.invoke(COMMAND_CHANNELS.dispatch, payload);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(h.calls).toEqual([]);
  });

  it('passes a validated dispatch through unchanged', async () => {
    const h = harness();
    await h.invoke(COMMAND_CHANNELS.dispatch, valid);
    expect(h.calls).toEqual([valid]);
  });

  it('refuses every dispatch when local state is unavailable', async () => {
    const h = harness({ service: false });
    const result = await h.invoke(COMMAND_CHANNELS.dispatch, valid);
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});
