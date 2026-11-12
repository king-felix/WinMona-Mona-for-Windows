import { describe, expect, it } from 'vitest';
import type { IpcHandle } from './ipc.js';
import { registerMemoryIpc } from './memory-ipc.js';
import type { MemoryService } from './memory-service.js';
import { MEMORY_CHANNELS } from '../shared/memory.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    search: async (input: { mode: string; query: string }) => {
      calls.push(`search:${input.mode}:${input.query}`);
      return { ok: true as const, data: { hits: [] } };
    },
    reindex: async (projectId: string) => {
      calls.push(`reindex:${projectId}`);
      return { ok: true as const, data: { documents: 0 } };
    },
    promptSave: (input: { label: string }) => {
      calls.push(`save:${input.label}`);
      return { ok: true as const, data: {} };
    },
    promptRemove: (input: { promptId: string }) => {
      calls.push(`remove:${input.promptId}`);
      return { ok: true as const, data: {} };
    },
    promptPreview: (input: { promptId: string; values: Record<string, string> }) => {
      calls.push(`preview:${input.promptId}:${Object.keys(input.values).join(',')}`);
      return { ok: true as const, data: {} };
    },
    promptImport: async (projectId: string) => {
      calls.push(`import:${projectId}`);
      return { ok: true as const, data: {} };
    },
    promptExport: async (projectId: string) => {
      calls.push(`export:${projectId}`);
      return { ok: true as const, data: {} };
    },
    portableExport: async (input: { kind: string }) => {
      calls.push(`portable-export:${input.kind}`);
      return { ok: true as const, data: {} };
    },
    portableImport: async (input: { kind: string }) => {
      calls.push(`portable-import:${input.kind}`);
      return { ok: true as const, data: {} };
    },
    diagnosticsPreview: async (input: { verifyArtifacts?: boolean }) => {
      calls.push(`diagnostics:${input.verifyArtifacts === true}`);
      return { ok: true as const, data: {} };
    },
  } as unknown as MemoryService;
  const channels = registerMemoryIpc({
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

describe('memory IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect(channels.sort()).toEqual(Object.values(MEMORY_CHANNELS).sort());
  });

  it('refuses an untrusted sender before validating the payload', async () => {
    const { invoke, calls } = harness({ trusted: false });
    expect(await invoke(MEMORY_CHANNELS.search, { projectId: 'prj_a', query: 'x', mode: 'history' })).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
    expect(calls).toEqual([]);
  });

  it('validates search requests and passes a bounded one through', async () => {
    const { invoke, calls } = harness();
    expect(await invoke(MEMORY_CHANNELS.search, { projectId: 'prj_a', query: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await invoke(MEMORY_CHANNELS.search, { projectId: 'prj_a', query: 'x', mode: 'everything' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      await invoke(MEMORY_CHANNELS.search, { projectId: 'prj_a', query: 'zephyr', mode: 'history', limit: 5 }),
    ).toMatchObject({
      ok: true,
    });
    expect(calls).toEqual(['search:history:zephyr']);
  });

  it('validates prompt input and portable kinds', async () => {
    const { invoke, calls } = harness();
    expect(
      await invoke(MEMORY_CHANNELS.promptSave, {
        projectId: 'prj_a',
        label: 'Good',
        template: 'Review {{file}}',
        variables: [{ name: 'bad name', description: '', required: true, defaultValue: null }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await invoke(MEMORY_CHANNELS.portableExport, { projectId: 'prj_a', kind: 'everything' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await invoke(MEMORY_CHANNELS.portableExport, { projectId: 'prj_a', kind: 'handoff' })).toMatchObject({
      ok: true,
    });
    expect(calls).toEqual(['portable-export:handoff']);
  });

  it('passes a preview with values and a default diagnostics request', async () => {
    const { invoke, calls } = harness();
    await invoke(MEMORY_CHANNELS.promptPreview, {
      projectId: 'prj_a',
      promptId: 'pfv_1',
      values: { file: 'src/app.ts' },
    });
    await invoke(MEMORY_CHANNELS.diagnosticsPreview, {});
    expect(calls).toEqual(['preview:pfv_1:file', 'diagnostics:false']);
  });

  it('reports unavailable state instead of throwing when the service is missing', async () => {
    const { invoke } = harness({ service: false });
    expect(await invoke(MEMORY_CHANNELS.reindex, { projectId: 'prj_a' })).toMatchObject({
      ok: false,
      error: { code: 'internal', retryable: true },
    });
  });
});
