import { describe, expect, it } from 'vitest';
import { registerCapabilityIpc } from './capability-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { CapabilityService } from './capability-service.js';
import { CAPABILITY_CHANNELS } from '../shared/capabilities.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async () => {
      calls.push('view');
      return { ok: true as const, data: { rows: [] } };
    },
    readLog: async (input: { name: string; offset?: number }) => {
      calls.push(`log:${input.name}:${input.offset ?? 0}`);
      return { ok: true as const, data: { name: input.name } };
    },
    checkTerminal: async () => {
      calls.push('terminal');
      return { ok: true as const, data: { statusCode: 501 } };
    },
  } as unknown as CapabilityService;
  const channels = registerCapabilityIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: () => (options.service === false ? null : service),
  });
  const invoke = (channel: string, payload: unknown = {}): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { channels, invoke, calls };
}

describe('capability IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect(channels.sort()).toEqual(Object.values(CAPABILITY_CHANNELS).sort());
  });

  it('validates a log request and refuses a path', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(CAPABILITY_CHANNELS.readLog, { name: '../secret.log' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await invoke(CAPABILITY_CHANNELS.readLog, { name: 'runtime.log', limit: 999_999 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(calls).toEqual([]);
  });

  it('passes a bounded log request through', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(CAPABILITY_CHANNELS.readLog, { name: 'runtime.log', offset: 10 })).toMatchObject({
      ok: true,
    });
    expect(calls).toEqual(['log:runtime.log:10']);
  });

  it('refuses an untrusted sender and an unavailable service', async () => {
    const untrusted = harness({ trusted: false });
    expect(await untrusted.invoke(CAPABILITY_CHANNELS.get)).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
    const missing = harness({ service: false });
    expect(await missing.invoke(CAPABILITY_CHANNELS.get)).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  });
});
