import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing cost vocabulary. Every number here came from recorded usage
 * rows; nothing is estimated for display and no remaining balance is inferred.
 * An unknown price is carried as an unknown count with its reason, never as
 * $0.00, and the provider-reported and locally-estimated totals stay separate so
 * the CSV export and the screen can both say where a number came from.
 */
export const COST_CHANNELS = {
  lens: 'mona:cost-lens',
  setBudget: 'mona:cost-budget-set',
  exportCsv: 'mona:cost-export',
} as const;

export type BudgetScopeView = 'session' | 'project' | 'day';
export type BudgetActionView = 'allow' | 'warn' | 'block_next_dispatch';

export type CostTotalsView = {
  records: number;
  /** Sum of rows the provider priced itself. */
  providerReportedMicros: number;
  /** Sum of rows Mona priced from a recorded rate card. */
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

export type CostGroupView = {
  key: string;
  label: string;
  /** Secondary fact, e.g. the task a turn belongs to. Never invented. */
  detail: string | null;
  totals: CostTotalsView;
};

export type CostRateView = {
  provider: string;
  model: string;
  revision: string;
  effectiveFrom: string;
  source: string;
};

export type CostBudgetView = {
  id: string;
  scope: BudgetScopeView;
  sessionId: string | null;
  limitMicros: number;
  warnMicros: number;
  stopMicros: number;
  updatedAt: string;
};

export type CostDecisionView = {
  budgetId: string;
  scope: BudgetScopeView;
  action: BudgetActionView;
  limitMicros: number;
  warnAtMicros: number;
  stopAtMicros: number;
  spentMicros: number;
  reservedMicros: number;
  projectedMicros: number;
  unknownRecords: number;
  detail: string;
};

export type CostLensView = {
  projectId: string;
  totals: CostTotalsView;
  byTurn: CostGroupView[];
  byTask: CostGroupView[];
  bySession: CostGroupView[];
  rates: CostRateView[];
  budgets: CostBudgetView[];
  /** What the next dispatch would be allowed to do, computed now. */
  evaluation: { action: BudgetActionView; decisions: CostDecisionView[]; disclosure: string };
  /** Limits of the local enforcement, stated so nobody mistakes it for an invoice. */
  disclosure: string[];
  /** True when no usage row exists at all: an empty lens is a fact, not zero spend. */
  empty: boolean;
};

export type CostExportView = {
  saved: boolean;
  path: string | null;
  bytes: number;
  rows: number;
  note: string;
};

export type BudgetInputView = {
  projectId: string;
  scope: BudgetScopeView;
  sessionId?: string | null;
  limitMicros: number;
  warnMicros?: number | null;
  stopMicros?: number | null;
};

export type CostBridge = {
  costLens(input: { projectId: string; sessionId?: string | null }): Promise<IpcResult<CostLensView>>;
  costSetBudget(input: BudgetInputView): Promise<IpcResult<CostLensView>>;
  /** Writes the recorded usage rows to a CSV file the user chooses. No model call. */
  costExport(input: { projectId: string }): Promise<IpcResult<CostExportView>>;
};
