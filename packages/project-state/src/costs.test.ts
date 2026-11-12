import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CostLedger, dayWindow, estimateCost, type RateCard } from './costs.js';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';
import { TaskService } from './tasks.js';

const cleanup: Array<() => Promise<void>> = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p12-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string) {
  const dir = await tempDir(label);
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const ledger = new CostLedger(store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
  const folder = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(folder, { label });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  return { store, ledger, projectId: registered.project.id, dir };
}

function rateCard(): RateCard {
  return {
    id: 'rate_fixture',
    provider: 'deepseek',
    model: 'deepseek-flash',
    currency: 'USD',
    unitTokens: 1_000_000,
    cacheHitMicros: 100_000,
    cacheMissMicros: 1_000_000,
    outputMicros: 2_000_000,
    reasoningMicros: null,
    source: 'fixture',
    sourceUrl: null,
    revision: 'fixture-1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('cost arithmetic', () => {
  it('prices disjoint cache buckets exactly in microUSD', () => {
    const estimate = estimateCost(rateCard(), {
      cacheHitTokens: 1_000,
      cacheMissTokens: 2_000,
      outputTokens: 500,
    });
    expect(estimate.status).toBe('known');
    // 1000 * 0.10/M + 2000 * 1.00/M + 500 * 2.00/M = 100 + 2000 + 1000
    expect(estimate.micros).toBe(3_100);
    expect(estimate.rateRevision).toBe('fixture-1');
  });

  it('handles inclusive input without double counting cached input', () => {
    const estimate = estimateCost(rateCard(), {
      inputTokens: 3_000,
      cacheHitTokens: 1_000,
      outputTokens: 500,
      inputSemantics: 'inclusive_cache',
    });
    expect(estimate.status).toBe('known');
    // miss = 3000 - 1000 = 2000; no separate 3000-token charge.
    expect(estimate.micros).toBe(3_100);
  });

  it('keeps an unreported bucket unknown instead of inventing a price', () => {
    const estimate = estimateCost(rateCard(), { cacheHitTokens: 1_000, outputTokens: 10 });
    expect(estimate.status).toBe('unknown');
    expect(estimate.micros).toBeNull();
    expect(estimate.reasons.join(' ')).toContain('cache hit/miss buckets');
  });

  it('requires a cache-hit rate when cache hits are reported', () => {
    const estimate = estimateCost(
      { ...rateCard(), cacheHitMicros: null },
      {
        cacheHitTokens: 10,
        cacheMissTokens: 10,
        outputTokens: 10,
      },
    );
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons.join(' ')).toContain('no cache-hit rate');
  });

  it('adds separately billed reasoning tokens only when a rate exists', () => {
    const withReasoning = { ...rateCard(), reasoningMicros: 1_000_000 };
    const priced = estimateCost(withReasoning, {
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000,
      reasoningBilledSeparately: true,
    });
    expect(priced.micros).toBe(1_000);
    const missing = estimateCost(rateCard(), {
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000,
      reasoningBilledSeparately: true,
    });
    expect(missing.status).toBe('unknown');
  });
});

describe('cost ledger ingestion', () => {
  it('does not charge a replayed or duplicate usage fact twice', async () => {
    const { ledger, projectId } = await setup('dedupe');
    const input = {
      projectId,
      threadId: 'thr_a',
      turnId: 'turn_a',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 10, cacheMissTokens: 20, outputTokens: 5 },
      cost: { kind: 'provider_reported' as const, micros: 1_234, source: 'thread delta' },
      source: 'engine_priced',
    };
    const first = await ledger.ingest(input);
    const second = await ledger.ingest(input);
    expect(first.recorded).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    const totals = await ledger.totals(projectId);
    expect(totals.records).toBe(1);
    expect(totals.providerReportedMicros).toBe(1_234);
  });

  it('stores unknown as unknown, never as zero', async () => {
    const { ledger, projectId } = await setup('unknown');
    await ledger.ingest({
      projectId,
      threadId: 'thr_b',
      turnId: 'turn_b',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 5, cacheMissTokens: 5, outputTokens: 5 },
      cost: { kind: 'local_estimate' },
      source: 'estimate_without_rate',
    });
    const totals = await ledger.totals(projectId);
    expect(totals.knownMicros).toBe(0);
    expect(totals.unknownRecords).toBe(1);
    expect(totals.unknownReasons[0]?.reason).toContain('no rate card');
    const lens = await ledger.lens(projectId);
    expect(lens.totals.knownMicros).toBe(0);
    expect(lens.totals.unknownRecords).toBe(1);
  });

  it('estimates from the active rate revision and records that revision', async () => {
    const { ledger, projectId } = await setup('estimate');
    const card = await ledger.putRate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      cacheHitMicros: 100_000,
      cacheMissMicros: 1_000_000,
      outputMicros: 2_000_000,
      source: 'fixture pricing',
      revision: 'fixture-1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    const outcome = await ledger.ingest({
      projectId,
      threadId: 'thr_c',
      turnId: 'turn_c',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
      cost: { kind: 'local_estimate' },
      source: 'local_estimate',
    });
    expect(outcome.record.costOrigin).toBe('estimated');
    expect(outcome.record.costMicros).toBe(3_100);
    expect(outcome.record.rateRevision).toBe(card.revision);
  });

  it('does not count a parent aggregate and its children both', async () => {
    const { ledger, projectId } = await setup('aggregate');
    await ledger.ingest({
      projectId,
      turnId: 'turn_parent',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 10 },
      cost: { kind: 'provider_reported', micros: 9_999, source: 'parent aggregate' },
      source: 'parent',
    });
    for (const child of ['turn_child_1', 'turn_child_2']) {
      await ledger.ingest({
        projectId,
        turnId: child,
        parentTurnId: 'turn_parent',
        provider: 'deepseek',
        model: 'deepseek-flash',
        buckets: { cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 10 },
        cost: { kind: 'provider_reported', micros: 1_000, source: 'child turn' },
        source: 'child',
      });
    }
    const totals = await ledger.totals(projectId);
    expect(totals.records).toBe(2);
    expect(totals.providerReportedMicros).toBe(2_000);
  });

  it('attributes usage by turn, task and session', async () => {
    const { store, ledger, projectId } = await setup('attribution');
    const task = await new TaskService(store).createTask({ projectId, title: 'attributed task', owner: 'mona_queue' });
    await store.putStudioThread({
      id: 'thr_session_1',
      projectId,
      engineThreadId: 'thr_session_1',
      workspace: '/fixture',
      sessionId: 'ses_1',
      mode: 'agent',
      profileJson: '{}',
    });
    await ledger.putRate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      cacheHitMicros: 100_000,
      cacheMissMicros: 1_000_000,
      outputMicros: 2_000_000,
      source: 'fixture pricing',
      revision: 'fixture-1',
    });
    for (const turn of ['turn_1', 'turn_2']) {
      await ledger.ingest({
        projectId,
        threadId: 'thr_session_1',
        turnId: turn,
        taskId: task.id,
        provider: 'deepseek',
        model: 'deepseek-flash',
        buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
        cost: { kind: 'local_estimate' },
        source: 'local_estimate',
      });
    }
    const lens = await ledger.lens(projectId);
    expect(lens.byTurn).toHaveLength(2);
    expect(lens.byTask[0]?.taskId).toBe(task.id);
    expect(lens.byTask[0]?.totals.estimatedMicros).toBe(6_200);
    expect(lens.bySession.find((entry) => entry.sessionId === 'ses_1')?.totals.records).toBe(2);
    expect(lens.rateFreshness[0]?.revision).toBe('fixture-1');
  });

  it('keeps history when a new rate revision is appended and offers an explicit recalculation', async () => {
    const { ledger, projectId } = await setup('revision');
    await ledger.putRate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      cacheHitMicros: 100_000,
      cacheMissMicros: 1_000_000,
      outputMicros: 2_000_000,
      source: 'fixture pricing',
      revision: 'rev-1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    const record = await ledger.ingest({
      projectId,
      threadId: 'thr_d',
      turnId: 'turn_d',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
      cost: { kind: 'local_estimate' },
      source: 'local_estimate',
    });
    expect(record.record.costMicros).toBe(3_100);
    await ledger.putRate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      cacheHitMicros: 200_000,
      cacheMissMicros: 2_000_000,
      outputMicros: 4_000_000,
      source: 'fixture pricing',
      revision: 'rev-2',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });
    const historical = await ledger.totals(projectId);
    expect(historical.estimatedMicros).toBe(3_100);
    const recalculated = await ledger.recalculate(projectId, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      revision: 'rev-2',
    });
    expect(recalculated.totals.estimatedMicros).toBe(6_200);
    expect((await ledger.totals(projectId)).estimatedMicros).toBe(3_100);
    await expect(
      ledger.putRate({
        provider: 'deepseek',
        model: 'deepseek-flash',
        cacheHitMicros: 1,
        cacheMissMicros: 1,
        outputMicros: 1,
        source: 'conflict',
        revision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('labels every exported row as provider-reported, locally estimated or unknown', async () => {
    const { ledger, projectId } = await setup('export');
    await ledger.ingest({
      projectId,
      turnId: 'turn_pr',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'provider_reported', micros: 10, source: 'engine' },
      source: 'engine',
    });
    await ledger.ingest({
      projectId,
      turnId: 'turn_unknown',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'unknown', reason: 'provider did not report usage' },
      source: 'engine_missing',
    });
    const csv = await ledger.exportCsv(projectId);
    expect(csv).toContain('provider-reported');
    expect(csv).toContain('unknown (provider did not report usage)');
  });
});

describe('budgets', () => {
  it('warns, then blocks the next dispatch, and never promises an invoice cap', async () => {
    const { ledger, projectId } = await setup('budget');
    const budget = await ledger.setBudget({
      projectId,
      scope: 'project',
      limitMicros: 10_000,
      warnMicros: 5_000,
      stopMicros: 9_000,
    });
    expect((await ledger.evaluateBudget({ projectId })).action).toBe('allow');
    await ledger.ingest({
      projectId,
      turnId: 'turn_budget',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'provider_reported', micros: 6_000, source: 'engine' },
      source: 'engine',
    });
    const warned = await ledger.evaluateBudget({ projectId });
    expect(warned.action).toBe('warn');
    expect(warned.decisions[0]?.budgetId).toBe(budget.id);
    expect(warned.disclosure).toContain('not a provider invoice cap');
    await ledger.ingest({
      projectId,
      turnId: 'turn_budget_2',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'provider_reported', micros: 3_000, source: 'engine' },
      source: 'engine',
    });
    const blocked = await ledger.evaluateBudget({ projectId });
    expect(blocked.action).toBe('block_next_dispatch');
    expect(blocked.decisions[0]?.spentMicros).toBe(9_000);
  });

  it('includes unreleased reservations in the projection and releases them', async () => {
    const { ledger, projectId } = await setup('reserve');
    const budget = await ledger.setBudget({
      projectId,
      scope: 'project',
      limitMicros: 10_000,
      warnMicros: 5_000,
      stopMicros: 10_000,
    });
    const reservation = await ledger.reserve({ budgetId: budget.id, label: 'parallel task', estimatedMicros: 10_000 });
    const blocked = await ledger.evaluateBudget({ projectId });
    expect(blocked.action).toBe('block_next_dispatch');
    expect(blocked.decisions[0]?.reservedMicros).toBe(10_000);
    await ledger.releaseReservation(reservation.id);
    expect((await ledger.evaluateBudget({ projectId })).action).toBe('allow');
  });

  it('does not count unknown records as spent when evaluating a budget', async () => {
    const { ledger, projectId } = await setup('budget-unknown');
    await ledger.setBudget({ projectId, scope: 'project', limitMicros: 1_000, warnMicros: 500, stopMicros: 1_000 });
    await ledger.ingest({
      projectId,
      turnId: 'turn_unknown_cost',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'unknown', reason: 'no usage' },
      source: 'engine_missing',
    });
    const evaluation = await ledger.evaluateBudget({ projectId });
    expect(evaluation.action).toBe('allow');
    expect(evaluation.decisions[0]?.unknownRecords).toBe(1);
    expect(evaluation.decisions[0]?.spentMicros).toBe(0);
  });

  it('scopes a day budget to the caller-visible local day', async () => {
    const { ledger, projectId } = await setup('budget-day');
    await ledger.setBudget({ projectId, scope: 'day', limitMicros: 1_000, warnMicros: 500, stopMicros: 1_000 });
    await ledger.ingest({
      projectId,
      turnId: 'turn_day',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'provider_reported', micros: 900, source: 'engine' },
      source: 'engine',
    });
    const sameDay = await ledger.evaluateBudget({
      projectId,
      now: new Date('2026-11-12T13:00:00.000Z'),
      timeZoneOffsetMinutes: 120,
    });
    expect(sameDay.action).toBe('warn');
    const nextDay = await ledger.evaluateBudget({
      projectId,
      now: new Date('2026-11-13T13:00:00.000Z'),
      timeZoneOffsetMinutes: 120,
    });
    expect(nextDay.action).toBe('allow');
  });

  it('computes a local day window from a UTC instant and an offset', () => {
    expect(dayWindow(new Date('2026-11-12T23:30:00.000Z'), 120)).toEqual({
      startUtc: '2026-11-12T22:00:00.000Z',
      endUtc: '2026-11-13T22:00:00.000Z',
    });
    expect(dayWindow(new Date('2026-11-12T02:00:00.000Z'), -300)).toEqual({
      startUtc: '2026-11-11T05:00:00.000Z',
      endUtc: '2026-11-12T05:00:00.000Z',
    });
  });
});
