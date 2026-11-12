import { describe, expect, it } from 'vitest';
import type { CatalogService } from './catalog-service.js';
import { registerCatalogIpc } from './catalog-ipc.js';
import type { IpcHandle } from './ipc.js';
import { CATALOG_CHANNELS, PROJECT_VIEWS } from '../shared/catalog.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    list: async () => {
      calls.push('list');
      return { ok: true as const, data: [] };
    },
    open: async (target: string) => {
      calls.push(`open:${target}`);
      return { ok: true as const, data: { status: 'created', project: {} } };
    },
    update: async (id: string, revision: number) => {
      calls.push(`update:${id}:${revision}`);
      return { ok: true as const, data: {} };
    },
    saveDraft: async () => {
      calls.push('saveDraft');
      return { ok: true as const, data: { currentProjectId: null, projects: {}, warning: null } };
    },
    setView: async (id: string, view: string) => {
      calls.push(`setView:${id}:${view}`);
      return { ok: true as const, data: { currentProjectId: null, projects: {}, warning: null } };
    },
  } as unknown as CatalogService;

  const channels = registerCatalogIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: options.service === false ? null : service,
  });

  const invoke = (channel: string, payload: unknown): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { channels, invoke, calls };
}

const CHANNEL_VALUES = Object.values(CATALOG_CHANNELS).sort();

describe('catalog IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect([...channels].sort()).toEqual(CHANNEL_VALUES);
  });

  it('rejects an untrusted sender before running any action', async () => {
    const h = harness({ trusted: false });
    const result = await h.invoke(CATALOG_CHANNELS.list, {});
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(h.calls).toEqual([]);
  });

  it('rejects unknown fields, wrong shapes and oversize payloads', async () => {
    const h = harness();
    const payloads: Array<[string, unknown]> = [
      [CATALOG_CHANNELS.list, { extra: true }],
      [CATALOG_CHANNELS.open, { path: '' }],
      [CATALOG_CHANNELS.open, { path: 'x'.repeat(40_000) }],
      [CATALOG_CHANNELS.update, { projectId: 'prj_1', expectedRevision: 0, patch: {} }],
      [CATALOG_CHANNELS.update, { projectId: 'prj_1', expectedRevision: 1, patch: { label: 5 } }],
      [CATALOG_CHANNELS.select, { projectId: 42 }],
      [CATALOG_CHANNELS.uiSetView, { projectId: 'prj_1', view: 'nowhere' }],
      [CATALOG_CHANNELS.uiSaveDraft, { projectId: 'prj_1', sessionId: 'ses_1', text: 5 }],
      [CATALOG_CHANNELS.engineState, { unexpected: true }],
    ];
    for (const [channel, payload] of payloads) {
      const result = await h.invoke(channel, payload);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(h.calls).toEqual([]);
  });

  it('accepts every section the shell can show, so a view is never renderable but unsaved', async () => {
    const h = harness();
    for (const view of PROJECT_VIEWS) {
      const result = await h.invoke(CATALOG_CHANNELS.uiSetView, { projectId: 'prj_1', view });
      expect(result, `view ${view}`).toMatchObject({ ok: true });
    }
    expect(h.calls).toHaveLength(PROJECT_VIEWS.length);
  });

  it('delegates a valid call and keeps arguments typed', async () => {
    const h = harness();
    const opened = await h.invoke(CATALOG_CHANNELS.open, { path: 'x:\\work\\alpha' });
    expect(opened).toMatchObject({ ok: true, data: { status: 'created' } });
    await h.invoke(CATALOG_CHANNELS.update, { projectId: 'prj_1', expectedRevision: 3, patch: { pinned: true } });
    expect(h.calls).toEqual(['open:x:\\work\\alpha', 'update:prj_1:3']);
  });

  it('reports missing local state instead of throwing', async () => {
    const h = harness({ service: false });
    const result = await h.invoke(CATALOG_CHANNELS.list, {});
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    if (typeof result === 'object' && result !== null && 'error' in result) {
      expect((result as { error: { message: string } }).error.message).toContain('Local project state is unavailable');
    }
  });
});
