import { describe, expect, it } from 'vitest';
import { registerExtensionIpc } from './extensions-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { ExtensionsService } from './extensions-service.js';
import { EXTENSION_CHANNELS } from '../shared/extensions.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async (input: { projectId: string }) => {
      calls.push(`view:${input.projectId}`);
      return { ok: true as const, data: { projectId: input.projectId } };
    },
    setMcpEnabled: async (input: { name: string; enabled: boolean; expectedRevision: string }) => {
      calls.push(`set:${input.name}:${input.enabled}:${input.expectedRevision}`);
      return { ok: true as const, data: { verified: true } };
    },
    checkMcpHealth: async (input: { name: string; expectedRevision: string }) => {
      calls.push(`check:${input.name}:${input.expectedRevision}`);
      return { ok: true as const, data: { connected: true } };
    },
  } as unknown as ExtensionsService;
  const channels = registerExtensionIpc({
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

describe('extension IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect(channels.sort()).toEqual(Object.values(EXTENSION_CHANNELS).sort());
  });

  it('validates payloads and rejects an unknown action shape', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(EXTENSION_CHANNELS.get, {})).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(
      await invoke(EXTENSION_CHANNELS.setMcp, {
        projectId: 'prj_1',
        name: 'fixture',
        enabled: 'yes',
        expectedRevision: 'mcp-v1-aaaa',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it('passes the exact revision to the service', async () => {
    const { invoke, calls } = harness();
    const result = await invoke(EXTENSION_CHANNELS.setMcp, {
      projectId: 'prj_1',
      name: 'fixture',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['set:fixture:false:mcp-v1-aaaa']);
  });

  it('refuses an untrusted sender and an unavailable service', async () => {
    const untrusted = harness({ trusted: false });
    expect(await untrusted.invoke(EXTENSION_CHANNELS.get, { projectId: 'prj_1' })).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
    const missing = harness({ service: false });
    expect(await missing.invoke(EXTENSION_CHANNELS.get, { projectId: 'prj_1' })).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  });
});
