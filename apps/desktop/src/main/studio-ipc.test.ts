import { describe, expect, it } from 'vitest';
import { registerStudioIpc } from './studio-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { StudioService } from './studio-service.js';
import { STUDIO_CHANNELS } from '../shared/studio.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async (projectId: string, sessionId: string, mode?: string) => {
      calls.push(`view:${projectId}:${sessionId}:${mode ?? 'any'}`);
      return { ok: true as const, data: { projectId, sessionId } };
    },
    submit: async (input: { projectId: string; text: string; mode: string; references: string[] }) => {
      calls.push(`submit:${input.projectId}:${input.mode}:${input.references.length}`);
      return { ok: true as const, data: { submissionId: 'sub_1' } };
    },
    interrupt: async (projectId: string) => {
      calls.push(`interrupt:${projectId}`);
      return { ok: true as const, data: {} };
    },
    pause: async (projectId: string) => {
      calls.push(`pause:${projectId}`);
      return { ok: true as const, data: {} };
    },
    resume: async (projectId: string) => {
      calls.push(`resume:${projectId}`);
      return { ok: true as const, data: {} };
    },
    references: async (projectId: string) => {
      calls.push(`references:${projectId}`);
      return { ok: true as const, data: { paths: [] } };
    },
  } as unknown as StudioService;

  const channels = registerStudioIpc({
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

const CHANNEL_VALUES = Object.values(STUDIO_CHANNELS)
  .filter((channel) => channel !== STUDIO_CHANNELS.event)
  .sort();

describe('studio IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect([...channels].sort()).toEqual(CHANNEL_VALUES);
  });

  it('rejects an untrusted sender before running any action', async () => {
    const h = harness({ trusted: false });
    const result = await h.invoke(STUDIO_CHANNELS.submit, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      text: 'Do work',
      mode: 'agent',
      references: [],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(h.calls).toEqual([]);
  });

  it('rejects a malformed submission before it reaches the service', async () => {
    const h = harness();
    const result = await h.invoke(STUDIO_CHANNELS.submit, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      text: '',
      mode: 'agent',
      references: [],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(h.calls).toEqual([]);
  });

  it('rejects an unknown mode rather than defaulting silently', async () => {
    const h = harness();
    const result = await h.invoke(STUDIO_CHANNELS.submit, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      text: 'Do work',
      mode: 'execute-everything',
      references: [],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(h.calls).toEqual([]);
  });

  it('refuses every action when local state is unavailable', async () => {
    const h = harness({ service: false });
    const result = await h.invoke(STUDIO_CHANNELS.get, { projectId: 'prj_1', sessionId: 'ses_1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('refuses a renderer-chosen export path: only the native save dialog picks it', async () => {
    const h = harness();
    const result = await h.invoke(STUDIO_CHANNELS.export, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(h.calls).toEqual([]);
  });

  it('passes a validated request through with its mode', async () => {
    const h = harness();
    await h.invoke(STUDIO_CHANNELS.get, { projectId: 'prj_1', sessionId: 'ses_1', mode: 'plan' });
    await h.invoke(STUDIO_CHANNELS.submit, {
      projectId: 'prj_1',
      sessionId: 'ses_1',
      text: 'Plan it',
      mode: 'plan',
      references: ['src/app.ts'],
    });
    await h.invoke(STUDIO_CHANNELS.interrupt, { projectId: 'prj_1' });
    expect(h.calls).toEqual(['view:prj_1:ses_1:plan', 'submit:prj_1:plan:1', 'interrupt:prj_1']);
  });
});
