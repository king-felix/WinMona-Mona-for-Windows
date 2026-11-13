import { describe, expect, it } from 'vitest';
import type { CostLedger } from '@mona/project-state';
import { COST_CHANNELS } from '../shared/cost.js';
import { registerCostIpc, type CostSaveResult } from './cost-ipc.js';
import type { IpcHandle } from './ipc.js';

/**
 * Cost IPC: the renderer may read the lens, set one budget and export; it may
 * never send a computed total, and a ledger validation error is reported as the
 * user's to fix rather than as a generic internal failure.
 */
const totals = (overrides: Partial<Record<string, unknown>> = {}) => ({
  records: 2,
  providerReportedMicros: 3_000,
  estimatedMicros: 500,
  knownMicros: 3_500,
  unknownRecords: 1,
  unknownReasons: [{ reason: 'provider did not report usage', count: 1 }],
  tokens: { cacheHit: null, cacheMiss: null, input: null, output: null, reasoning: null },
  latestRecordedAt: '2026-11-12T00:00:00.000Z',
  ...overrides,
});

function harness(options: { trusted?: boolean; ledger?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  let saved: CostSaveResult = { saved: true, path: 'C:\\tmp\\cost.csv', note: 'wrote it' };
  let budgets: unknown[] = [];

  const ledger = {
    lens: async (projectId: string) => {
      calls.push(`lens:${projectId}`);
      return {
        projectId,
        totals: totals(),
        byTurn: [],
        byTask: [{ taskId: 'tsk_1', totals: totals({ unknownRecords: 0 }) }],
        bySession: [],
        rateFreshness: [],
        disclosure: ['Unknown cost is kept unknown.'],
      };
    },
    listBudgets: async (projectId: string) => {
      calls.push(`listBudgets:${projectId}`);
      return budgets;
    },
    evaluateBudget: async (input: { projectId: string; sessionId: string | null }) => {
      calls.push(`evaluate:${input.projectId}:${input.sessionId ?? 'none'}`);
      return { action: 'allow' as const, decisions: [], disclosure: 'local limit only' };
    },
    setBudget: async (input: { projectId: string; scope: string; limitMicros: number; warnMicros: number | null }) => {
      calls.push(`setBudget:${input.scope}:${input.limitMicros}`);
      if (input.warnMicros !== null && input.warnMicros > input.limitMicros) {
        throw Object.assign(new Error('warnMicros must not exceed limitMicros'), {
          name: 'StateError',
          code: 'invalid_request',
        });
      }
      budgets = [
        {
          id: 'bdg_1',
          projectId: input.projectId,
          scope: input.scope,
          sessionId: null,
          limitMicros: input.limitMicros,
          warnMicros: input.warnMicros ?? Math.floor(input.limitMicros * 0.8),
          stopMicros: input.limitMicros,
          createdAt: '2026-11-12T00:00:00.000Z',
          updatedAt: '2026-11-12T00:00:00.000Z',
        },
      ];
      return budgets[0];
    },
    exportCsv: async () => 'a,b\n1,2\n3,4\n',
  } as unknown as CostLedger;

  const channels = registerCostIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    ledger: () => (options.ledger === false ? null : ledger),
    saveCsv: async () => saved,
  });
  const invoke = async (channel: string, payload: unknown): Promise<unknown> => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return await listener({}, payload);
  };
  return {
    channels,
    invoke,
    calls,
    setSaved: (next: CostSaveResult) => {
      saved = next;
    },
  };
}

describe('cost IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect([...channels].sort()).toEqual(Object.values(COST_CHANNELS).sort());
  });

  it('refuses an untrusted sender before touching the ledger', async () => {
    const { invoke, calls } = harness({ trusted: false });
    const result = (await invoke(COST_CHANNELS.lens, { projectId: 'prj_1' })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('projects the lens without inventing a total', async () => {
    const { invoke } = harness();
    const result = (await invoke(COST_CHANNELS.lens, { projectId: 'prj_1' })) as {
      ok: true;
      data: { totals: { knownMicros: number; unknownRecords: number }; empty: boolean; byTask: unknown[] };
    };
    expect(result.ok).toBe(true);
    expect(result.data.totals.knownMicros).toBe(3_500);
    expect(result.data.totals.unknownRecords).toBe(1);
    expect(result.data.empty).toBe(false);
    expect(result.data.byTask).toHaveLength(1);
  });

  it('rejects a budget request before the ledger sees it', async () => {
    const { invoke, calls } = harness();
    const result = (await invoke(COST_CHANNELS.setBudget, {
      projectId: 'prj_1',
      scope: 'project',
      limitMicros: 1.5,
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.startsWith('setBudget'))).toEqual([]);
  });

  it('reports the ledger validation message instead of a generic failure', async () => {
    const { invoke } = harness();
    const result = (await invoke(COST_CHANNELS.setBudget, {
      projectId: 'prj_1',
      scope: 'project',
      limitMicros: 1_000_000,
      warnMicros: 2_000_000,
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_request');
    expect(result.error.message).toContain('warnMicros');
  });

  it('returns the re-read lens after a budget write', async () => {
    const { invoke } = harness();
    const result = (await invoke(COST_CHANNELS.setBudget, {
      projectId: 'prj_1',
      scope: 'day',
      limitMicros: 2_500_000,
    })) as { ok: true; data: { budgets: Array<{ scope: string; warnMicros: number; stopMicros: number }> } };
    expect(result.ok).toBe(true);
    expect(result.data.budgets[0]).toMatchObject({ scope: 'day', warnMicros: 2_000_000, stopMicros: 2_500_000 });
  });

  it('counts data rows on export and reports a cancelled save honestly', async () => {
    const { invoke, setSaved } = harness();
    const saved = (await invoke(COST_CHANNELS.exportCsv, { projectId: 'prj_1' })) as {
      ok: true;
      data: { saved: boolean; rows: number; bytes: number };
    };
    expect(saved.data).toMatchObject({ saved: true, rows: 2 });
    expect(saved.data.bytes).toBeGreaterThan(0);

    setSaved({ saved: false, path: null, note: 'Export cancelled. Nothing was written.' });
    const cancelled = (await invoke(COST_CHANNELS.exportCsv, { projectId: 'prj_1' })) as {
      ok: true;
      data: { saved: boolean; rows: number; path: string | null; note: string };
    };
    expect(cancelled.data).toMatchObject({ saved: false, rows: 0, path: null });
    expect(cancelled.data.note).toContain('cancelled');
  });

  it('says local state is unavailable rather than pretending success', async () => {
    const { invoke } = harness({ ledger: false });
    const result = (await invoke(COST_CHANNELS.lens, { projectId: 'prj_1' })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('internal');
  });
});
