import { describe, expect, it } from 'vitest';
import { registerProviderIpc } from './provider-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { ProviderWorkbenchService } from './provider-workbench.js';
import { PROVIDER_CHANNELS } from '../shared/provider.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async (input: { projectId: string; providerId?: string }) => {
      calls.push(`view:${input.projectId}:${input.providerId ?? 'default'}`);
      return { ok: true as const, data: { projectId: input.projectId } };
    },
    applyRoute: async (input: { provider: string; model: string; expectedRevision: string }) => {
      calls.push(`route:${input.provider}:${input.model}:${input.expectedRevision}`);
      return { ok: true as const, data: { verified: true } };
    },
    applyPermission: async (input: { posture: string }) => {
      calls.push(`permission:${input.posture}`);
      return { ok: true as const, data: { verified: true } };
    },
    applyMode: async (input: { mode: string }) => {
      calls.push(`mode:${input.mode}`);
      return { ok: true as const, data: { verified: true } };
    },
  } as unknown as ProviderWorkbenchService;
  const channels = registerProviderIpc({
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

describe('provider IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect(channels.sort()).toEqual(Object.values(PROVIDER_CHANNELS).sort());
  });

  it('validates the route payload and rejects an unknown posture', async () => {
    const { invoke, calls } = harness();
    const bad = await invoke(PROVIDER_CHANNELS.applyRoute, { projectId: 'prj_1' });
    expect(bad).toMatchObject({ ok: false });
    const badPermission = await invoke(PROVIDER_CHANNELS.applyPermission, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      posture: 'superuser',
      expectedRevision: 'sha256:x',
    });
    expect(badPermission).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('passes a model choice with the exact revision', async () => {
    const { invoke, calls } = harness();
    const result = await invoke(PROVIDER_CHANNELS.applyRoute, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      expectedRevision: 'sha256:abc',
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['route:deepseek:deepseek-chat:sha256:abc']);
  });

  it('refuses an untrusted sender and an unavailable service', async () => {
    const untrusted = harness({ trusted: false });
    expect(await untrusted.invoke(PROVIDER_CHANNELS.get, { projectId: 'prj_1', sessionId: 'ses_1' })).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
    const missing = harness({ service: false });
    expect(await missing.invoke(PROVIDER_CHANNELS.get, { projectId: 'prj_1', sessionId: 'ses_1' })).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  });
});
