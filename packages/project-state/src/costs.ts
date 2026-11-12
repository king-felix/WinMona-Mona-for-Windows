import { randomUUID } from 'node:crypto';
import { stateError } from './errors.js';
import type { ProjectStore } from './store.js';

/**
 * The cost ledger (spec 9.3).
 *
 * Three distinct states are kept apart everywhere: a provider-reported cost, a
 * locally estimated cost from a recorded rate revision, and an unknown cost.
 * Unknown is never rendered or summed as $0.00. Historical rows keep the rate
 * revision that priced them; a price change appends a new revision and a
 * recalculation is an explicit, read-only view.
 */

export type CostOrigin = 'provider_reported' | 'estimated' | 'unknown';
export type BudgetScope = 'session' | 'project' | 'day';
export type BudgetAction = 'allow' | 'warn' | 'block_next_dispatch';

export type RateCardInput = {
  provider: string;
  model: string;
  /** Cost in micro-USD per `unitTokens` tokens. Defaults to a 1M-token unit. */
  cacheHitMicros?: number | null;
  cacheMissMicros: number;
  outputMicros: number;
  /** Used only when reasoning tokens are billed separately from output. */
  reasoningMicros?: number | null;
  currency?: string;
  unitTokens?: number;
  source: string;
  sourceUrl?: string | null;
  revision: string;
  effectiveFrom?: string;
};

export type RateCard = {
  id: string;
  provider: string;
  model: string;
  currency: string;
  unitTokens: number;
  cacheHitMicros: number | null;
  cacheMissMicros: number;
  outputMicros: number;
  reasoningMicros: number | null;
  source: string;
  sourceUrl: string | null;
  revision: string;
  effectiveFrom: string;
  recordedAt: string;
};

export type UsageBuckets = {
  cacheHitTokens?: number | null;
  cacheMissTokens?: number | null;
  /** Total prompt tokens, used only with inclusive cache semantics. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  /** True only when the provider reported both cache buckets. */
  cacheKnown?: boolean;
  /**
   * `disjoint_cache` (default): cache hit and miss are separate buckets.
   * `inclusive_cache`: inputTokens already includes cacheHitTokens.
   */
  inputSemantics?: 'disjoint_cache' | 'inclusive_cache';
  /** True when reasoning tokens are billed on their own line. */
  reasoningBilledSeparately?: boolean;
};

export type CostBasis =
  | { kind: 'provider_reported'; micros: number; source: string; rateRevision?: string | null }
  | { kind: 'local_estimate'; rateRevision?: string | null }
  | { kind: 'unknown'; reason: string };

export type IngestInput = {
  projectId: string | null;
  threadId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  /** The aggregate turn this row belongs to. Aggregate rows are not double counted. */
  parentTurnId?: string | null;
  provider: string;
  model: string;
  buckets: UsageBuckets;
  cost: CostBasis;
  source: string;
  /** Stable identity. When omitted it is derived from project/thread/turn. */
  dedupeKey?: string;
};

export type UsageRecord = {
  id: string;
  projectId: string | null;
  threadId: string | null;
  turnId: string | null;
  taskId: string | null;
  parentTurnId: string | null;
  provider: string | null;
  model: string | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheKnown: boolean;
  costMicros: number | null;
  costKnown: boolean;
  costOrigin: CostOrigin;
  rateRevision: string | null;
  unknownReason: string | null;
  dedupeKey: string | null;
  source: string;
  recordedAt: string;
};

export type CostEstimate = {
  status: 'known' | 'unknown';
  micros: number | null;
  basis: 'local_estimate';
  rateRevision: string | null;
  reasons: string[];
};

export type CostTotals = {
  records: number;
  providerReportedMicros: number;
  estimatedMicros: number;
  knownMicros: number;
  unknownRecords: number;
  unknownReasons: Array<{ reason: string; count: number }>;
  tokens: {
    cacheHit: number | null;
    cacheMiss: number | null;
    input: number | null;
    output: number | null;
    reasoning: number | null;
  };
  latestRecordedAt: string | null;
};

export type CostLens = {
  projectId: string;
  totals: CostTotals;
  byTurn: Array<{ turnId: string; threadId: string | null; taskId: string | null; totals: CostTotals }>;
  byTask: Array<{ taskId: string; totals: CostTotals }>;
  bySession: Array<{ sessionId: string; totals: CostTotals }>;
  rateFreshness: Array<{
    provider: string;
    model: string;
    revision: string;
    effectiveFrom: string;
    recordedAt: string;
    source: string;
  }>;
  disclosure: string[];
};

export type BudgetInput = {
  projectId: string;
  scope: BudgetScope;
  sessionId?: string | null;
  limitMicros: number;
  warnMicros?: number | null;
  stopMicros?: number | null;
};

export type BudgetRecord = BudgetInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type BudgetDecision = {
  budgetId: string;
  scope: BudgetScope;
  sessionId: string | null;
  action: BudgetAction;
  limitMicros: number;
  warnAtMicros: number;
  stopAtMicros: number;
  spentMicros: number;
  reservedMicros: number;
  projectedMicros: number;
  unknownRecords: number;
  detail: string;
};

export type BudgetEvaluation = {
  action: BudgetAction;
  decisions: BudgetDecision[];
  disclosure: string;
};

export type Reservation = {
  id: string;
  budgetId: string;
  label: string;
  estimatedMicros: number;
  createdAt: string;
  releasedAt: string | null;
};

export type CostLedgerOptions = { now?: () => Date };

const MAX_TEXT = 300;
const DISCLOSURE =
  'This is a local dispatch limit computed from recorded usage and reservations, not a provider invoice cap. In-flight requests may complete after a stop request and may overshoot the limit.';
const UNKNOWN_IS_NOT_ZERO = 'Unknown cost is kept unknown; it is never displayed or summed as $0.00.';

function bounded(value: string | undefined | null, field: string, max = MAX_TEXT): string {
  const text = (value ?? '').trim();
  if (!text) throw stateError('invalid_request', `${field} is required`);
  if (text.length > max) throw stateError('invalid_request', `${field} exceeds ${max} characters`);
  return text;
}

function token(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw stateError('invalid_request', `${field} must be a non-negative integer`);
  }
  return value;
}

function money(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0)
    throw stateError('invalid_request', `${field} must be a non-negative number`);
  return Math.round(value);
}

function rate(value: number | null | undefined, field: string, required: boolean): number | null {
  if (value === null || value === undefined) {
    if (required) throw stateError('invalid_request', `${field} is required`);
    return null;
  }
  if (!Number.isFinite(value) || value < 0)
    throw stateError('invalid_request', `${field} must be a non-negative number`);
  return value;
}

function microsFor(tokens: number, rateMicrosPerUnit: number, unitTokens: number): number {
  return Math.round((tokens * rateMicrosPerUnit) / unitTokens);
}

/**
 * Local estimate from one rate revision. Returns unknown with reasons instead of
 * silently pricing a missing bucket.
 */
export function estimateCost(rateCard: RateCard, buckets: UsageBuckets): CostEstimate {
  const reasons: string[] = [];
  let hit: number | null = null;
  let miss: number | null = null;
  const cacheHit = token(buckets.cacheHitTokens, 'cacheHitTokens');
  const cacheMiss = token(buckets.cacheMissTokens, 'cacheMissTokens');
  const input = token(buckets.inputTokens, 'inputTokens');
  if (cacheHit !== null && cacheMiss !== null) {
    hit = cacheHit;
    miss = cacheMiss;
  } else if (buckets.inputSemantics === 'inclusive_cache' && cacheHit !== null && input !== null) {
    hit = cacheHit;
    miss = input - cacheHit;
    if (miss < 0) reasons.push('cache hit tokens exceed total input tokens');
  } else {
    reasons.push('cache hit/miss buckets were not reported');
  }
  const output = token(buckets.outputTokens, 'outputTokens');
  if (output === null) reasons.push('output tokens were not reported');
  if (hit !== null && hit > 0 && rateCard.cacheHitMicros === null) {
    reasons.push(`no cache-hit rate is recorded in revision ${rateCard.revision}`);
  }
  const reasoning = token(buckets.reasoningTokens, 'reasoningTokens');
  if (buckets.reasoningBilledSeparately && reasoning && reasoning > 0 && rateCard.reasoningMicros === null) {
    reasons.push(`no reasoning rate is recorded in revision ${rateCard.revision}`);
  }
  if (reasons.length > 0 || hit === null || miss === null || output === null) {
    return {
      status: 'unknown',
      micros: null,
      basis: 'local_estimate',
      rateRevision: rateCard.revision,
      reasons: reasons.length > 0 ? reasons : ['incomplete usage'],
    };
  }
  let micros =
    microsFor(miss, rateCard.cacheMissMicros, rateCard.unitTokens) +
    microsFor(output, rateCard.outputMicros, rateCard.unitTokens);
  if (hit > 0) micros += microsFor(hit, rateCard.cacheHitMicros as number, rateCard.unitTokens);
  if (buckets.reasoningBilledSeparately && reasoning && reasoning > 0) {
    micros += microsFor(reasoning, rateCard.reasoningMicros as number, rateCard.unitTokens);
  }
  return { status: 'known', micros, basis: 'local_estimate', rateRevision: rateCard.revision, reasons: [] };
}

/**
 * The local day window for a UTC instant and a timezone offset east of UTC.
 * Returns [start, end) in UTC ISO strings so a day budget cannot drift with the
 * machine's clock.
 */
export function dayWindow(now: Date, timeZoneOffsetMinutes: number): { startUtc: string; endUtc: string } {
  if (!Number.isInteger(timeZoneOffsetMinutes)) {
    throw stateError('invalid_request', 'timeZoneOffsetMinutes must be an integer');
  }
  const offsetMs = timeZoneOffsetMinutes * 60_000;
  const local = new Date(now.getTime() + offsetMs);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(startLocal - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function rowToUsage(row: Record<string, unknown>): UsageRecord {
  const costSource = String(row.cost_source ?? 'unknown');
  const costOrigin: CostOrigin =
    Number(row.cost_known) === 1 ? (costSource === 'estimated' ? 'estimated' : 'provider_reported') : 'unknown';
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    turnId: row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    parentTurnId: row.parent_turn_id === null || row.parent_turn_id === undefined ? null : String(row.parent_turn_id),
    provider: row.provider === null || row.provider === undefined ? null : String(row.provider),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    cacheHitTokens:
      row.cache_hit_tokens === null || row.cache_hit_tokens === undefined ? null : Number(row.cache_hit_tokens),
    cacheMissTokens:
      row.cache_miss_tokens === null || row.cache_miss_tokens === undefined ? null : Number(row.cache_miss_tokens),
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    reasoningTokens:
      row.reasoning_tokens === null || row.reasoning_tokens === undefined ? null : Number(row.reasoning_tokens),
    cacheKnown: Number(row.cache_known) === 1,
    costMicros: row.cost_micros === null || row.cost_micros === undefined ? null : Number(row.cost_micros),
    costKnown: Number(row.cost_known) === 1,
    costOrigin,
    rateRevision: row.rate_revision === null || row.rate_revision === undefined ? null : String(row.rate_revision),
    unknownReason: row.unknown_reason === null || row.unknown_reason === undefined ? null : String(row.unknown_reason),
    dedupeKey: row.dedupe_key === null || row.dedupe_key === undefined ? null : String(row.dedupe_key),
    source: String(row.source),
    recordedAt: String(row.recorded_at),
  };
}

function emptyTotals(): CostTotals {
  return {
    records: 0,
    providerReportedMicros: 0,
    estimatedMicros: 0,
    knownMicros: 0,
    unknownRecords: 0,
    unknownReasons: [],
    tokens: { cacheHit: null, cacheMiss: null, input: null, output: null, reasoning: null },
    latestRecordedAt: null,
  };
}

function addNullable(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function totalsOf(rows: readonly UsageRecord[]): CostTotals {
  const totals = emptyTotals();
  const reasons = new Map<string, number>();
  for (const row of rows) {
    totals.records += 1;
    if (row.costKnown && row.costMicros !== null) {
      if (row.costOrigin === 'estimated') totals.estimatedMicros += row.costMicros;
      else totals.providerReportedMicros += row.costMicros;
      totals.knownMicros += row.costMicros;
    } else {
      totals.unknownRecords += 1;
      const reason = row.unknownReason ?? row.source ?? 'unknown';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    totals.tokens.cacheHit = addNullable(totals.tokens.cacheHit, row.cacheHitTokens);
    totals.tokens.cacheMiss = addNullable(totals.tokens.cacheMiss, row.cacheMissTokens);
    totals.tokens.input = addNullable(totals.tokens.input, row.inputTokens);
    totals.tokens.output = addNullable(totals.tokens.output, row.outputTokens);
    totals.tokens.reasoning = addNullable(totals.tokens.reasoning, row.reasoningTokens);
    if (totals.latestRecordedAt === null || row.recordedAt > totals.latestRecordedAt) {
      totals.latestRecordedAt = row.recordedAt;
    }
  }
  totals.unknownReasons = [...reasons.entries()].map(([reason, count]) => ({ reason, count }));
  return totals;
}

/**
 * Aggregate rows: when a parent row is referenced by child rows, the children
 * are the detail and the parent aggregate is not added again.
 */
function incrementalRows(all: readonly UsageRecord[]): UsageRecord[] {
  const parents = new Set(all.map((row) => row.parentTurnId).filter((value): value is string => Boolean(value)));
  return all.filter((row) => !(row.turnId && parents.has(row.turnId)));
}

export class CostLedger {
  private readonly now: () => Date;

  constructor(
    private readonly store: ProjectStore,
    options: CostLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async putRate(input: RateCardInput): Promise<RateCard> {
    const provider = bounded(input.provider, 'provider');
    const model = bounded(input.model, 'model');
    const revision = bounded(input.revision, 'revision');
    const unitTokens = input.unitTokens ?? 1_000_000;
    if (!Number.isInteger(unitTokens) || unitTokens <= 0) {
      throw stateError('invalid_request', 'unitTokens must be a positive integer');
    }
    const effectiveFrom = input.effectiveFrom ?? this.now().toISOString();
    if (Number.isNaN(Date.parse(effectiveFrom)))
      throw stateError('invalid_request', 'effectiveFrom is not a timestamp');
    const card = {
      provider,
      model,
      currency: bounded(input.currency ?? 'USD', 'currency'),
      unitTokens,
      cacheHitMicros: rate(input.cacheHitMicros, 'cacheHitMicros', false),
      cacheMissMicros: rate(input.cacheMissMicros, 'cacheMissMicros', true) as number,
      outputMicros: rate(input.outputMicros, 'outputMicros', true) as number,
      reasoningMicros: rate(input.reasoningMicros, 'reasoningMicros', false),
      source: bounded(input.source, 'source'),
      sourceUrl: input.sourceUrl ? bounded(input.sourceUrl, 'sourceUrl') : null,
      revision,
      effectiveFrom,
    };
    return await this.store.write((tx) => {
      const existing = tx.db
        .prepare('SELECT * FROM rate_cards WHERE provider = ? AND model = ? AND revision = ?')
        .get(provider, model, revision) as Record<string, unknown> | undefined;
      if (existing) {
        const row = this.rowToRate(existing);
        const same =
          row.cacheHitMicros === card.cacheHitMicros &&
          row.cacheMissMicros === card.cacheMissMicros &&
          row.outputMicros === card.outputMicros &&
          row.reasoningMicros === card.reasoningMicros &&
          row.unitTokens === card.unitTokens &&
          row.effectiveFrom === card.effectiveFrom;
        if (!same) {
          throw stateError(
            'conflict',
            `rate revision ${revision} already exists with different values; append a new revision instead`,
          );
        }
        return row;
      }
      const id = `rate_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO rate_cards(id, provider, model, currency, unit_tokens, cache_hit_micros, cache_miss_micros,
             output_micros, reasoning_micros, source, source_url, revision, effective_from, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          card.provider,
          card.model,
          card.currency,
          card.unitTokens,
          card.cacheHitMicros,
          card.cacheMissMicros,
          card.outputMicros,
          card.reasoningMicros,
          card.source,
          card.sourceUrl,
          card.revision,
          card.effectiveFrom,
          tx.now(),
        );
      tx.bumpRevision();
      return this.rowToRate(tx.db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id) as Record<string, unknown>);
    });
  }

  async rates(provider: string, model: string): Promise<RateCard[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare(
          'SELECT * FROM rate_cards WHERE provider = ? AND model = ? ORDER BY effective_from ASC, recorded_at ASC',
        )
        .all(provider, model) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToRate(row));
    });
  }

  async activeRate(provider: string, model: string, at?: string): Promise<RateCard | null> {
    const moment = at ?? this.now().toISOString();
    return await this.store.read((db) => {
      const row = db
        .prepare(
          `SELECT * FROM rate_cards WHERE provider = ? AND model = ? AND effective_from <= ?
           ORDER BY effective_from DESC, recorded_at DESC LIMIT 1`,
        )
        .get(provider, model, moment) as Record<string, unknown> | undefined;
      return row ? this.rowToRate(row) : null;
    });
  }

  /**
   * Ingest one usage fact. A repeated ingest with the same identity is the same
   * cost: the existing record is returned and nothing is charged twice.
   */
  async ingest(input: IngestInput): Promise<{ recorded: boolean; duplicate: boolean; record: UsageRecord }> {
    const provider = bounded(input.provider, 'provider');
    const model = bounded(input.model, 'model');
    const source = bounded(input.source, 'source');
    const cacheHit = token(input.buckets.cacheHitTokens, 'cacheHitTokens');
    const cacheMiss = token(input.buckets.cacheMissTokens, 'cacheMissTokens');
    const inputTokens = token(input.buckets.inputTokens, 'inputTokens');
    const output = token(input.buckets.outputTokens, 'outputTokens');
    const reasoning = token(input.buckets.reasoningTokens, 'reasoningTokens');
    const dedupeKey =
      input.dedupeKey ??
      ['ingest', input.projectId ?? 'global', input.threadId ?? '', input.turnId ?? '', input.parentTurnId ?? ''].join(
        '|',
      );

    const existing = await this.store.read((db) => {
      const row = db.prepare('SELECT * FROM usage_records WHERE dedupe_key = ?').get(dedupeKey) as
        Record<string, unknown> | undefined;
      return row ? rowToUsage(row) : null;
    });
    if (existing) return { recorded: false, duplicate: true, record: existing };

    let costMicros: number | null = null;
    let costKnown = false;
    let costSource: CostOrigin = 'unknown';
    let rateRevision: string | null = null;
    let unknownReason: string | null = null;
    if (input.cost.kind === 'provider_reported') {
      costMicros = money(input.cost.micros, 'cost.micros');
      costKnown = true;
      costSource = 'provider_reported';
      rateRevision = input.cost.rateRevision ?? null;
    } else if (input.cost.kind === 'local_estimate') {
      const card = await this.activeRate(provider, model);
      if (!card) {
        unknownReason = `no rate card for ${provider}/${model}`;
      } else {
        rateRevision = input.cost.rateRevision ?? card.revision;
        const estimate = estimateCost(card, input.buckets);
        if (estimate.status === 'known') {
          costMicros = estimate.micros;
          costKnown = true;
          costSource = 'estimated';
        } else {
          unknownReason = estimate.reasons.join('; ');
        }
      }
    } else {
      unknownReason = bounded(input.cost.reason, 'cost.reason');
    }

    const cacheKnown = input.buckets.cacheKnown ?? (cacheHit !== null && cacheMiss !== null);
    const record = await this.store.write((tx) => {
      const id = `use_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO usage_records(id, project_id, thread_id, turn_id, task_id, parent_turn_id, provider, model,
             cache_hit_tokens, cache_miss_tokens, input_tokens, output_tokens, reasoning_tokens, cache_known,
             cost_micros, cost_known, cost_source, rate_revision, unknown_reason, dedupe_key, source, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.threadId ?? null,
          input.turnId ?? null,
          input.taskId ?? null,
          input.parentTurnId ?? null,
          provider,
          model,
          cacheHit,
          cacheMiss,
          inputTokens,
          output,
          reasoning,
          cacheKnown ? 1 : 0,
          costMicros,
          costKnown ? 1 : 0,
          costSource,
          rateRevision,
          unknownReason,
          dedupeKey,
          source,
          tx.now(),
        );
      tx.bumpRevision();
      return rowToUsage(tx.db.prepare('SELECT * FROM usage_records WHERE id = ?').get(id) as Record<string, unknown>);
    });
    return { recorded: true, duplicate: false, record };
  }

  async records(projectId: string, limit = 500): Promise<UsageRecord[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM usage_records WHERE project_id = ? ORDER BY recorded_at ASC, id ASC LIMIT ?')
        .all(projectId, Math.max(1, Math.min(limit, 5_000))) as Array<Record<string, unknown>>;
      return rows.map(rowToUsage);
    });
  }

  async totals(projectId: string): Promise<CostTotals> {
    return totalsOf(incrementalRows(await this.records(projectId, 5_000)));
  }

  async lens(projectId: string): Promise<CostLens> {
    const all = incrementalRows(await this.records(projectId, 5_000));
    const sessionByThread = await this.store.read((db) => {
      const rows = db.prepare('SELECT id, session_id FROM threads WHERE project_id = ?').all(projectId) as Array<{
        id: string;
        session_id: string | null;
      }>;
      return new Map(rows.map((row) => [row.id, row.session_id] as const));
    });
    const byTurn = new Map<string, UsageRecord[]>();
    const byTask = new Map<string, UsageRecord[]>();
    const bySession = new Map<string, UsageRecord[]>();
    for (const row of all) {
      const turnKey = row.turnId ?? `untracked:${row.id}`;
      byTurn.set(turnKey, [...(byTurn.get(turnKey) ?? []), row]);
      if (row.taskId) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
      const session = row.threadId ? (sessionByThread.get(row.threadId) ?? null) : null;
      const sessionKey = session ?? 'unattributed';
      bySession.set(sessionKey, [...(bySession.get(sessionKey) ?? []), row]);
    }
    const rateRows = await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM rate_cards ORDER BY provider ASC, model ASC, effective_from DESC')
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToRate(row));
    });
    return {
      projectId,
      totals: totalsOf(all),
      byTurn: [...byTurn.entries()].map(([turnId, rows]) => ({
        turnId,
        threadId: rows[0]?.threadId ?? null,
        taskId: rows[0]?.taskId ?? null,
        totals: totalsOf(rows),
      })),
      byTask: [...byTask.entries()].map(([taskId, rows]) => ({ taskId, totals: totalsOf(rows) })),
      bySession: [...bySession.entries()].map(([sessionId, rows]) => ({ sessionId, totals: totalsOf(rows) })),
      rateFreshness: rateRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        revision: row.revision,
        effectiveFrom: row.effectiveFrom,
        recordedAt: row.recordedAt,
        source: row.source,
      })),
      disclosure: [
        UNKNOWN_IS_NOT_ZERO,
        'Provider billing remains authoritative; local totals are evidence, not an invoice.',
      ],
    };
  }

  /** Explicit recalculation view: reads tokens, prices them, writes nothing. */
  async recalculate(
    projectId: string,
    input: { provider: string; model: string; revision: string },
  ): Promise<{
    projectId: string;
    rateRevision: string;
    totals: CostTotals;
    rows: Array<{ id: string; status: string; reasons: string[] }>;
  }> {
    const cards = await this.rates(input.provider, input.model);
    const card = cards.find((entry) => entry.revision === input.revision);
    if (!card)
      throw stateError(
        'not_found',
        `rate revision ${input.revision} is not recorded for ${input.provider}/${input.model}`,
      );
    const rows = await this.records(projectId, 5_000);
    const projected: UsageRecord[] = [];
    const report: Array<{ id: string; status: string; reasons: string[] }> = [];
    for (const row of rows) {
      const estimate = estimateCost(card, {
        cacheHitTokens: row.cacheHitTokens,
        cacheMissTokens: row.cacheMissTokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
      });
      report.push({
        id: row.id,
        status: estimate.status,
        reasons: estimate.reasons,
      });
      if (estimate.status === 'known') {
        projected.push({
          ...row,
          costKnown: true,
          costOrigin: 'estimated',
          costMicros: estimate.micros as number,
          rateRevision: card.revision,
          unknownReason: null,
        });
      } else {
        projected.push({
          ...row,
          costKnown: false,
          costOrigin: 'unknown',
          costMicros: null,
          unknownReason: estimate.reasons.join('; '),
        });
      }
    }
    return { projectId, rateRevision: card.revision, totals: totalsOf(projected), rows: report };
  }

  /** CSV with an explicit origin label per row. */
  async exportCsv(projectId: string): Promise<string> {
    const rows = await this.records(projectId, 5_000);
    const header = [
      'recorded_at',
      'thread_id',
      'turn_id',
      'task_id',
      'provider',
      'model',
      'cache_hit_tokens',
      'cache_miss_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cost_micros',
      'cost_usd',
      'cost_label',
      'rate_revision',
      'unknown_reason',
    ];
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [header.join(',')];
    for (const row of rows) {
      const label =
        row.costOrigin === 'provider_reported'
          ? 'provider-reported'
          : row.costOrigin === 'estimated'
            ? 'locally-estimated'
            : `unknown (${row.unknownReason ?? 'no reason recorded'})`;
      lines.push(
        [
          row.recordedAt,
          row.threadId,
          row.turnId,
          row.taskId,
          row.provider,
          row.model,
          row.cacheHitTokens,
          row.cacheMissTokens,
          row.inputTokens,
          row.outputTokens,
          row.reasoningTokens,
          row.costMicros,
          row.costMicros === null ? '' : (row.costMicros / 1_000_000).toFixed(6),
          label,
          row.rateRevision,
          row.unknownReason,
        ]
          .map(escape)
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  async setBudget(input: BudgetInput): Promise<BudgetRecord> {
    const scope = input.scope;
    if (!['session', 'project', 'day'].includes(scope))
      throw stateError('invalid_request', `unknown budget scope ${scope}`);
    if (!Number.isInteger(input.limitMicros) || input.limitMicros <= 0) {
      throw stateError('invalid_request', 'limitMicros must be a positive integer');
    }
    if (scope === 'session' && !input.sessionId) {
      throw stateError('invalid_request', 'a session budget needs a sessionId');
    }
    const warn = input.warnMicros ?? Math.floor(input.limitMicros * 0.8);
    const stop = input.stopMicros ?? input.limitMicros;
    if (warn > input.limitMicros) throw stateError('invalid_request', 'warnMicros must not exceed limitMicros');
    if (stop > input.limitMicros) throw stateError('invalid_request', 'stopMicros must not exceed limitMicros');
    return await this.store.write((tx) => {
      const project = tx.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
        { id?: string } | undefined;
      if (!project?.id) throw stateError('not_found', `project ${input.projectId} does not exist`);
      const existing = tx.db
        .prepare("SELECT id FROM budgets WHERE project_id = ? AND scope = ? AND COALESCE(session_id, '') = ?")
        .get(input.projectId, scope, input.sessionId ?? '') as { id?: string } | undefined;
      const now = tx.now();
      if (existing?.id) {
        tx.db
          .prepare('UPDATE budgets SET limit_micros = ?, warn_micros = ?, stop_micros = ?, updated_at = ? WHERE id = ?')
          .run(input.limitMicros, warn, stop, now, existing.id);
        tx.bumpRevision();
        return this.rowToBudget(
          tx.db.prepare('SELECT * FROM budgets WHERE id = ?').get(existing.id) as Record<string, unknown>,
        );
      }
      const id = `bdg_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO budgets(id, project_id, scope, session_id, limit_micros, warn_micros, stop_micros, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, scope, input.sessionId ?? null, input.limitMicros, warn, stop, now, now);
      tx.bumpRevision();
      return this.rowToBudget(tx.db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as Record<string, unknown>);
    });
  }

  async listBudgets(projectId: string): Promise<BudgetRecord[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM budgets WHERE project_id = ? ORDER BY scope ASC, created_at ASC')
        .all(projectId) as Array<Record<string, unknown>>;
      return rows.map((row) => this.rowToBudget(row));
    });
  }

  async reserve(input: { budgetId: string; label: string; estimatedMicros: number }): Promise<Reservation> {
    const label = bounded(input.label, 'label');
    if (!Number.isInteger(input.estimatedMicros) || input.estimatedMicros < 0) {
      throw stateError('invalid_request', 'estimatedMicros must be a non-negative integer');
    }
    return await this.store.write((tx) => {
      const budget = tx.db.prepare('SELECT id FROM budgets WHERE id = ?').get(input.budgetId) as
        { id?: string } | undefined;
      if (!budget?.id) throw stateError('not_found', `budget ${input.budgetId} does not exist`);
      const id = `rsv_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          'INSERT INTO budget_reservations(id, budget_id, label, estimated_micros, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.budgetId, label, input.estimatedMicros, tx.now());
      tx.bumpRevision();
      return this.rowToReservation(
        tx.db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(id) as Record<string, unknown>,
      );
    });
  }

  async releaseReservation(reservationId: string): Promise<Reservation> {
    return await this.store.write((tx) => {
      const row = tx.db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(reservationId) as
        Record<string, unknown> | undefined;
      if (!row) throw stateError('not_found', `reservation ${reservationId} does not exist`);
      if (row.released_at === null) {
        tx.db.prepare('UPDATE budget_reservations SET released_at = ? WHERE id = ?').run(tx.now(), reservationId);
        tx.bumpRevision();
      }
      return this.rowToReservation(
        tx.db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(reservationId) as Record<string, unknown>,
      );
    });
  }

  /**
   * Warn and stop thresholds. The overall action is the most severe decision.
   * Evaluations that warn or block are recorded as audit events.
   */
  async evaluateBudget(input: {
    projectId: string;
    sessionId?: string | null;
    now?: Date;
    timeZoneOffsetMinutes?: number;
  }): Promise<BudgetEvaluation> {
    const budgets = await this.listBudgets(input.projectId);
    if (budgets.length === 0) return { action: 'allow', decisions: [], disclosure: DISCLOSURE };
    const moment = input.now ?? this.now();
    const day = dayWindow(moment, input.timeZoneOffsetMinutes ?? 0);
    const rows = incrementalRows(await this.records(input.projectId, 5_000));
    const sessionByThread = await this.store.read((db) => {
      const map = db.prepare('SELECT id, session_id FROM threads WHERE project_id = ?').all(input.projectId) as Array<{
        id: string;
        session_id: string | null;
      }>;
      return new Map(map.map((row) => [row.id, row.session_id] as const));
    });
    const reservations = await this.store.read((db) => {
      const list = db
        .prepare(
          `SELECT budget_id, COALESCE(SUM(estimated_micros), 0) AS reserved FROM budget_reservations
           WHERE released_at IS NULL GROUP BY budget_id`,
        )
        .all() as Array<{ budget_id: string; reserved: number }>;
      return new Map(list.map((row) => [row.budget_id, Number(row.reserved)] as const));
    });

    const decisions: BudgetDecision[] = [];
    for (const budget of budgets) {
      const scoped = rows.filter((row) => {
        if (budget.scope === 'project') return true;
        if (budget.scope === 'session') {
          return Boolean(row.threadId && sessionByThread.get(row.threadId) === budget.sessionId);
        }
        return row.recordedAt >= day.startUtc && row.recordedAt < day.endUtc;
      });
      const totals = totalsOf(scoped);
      const reserved = reservations.get(budget.id) ?? 0;
      const projected = totals.knownMicros + reserved;
      const stopAt = budget.stopMicros ?? budget.limitMicros;
      const warnAt = budget.warnMicros ?? Math.floor(budget.limitMicros * 0.8);
      const action: BudgetAction = projected >= stopAt ? 'block_next_dispatch' : projected >= warnAt ? 'warn' : 'allow';
      decisions.push({
        budgetId: budget.id,
        scope: budget.scope,
        sessionId: budget.sessionId ?? null,
        action,
        limitMicros: budget.limitMicros,
        warnAtMicros: warnAt,
        stopAtMicros: stopAt,
        spentMicros: totals.knownMicros,
        reservedMicros: reserved,
        projectedMicros: projected,
        unknownRecords: totals.unknownRecords,
        detail:
          action === 'block_next_dispatch'
            ? `projected ${projected} microUSD reaches the ${stopAt} stop threshold (${totals.unknownRecords} unknown record(s) are not included)`
            : action === 'warn'
              ? `projected ${projected} microUSD reached the ${warnAt} warning threshold`
              : `projected ${projected} microUSD is below the ${warnAt} warning threshold`,
      });
      if (action !== 'allow') {
        await this.store.write((tx) => {
          tx.db
            .prepare(
              'INSERT INTO budget_events(id, budget_id, action, spent_micros, limit_micros, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              `bev_${randomUUID().replaceAll('-', '')}`,
              budget.id,
              action,
              projected,
              budget.limitMicros,
              decisions[decisions.length - 1]?.detail ?? null,
              tx.now(),
            );
          tx.bumpRevision();
        });
      }
    }
    const action: BudgetAction = decisions.some((decision) => decision.action === 'block_next_dispatch')
      ? 'block_next_dispatch'
      : decisions.some((decision) => decision.action === 'warn')
        ? 'warn'
        : 'allow';
    return { action, decisions, disclosure: DISCLOSURE };
  }

  private rowToRate(row: Record<string, unknown>): RateCard {
    const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return {
      id: String(row.id),
      provider: String(row.provider),
      model: String(row.model),
      currency: String(row.currency),
      unitTokens: Number(row.unit_tokens),
      cacheHitMicros: nullable(row.cache_hit_micros),
      cacheMissMicros: Number(row.cache_miss_micros),
      outputMicros: Number(row.output_micros),
      reasoningMicros: nullable(row.reasoning_micros),
      source: String(row.source),
      sourceUrl: row.source_url === null || row.source_url === undefined ? null : String(row.source_url),
      revision: String(row.revision),
      effectiveFrom: String(row.effective_from),
      recordedAt: String(row.recorded_at),
    };
  }

  private rowToBudget(row: Record<string, unknown>): BudgetRecord {
    const nullable = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      scope: String(row.scope) as BudgetScope,
      sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      limitMicros: Number(row.limit_micros),
      warnMicros: nullable(row.warn_micros),
      stopMicros: nullable(row.stop_micros),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToReservation(row: Record<string, unknown>): Reservation {
    return {
      id: String(row.id),
      budgetId: String(row.budget_id),
      label: String(row.label),
      estimatedMicros: Number(row.estimated_micros),
      createdAt: String(row.created_at),
      releasedAt: row.released_at === null || row.released_at === undefined ? null : String(row.released_at),
    };
  }
}
