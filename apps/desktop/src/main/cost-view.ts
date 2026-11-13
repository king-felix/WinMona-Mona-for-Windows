import type { BudgetEvaluation, BudgetRecord, CostLens, CostTotals } from '@mona/project-state';
import type {
  BudgetActionView,
  CostBudgetView,
  CostDecisionView,
  CostGroupView,
  CostLensView,
  CostTotalsView,
} from '../shared/cost.js';

/**
 * Projections from the recorded cost ledger to the renderer's vocabulary.
 *
 * These are pure and deliberately conservative: they copy recorded values, keep
 * unknown counts unknown, and never compute a balance, a projection or an
 * average that the ledger did not store. Limits on what a number means are stated
 * in the disclosure rather than implied by a green badge.
 */
function totalsView(totals: CostTotals): CostTotalsView {
  return {
    records: totals.records,
    providerReportedMicros: totals.providerReportedMicros,
    estimatedMicros: totals.estimatedMicros,
    knownMicros: totals.knownMicros,
    unknownRecords: totals.unknownRecords,
    unknownReasons: totals.unknownReasons.map((entry) => ({ reason: entry.reason, count: entry.count })),
    tokens: {
      cacheHit: totals.tokens.cacheHit,
      cacheMiss: totals.tokens.cacheMiss,
      input: totals.tokens.input,
      output: totals.tokens.output,
      reasoning: totals.tokens.reasoning,
    },
    latestRecordedAt: totals.latestRecordedAt,
  };
}

function budgetView(budget: BudgetRecord): CostBudgetView {
  return {
    id: budget.id,
    scope: budget.scope,
    sessionId: budget.sessionId ?? null,
    limitMicros: budget.limitMicros,
    // The ledger defaults these at write time; mirror the same defaults so the
    // screen shows the thresholds that will actually be enforced.
    warnMicros: budget.warnMicros ?? Math.floor(budget.limitMicros * 0.8),
    stopMicros: budget.stopMicros ?? budget.limitMicros,
    updatedAt: budget.updatedAt,
  };
}

function decisionView(decision: BudgetEvaluation['decisions'][number]): CostDecisionView {
  return {
    budgetId: decision.budgetId,
    scope: decision.scope,
    action: decision.action,
    limitMicros: decision.limitMicros,
    warnAtMicros: decision.warnAtMicros,
    stopAtMicros: decision.stopAtMicros,
    spentMicros: decision.spentMicros,
    reservedMicros: decision.reservedMicros,
    projectedMicros: decision.projectedMicros,
    unknownRecords: decision.unknownRecords,
    detail: decision.detail,
  };
}

function actionView(action: BudgetEvaluation['action']): BudgetActionView {
  return action;
}

export function toCostLensView(input: {
  lens: CostLens;
  budgets: BudgetRecord[];
  evaluation: BudgetEvaluation;
}): CostLensView {
  const byTurn: CostGroupView[] = input.lens.byTurn.map((entry) => ({
    key: entry.turnId,
    label: entry.turnId,
    detail: entry.taskId ? `task ${entry.taskId}` : entry.threadId ? `thread ${entry.threadId}` : null,
    totals: totalsView(entry.totals),
  }));
  const byTask: CostGroupView[] = input.lens.byTask.map((entry) => ({
    key: entry.taskId,
    label: entry.taskId,
    detail: null,
    totals: totalsView(entry.totals),
  }));
  const bySession: CostGroupView[] = input.lens.bySession.map((entry) => ({
    key: entry.sessionId,
    label: entry.sessionId,
    detail: null,
    totals: totalsView(entry.totals),
  }));

  return {
    projectId: input.lens.projectId,
    totals: totalsView(input.lens.totals),
    byTurn,
    byTask,
    bySession,
    rates: input.lens.rateFreshness.map((rate) => ({
      provider: rate.provider,
      model: rate.model,
      revision: rate.revision,
      effectiveFrom: rate.effectiveFrom,
      source: rate.source,
    })),
    budgets: input.budgets.map(budgetView),
    evaluation: {
      action: actionView(input.evaluation.action),
      decisions: input.evaluation.decisions.map(decisionView),
      disclosure: input.evaluation.disclosure,
    },
    disclosure: input.lens.disclosure,
    empty: input.lens.totals.records === 0,
  };
}
