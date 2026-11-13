import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, type Tone } from '@mona/ui';
import type { CatalogProject } from '../shared/catalog.js';
import type { BudgetScopeView, CostGroupView, CostLensView, CostTotalsView } from '../shared/cost.js';

/**
 * The Cost lens. This surface reads what the ledger recorded and offers the two
 * actions the ledger owns: set an optional local budget, and write the recorded
 * rows to CSV. It computes no balance, no forecast and no per-token guess.
 */

const MAX_ROWS = 20;

export function microsToDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/** Whole micro-USD from a dollar string, or null when the input is not a usable amount. */
export function dollarsToMicros(value: string): number | null {
  const trimmed = value.trim().replace(/[$,\s]/g, '');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const micros = Math.round(parsed * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

/** Known money with the unknowns named beside it, never folded into a total. */
export function describeTotals(totals: CostTotalsView): string {
  if (totals.records === 0) return 'Nothing recorded';
  const known = microsToDollars(totals.knownMicros);
  if (totals.unknownRecords === 0) return known;
  return `${known} + ${totals.unknownRecords} unknown`;
}

function splitLabel(totals: CostTotalsView): string {
  const parts: string[] = [];
  if (totals.providerReportedMicros > 0) parts.push(`provider ${microsToDollars(totals.providerReportedMicros)}`);
  if (totals.estimatedMicros > 0) parts.push(`estimated ${microsToDollars(totals.estimatedMicros)}`);
  return parts.length > 0 ? parts.join(' · ') : 'No priced rows';
}

const ACTION_TONE: Record<CostLensView['evaluation']['action'], Tone> = {
  allow: 'success',
  warn: 'attention',
  block_next_dispatch: 'critical',
};

const ACTION_LABEL: Record<CostLensView['evaluation']['action'], string> = {
  allow: 'Within budget',
  warn: 'Near budget',
  block_next_dispatch: 'Next dispatch blocked',
};

const SCOPE_LABEL: Record<BudgetScopeView, string> = {
  project: 'Project total',
  day: 'Today',
  session: 'Session',
};

function GroupTable({ title, groups, empty }: { title: string; groups: CostGroupView[]; empty: string }) {
  const shown = groups.slice(0, MAX_ROWS);
  return (
    <details className="cost-group">
      <summary>
        <strong>{title}</strong> <span className="mona-muted">({groups.length})</span>
      </summary>
      {shown.length === 0 ? (
        <p className="mona-muted">{empty}</p>
      ) : (
        <ul className="cost-rows">
          {shown.map((group) => (
            <li key={group.key}>
              <span className="mona-mono break">{group.label}</span>
              <span>{describeTotals(group.totals)}</span>
              <span className="mona-muted">{splitLabel(group.totals)}</span>
              {group.detail ? <span className="mona-muted">{group.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {groups.length > shown.length ? (
        <p className="mona-muted">
          Showing the first {shown.length} of {groups.length}. The CSV export contains every recorded row.
        </p>
      ) : null}
    </details>
  );
}

export function CostPanel({
  project,
  sessionId,
  onSpendChanged,
}: {
  project: CatalogProject | null;
  sessionId: string | null;
  /** Keeps the header spend chip reading the same rows this panel just read. */
  onSpendChanged?: () => void;
}): React.JSX.Element {
  const [lens, setLens] = useState<CostLensView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<BudgetScopeView>('project');
  const [limit, setLimit] = useState('5.00');
  const [warn, setWarn] = useState('');
  const [stop, setStop] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  const projectId = project?.id ?? null;
  // The shell passes a fresh closure each render; calling it through a ref keeps
  // the load effect keyed to the project, not to the parent's render count.
  const spendNotify = useRef(onSpendChanged);
  spendNotify.current = onSpendChanged;

  const load = useCallback(async () => {
    if (!projectId) {
      setLens(null);
      return;
    }
    setLoading(true);
    const result = await window.mona.costLens({ projectId, sessionId });
    setLoading(false);
    if (result.ok) {
      setLens(result.data);
      setError(null);
      spendNotify.current?.();
    } else {
      setError(result.error.message);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyBudget = async (): Promise<void> => {
    if (!projectId) return;
    setFormError(null);
    const limitMicros = dollarsToMicros(limit);
    if (limitMicros === null) {
      setFormError('Enter a limit greater than zero, for example 5.00.');
      return;
    }
    const warnMicros = warn.trim() === '' ? null : dollarsToMicros(warn);
    const stopMicros = stop.trim() === '' ? null : dollarsToMicros(stop);
    if (warn.trim() !== '' && warnMicros === null) {
      setFormError('The warning amount must be a positive amount, or left empty for 80% of the limit.');
      return;
    }
    if (stop.trim() !== '' && stopMicros === null) {
      setFormError('The stop amount must be a positive amount, or left empty for the full limit.');
      return;
    }
    if (scope === 'session' && !sessionId) {
      setFormError('A session budget needs an open session.');
      return;
    }
    setSaving(true);
    const result = await window.mona.costSetBudget({
      projectId,
      scope,
      sessionId: scope === 'session' ? sessionId : null,
      limitMicros,
      warnMicros,
      stopMicros,
    });
    setSaving(false);
    if (result.ok) {
      setLens(result.data);
      setReceipt(
        `Saved the ${SCOPE_LABEL[scope].toLowerCase()} budget of ${microsToDollars(limitMicros)}. Enforced before dispatch, not by the provider.`,
      );
    } else {
      setFormError(result.error.message);
    }
  };

  const exportCsv = async (): Promise<void> => {
    if (!projectId) return;
    setExporting(true);
    const result = await window.mona.costExport({ projectId });
    setExporting(false);
    setReceipt(result.ok ? result.data.note : null);
    if (!result.ok) setError(result.error.message);
  };

  if (!project) {
    return (
      <section className="panel" aria-labelledby="cost-title">
        <p className="eyebrow">Cost lens</p>
        <h2 id="cost-title">Recorded spend</h2>
        <EmptyState title="No project open" body="Open a project to see its recorded cost and its budgets." />
      </section>
    );
  }

  const totals = lens?.totals;
  const cacheReported = totals ? totals.tokens.cacheHit !== null || totals.tokens.cacheMiss !== null : false;

  return (
    <section className="panel" aria-labelledby="cost-title">
      <p className="eyebrow">Cost lens</p>
      <h2 id="cost-title">Recorded spend</h2>
      <p className="lede">
        Every number here was recorded from a turn or read from a stored rate card. A missing price stays unknown; it is
        never shown or summed as $0.00.
      </p>

      {error ? (
        <div className="panel error-panel" role="alert">
          <h3>Cost could not be read</h3>
          <p>{error}</p>
          <Button size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {loading && !lens ? <p className="mona-muted">Reading recorded usage…</p> : null}

      {totals ? (
        <>
          <div className="facts">
            <div>
              <span className="fact-label">Project</span>
              <span className="fact-value">{project.label}</span>
            </div>
            <div>
              <span className="fact-label">Known cost</span>
              <span className="fact-value" data-testid="cost-known">
                {describeTotals(totals)}
              </span>
            </div>
            <div>
              <span className="fact-label">Where the price came from</span>
              <span className="fact-value">{splitLabel(totals)}</span>
            </div>
            <div>
              <span className="fact-label">Usage records</span>
              <span className="fact-value">{totals.records}</span>
            </div>
            <div>
              <span className="fact-label">Unknown-priced records</span>
              <span className="fact-value" data-testid="cost-unknown">
                {totals.unknownRecords}
              </span>
            </div>
            <div>
              <span className="fact-label">Latest record</span>
              <span className="fact-value">{totals.latestRecordedAt ?? 'None'}</span>
            </div>
            {cacheReported ? (
              <div>
                <span className="fact-label">Cache tokens (provider-reported only)</span>
                <span className="fact-value">
                  hit {totals.tokens.cacheHit ?? 'unknown'} · miss {totals.tokens.cacheMiss ?? 'unknown'}
                </span>
              </div>
            ) : null}
          </div>

          {totals.unknownReasons.length > 0 ? (
            <ul className="cost-rows">
              {totals.unknownReasons.map((reason) => (
                <li key={reason.reason}>
                  <span>Unknown: {reason.reason}</span>
                  <span>{reason.count} record(s)</span>
                </li>
              ))}
            </ul>
          ) : null}

          {lens.empty ? (
            <p className="mona-muted" data-testid="cost-empty">
              Nothing has been recorded for this project yet. That is an empty ledger, not a zero-dollar total.
            </p>
          ) : null}

          <div className="cost-actions">
            <Button size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <button
              type="button"
              className="ghost-button"
              data-role="cost-export"
              onClick={() => void exportCsv()}
              disabled={exporting || totals.records === 0}
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          </div>
          {receipt ? (
            <p className="mona-muted" data-testid="cost-receipt">
              {receipt}
            </p>
          ) : null}

          <h3>Budgets</h3>
          <p className="mona-muted">
            Optional and local. Budgets are checked before a dispatch and can warn or block the next one; they are not a
            provider invoice cap.
          </p>
          {lens.budgets.length === 0 ? (
            <p className="mona-muted">
              No budget is set. Nothing blocks dispatch, and no remaining balance is inferred.
            </p>
          ) : (
            <ul className="cost-rows" data-testid="cost-budgets">
              {lens.budgets.map((budget) => (
                <li key={budget.id}>
                  <strong>{SCOPE_LABEL[budget.scope]}</strong>
                  <span>
                    limit {microsToDollars(budget.limitMicros)} · warn {microsToDollars(budget.warnMicros)} · stop{' '}
                    {microsToDollars(budget.stopMicros)}
                  </span>
                  <span className="mona-muted">updated {budget.updatedAt}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="cost-status">
            <Badge tone={ACTION_TONE[lens.evaluation.action]}>{ACTION_LABEL[lens.evaluation.action]}</Badge>
          </div>
          {lens.evaluation.decisions.length > 0 ? (
            <ul className="cost-rows">
              {lens.evaluation.decisions.map((decision) => (
                <li key={decision.budgetId}>
                  <span>
                    {SCOPE_LABEL[decision.scope]}: spent {microsToDollars(decision.spentMicros)} of{' '}
                    {microsToDollars(decision.limitMicros)}
                    {decision.reservedMicros > 0 ? ` · reserved ${microsToDollars(decision.reservedMicros)}` : ''}
                  </span>
                  <span className="mona-muted">{decision.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mona-muted">{lens.evaluation.disclosure}</p>

          <form
            className="cost-budget-form"
            onSubmit={(event) => {
              event.preventDefault();
              void applyBudget();
            }}
          >
            <h3>Set a budget</h3>
            <div className="cost-budget-grid">
              <label>
                <span className="fact-label">Scope</span>
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as BudgetScopeView)}
                  aria-label="Budget scope"
                >
                  <option value="project">Project total</option>
                  <option value="day">Today</option>
                  <option value="session" disabled={!sessionId}>
                    This session{sessionId ? '' : ' (no session open)'}
                  </option>
                </select>
              </label>
              <label>
                <span className="fact-label">Limit (USD)</span>
                <input
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  inputMode="decimal"
                  aria-label="Budget limit in US dollars"
                />
              </label>
              <label>
                <span className="fact-label">Warn at (USD, optional)</span>
                <input
                  value={warn}
                  onChange={(event) => setWarn(event.target.value)}
                  placeholder="80% of limit"
                  inputMode="decimal"
                  aria-label="Warn at, in US dollars"
                />
              </label>
              <label>
                <span className="fact-label">Stop at (USD, optional)</span>
                <input
                  value={stop}
                  onChange={(event) => setStop(event.target.value)}
                  placeholder="the limit"
                  inputMode="decimal"
                  aria-label="Stop at, in US dollars"
                />
              </label>
            </div>
            {formError ? (
              <p className="mona-muted" role="alert" data-testid="cost-form-error">
                {formError}
              </p>
            ) : null}
            <Button size="sm" type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save budget'}
            </Button>
          </form>

          <h3>Breakdown</h3>
          <GroupTable title="By task" groups={lens.byTask} empty="No usage is attributed to a task yet." />
          <GroupTable title="By session" groups={lens.bySession} empty="No usage is attributed to a session yet." />
          <GroupTable title="By turn" groups={lens.byTurn} empty="No priced turn has been recorded yet." />

          <h3>Rate cards in use</h3>
          {lens.rates.length === 0 ? (
            <p className="mona-muted">
              No rate card is stored for this route, so locally estimated rows stay unknown rather than guessed.
            </p>
          ) : (
            <ul className="cost-rows">
              {lens.rates.map((rate) => (
                <li key={`${rate.provider}:${rate.model}:${rate.revision}`}>
                  <span className="mona-mono">
                    {rate.provider} · {rate.model} · {rate.revision}
                  </span>
                  <span className="mona-muted">
                    effective {rate.effectiveFrom} · {rate.source}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {lens.disclosure.length > 0 ? (
            <ul className="cost-disclosure">
              {lens.disclosure.map((line) => (
                <li key={line} className="mona-muted">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
