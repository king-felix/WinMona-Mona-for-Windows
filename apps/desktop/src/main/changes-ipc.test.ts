import { describe, expect, it } from 'vitest';
import { CHANGES_CHANNELS } from '../shared/changes.js';
import type { ChangesService } from './changes-service.js';
import { registerChangesIpc } from './changes-ipc.js';
import type { IpcHandle } from './ipc.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async (projectId: string) => {
      calls.push(`view:${projectId}`);
      return { ok: true as const, data: {} };
    },
    diff: async (projectId: string, file: string) => {
      calls.push(`diff:${projectId}:${file}`);
      return { ok: true as const, data: {} };
    },
    capture: async (projectId: string, label?: string) => {
      calls.push(`capture:${projectId}:${label ?? ''}`);
      return { ok: true as const, data: {} };
    },
  } as unknown as ChangesService;

  const channels = registerChangesIpc({
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

describe('changes IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect([...channels].sort()).toEqual(Object.values(CHANGES_CHANNELS).sort());
  });

  it('rejects an untrusted sender before running any action', async () => {
    const h = harness({ trusted: false });
    const result = await h.invoke(CHANGES_CHANNELS.view, { projectId: 'prj_1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(h.calls).toEqual([]);
  });

  it('rejects unknown fields and wrong shapes', async () => {
    const h = harness();
    const payloads: Array<[string, unknown]> = [
      [CHANGES_CHANNELS.view, {}],
      [CHANGES_CHANNELS.view, { projectId: '' }],
      [CHANGES_CHANNELS.diff, { projectId: 'prj_1' }],
      [CHANGES_CHANNELS.diff, { projectId: 'prj_1', path: 'x'.repeat(2_000) }],
      [CHANGES_CHANNELS.capture, { projectId: 'prj_1', extra: true }],
      [CHANGES_CHANNELS.capture, { projectId: 'prj_1', label: 'x'.repeat(200) }],
    ];
    for (const [channel, payload] of payloads) {
      const result = await h.invoke(channel, payload);
      expect(result, `${channel} ${JSON.stringify(payload).slice(0, 40)}`).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    expect(h.calls).toEqual([]);
  });

  it('delegates a valid call with its typed arguments', async () => {
    const h = harness();
    await h.invoke(CHANGES_CHANNELS.diff, { projectId: 'prj_1', path: 'src/app.ts' });
    await h.invoke(CHANGES_CHANNELS.capture, { projectId: 'prj_1', label: 'task start' });
    expect(h.calls).toEqual(['diff:prj_1:src/app.ts', 'capture:prj_1:task start']);
  });

  it('reports unavailable local state instead of throwing', async () => {
    const h = harness({ service: false });
    const result = await h.invoke(CHANGES_CHANNELS.view, { projectId: 'prj_1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});
