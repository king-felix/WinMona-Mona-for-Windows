import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Notification, type Tone } from '@mona/ui';
import type {
  CapabilityExplorerView,
  CapabilityRow,
  CapabilityStatus,
  IntegrationLabel,
  LogContent,
  TerminalCheck,
} from '@mona/contracts';

function statusTone(status: CapabilityStatus): Tone {
  if (status === 'qualified') return 'success';
  if (status === 'read-qualified') return 'info';
  if (status === 'unavailable-by-choice' || status === 'unavailable-on-platform') return 'attention';
  if (status === 'blocked') return 'critical';
  if (status === 'unknown') return 'attention';
  return 'info';
}

function integrationTone(integration: IntegrationLabel): Tone {
  if (integration === 'Native view') return 'success';
  if (integration === 'Advanced action') return 'info';
  if (integration === 'Integrated terminal') return 'attention';
  return 'critical';
}

export function CapabilitiesPanel({
  view,
  error,
  loading,
  focusId,
  onRefresh,
}: {
  view: CapabilityExplorerView | null;
  error: string | null;
  loading: boolean;
  focusId: string | null;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CapabilityStatus>('all');
  const [terminalCheck, setTerminalCheck] = useState<TerminalCheck | null>(null);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [log, setLog] = useState<LogContent | null>(null);
  const [logBusy, setLogBusy] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    const node = document.getElementById(`capability-${focusId}`);
    if (node) node.scrollIntoView?.({ block: 'center' });
  }, [focusId, view?.rows.length]);

  const filtered = useMemo(() => {
    const rows = view?.rows ?? [];
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        row.id.toLowerCase().includes(needle) ||
        row.upstream.name.toLowerCase().includes(needle) ||
        row.uiLocation.toLowerCase().includes(needle) ||
        row.gap?.toLowerCase().includes(needle) === true
      );
    });
  }, [query, statusFilter, view?.rows]);

  async function checkTerminal(): Promise<void> {
    setTerminalBusy(true);
    setTerminalError(null);
    try {
      const result = await window.mona.capabilitiesCheckTerminal();
      if (result.ok) setTerminalCheck(result.data);
      else setTerminalError(result.error.message);
    } finally {
      setTerminalBusy(false);
    }
  }

  async function readLog(name: string, offset = 0): Promise<void> {
    setLogBusy(name);
    setLogError(null);
    try {
      const result = await window.mona.capabilitiesReadLog({ name, offset, limit: 64 * 1024 });
      if (result.ok) {
        setLog((current) =>
          current && current.name === result.data.name && offset > 0
            ? { ...result.data, content: `${current.content}${result.data.content}` }
            : result.data,
        );
      } else {
        setLogError(result.error.message);
      }
    } finally {
      setLogBusy(null);
    }
  }

  if (!view) {
    return (
      <Card title="Capabilities">
        {error ? (
          <Notification tone="critical" title="Capability explorer unavailable">
            {error}
          </Notification>
        ) : (
          <EmptyState
            title={loading ? 'Reading capabilities' : 'No capability data'}
            body="The ledger has not been read yet."
          />
        )}
      </Card>
    );
  }

  return (
    <Card title="Capabilities">
      <p className="mona-muted">
        This is an auditable map of the pinned engine surface. Rows come from the versioned ledger; live identity and
        capability flags come from the running engine. Coverage is catalog coverage, not a parity claim.
      </p>
      {error ? (
        <Notification tone="critical" title="Capability refresh failed">
          {error}
        </Notification>
      ) : null}
      {view.caveats.map((caveat) => (
        <p className="mona-muted" key={caveat} data-testid="capability-caveat">
          {caveat}
        </p>
      ))}

      <div className="facts">
        <div>
          <span className="fact-label">Running engine</span>
          <span className="fact-value mona-mono" data-testid="capability-engine">
            {view.identity.version ?? 'not connected'}
            {view.identity.commit ? ` · ${view.identity.commit.slice(0, 12)}` : ''}
          </span>
        </div>
        <div>
          <span className="fact-label">Ledger</span>
          <span className="fact-value mona-mono">
            {view.identity.ledgerVersion ?? 'unknown'}
            {view.identity.ledgerCommit ? ` · ${view.identity.ledgerCommit.slice(0, 12)}` : ''}
          </span>
        </div>
        <div>
          <span className="fact-label">Compatibility / drift</span>
          <span className="fact-value" data-testid="capability-drift">
            {view.identity.compatibility} · {view.identity.drift}
          </span>
        </div>
        <div>
          <span className="fact-label">Coverage</span>
          <span className="fact-value" data-testid="capability-coverage">
            {view.coverage.verifiedEntryPoints}/{view.coverage.total} verified ({view.coverage.completenessPercent}%)
          </span>
        </div>
        <div>
          <span className="fact-label">Rows</span>
          <span className="fact-value">
            {view.coverage.qualified} qualified · {view.coverage.readQualified} read-qualified ·{' '}
            {view.coverage.discovered} discovered · {view.coverage.unavailable} unavailable · {view.coverage.blocked}{' '}
            blocked
          </span>
        </div>
      </div>
      <p className="mona-muted">{view.coverage.note}</p>

      <section aria-labelledby="capability-terminal">
        <h3 id="capability-terminal">Integrated terminal</h3>
        <p>
          <Badge tone={view.terminal.status === 'available' ? 'success' : 'attention'}>{view.terminal.status}</Badge>{' '}
          <span className="mona-muted mona-mono">{view.terminal.route}</span>
        </p>
        <p className="mona-muted" data-testid="terminal-reason">
          {view.terminal.reason}
        </p>
        <p className="mona-muted">
          Flags: stream {flagLabel(view.terminal.flags.stream)} · input {flagLabel(view.terminal.flags.input)} · resize{' '}
          {flagLabel(view.terminal.flags.resize)} · kill {flagLabel(view.terminal.flags.kill)}
        </p>
        <div className="mona-row">
          <Button
            size="sm"
            variant="secondary"
            disabled={terminalBusy || !view.connected}
            onClick={() => void checkTerminal()}
          >
            Check terminal route
          </Button>
        </div>
        {terminalError ? (
          <Notification tone="critical" title="Terminal check failed">
            {terminalError}
          </Notification>
        ) : null}
        {terminalCheck ? (
          <p className="mona-muted" data-testid="terminal-check">
            HTTP {terminalCheck.statusCode ?? 'unknown'} · {terminalCheck.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="capability-logs">
        <h3 id="capability-logs">Engine logs</h3>
        {view.logs.status === 'unavailable' ? (
          <Notification tone="attention" title="Logs unavailable">
            {view.logs.note ?? 'The engine did not report a log directory.'}
          </Notification>
        ) : view.logs.sources.every((source) => source.files.length === 0) ? (
          <p className="mona-muted">No log files are present.</p>
        ) : (
          <ul className="agent-tree">
            {view.logs.sources.map((source) => (
              <li key={source.dir}>
                <p className="agent-event mona-mono">{source.dir}</p>
                <ul>
                  {source.files.map((file) => (
                    <li key={`${source.dir}:${file.name}`} className="agent-row">
                      <strong>{file.name}</strong>
                      <span className="mona-muted">
                        {file.size.toLocaleString()} bytes
                        {file.modifiedAt ? ` · ${file.modifiedAt}` : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={logBusy === file.name}
                        onClick={() => void readLog(file.name)}
                      >
                        Read
                      </Button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {logError ? (
          <Notification tone="critical" title="Log read failed">
            {logError}
          </Notification>
        ) : null}
        {log ? (
          <div data-testid="log-content">
            <p className="mona-muted">
              {log.name} · offset {log.offset} · {log.bytes.toLocaleString()} bytes
              {log.truncated ? ' · more remains' : ' · end of file'}
              {log.redacted ? ' · credential-shaped values redacted' : ''}
            </p>
            <pre className="mona-mono" style={{ maxHeight: '22rem', overflow: 'auto' }}>
              {log.content}
            </pre>
            {log.truncated ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={logBusy === log.name}
                onClick={() => void readLog(log.name, log.offset + log.bytes)}
              >
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="capability-live-flags">
        <h3 id="capability-live-flags">Live engine capability flags</h3>
        {view.liveFlags.length === 0 ? (
          <p className="mona-muted">No live flags are available; connect the engine.</p>
        ) : (
          <ul className="agent-tree">
            {view.liveFlags.map((flag) => (
              <li key={flag.name} className="agent-row">
                <Badge tone={flag.value ? 'success' : 'info'}>{flag.value ? 'true' : 'false'}</Badge>
                <span className="mona-mono">{flag.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="capability-rows">
        <h3 id="capability-rows">Capability rows</h3>
        <div className="mona-row">
          <label>
            <span className="fact-label">Search</span>
            <input
              className="mona-input"
              type="search"
              value={query}
              placeholder="Name, ID, UI location or gap"
              onChange={(event) => setQuery(event.target.value)}
              data-testid="capability-search"
            />
          </label>
          <label>
            <span className="fact-label">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'all' | CapabilityStatus)}
              data-testid="capability-status-filter"
            >
              <option value="all">All statuses</option>
              <option value="qualified">qualified</option>
              <option value="read-qualified">read-qualified</option>
              <option value="discovered">discovered</option>
              <option value="unavailable-by-choice">unavailable-by-choice</option>
              <option value="unavailable-on-platform">unavailable-on-platform</option>
              <option value="blocked">blocked</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void onRefresh()}>
            Refresh
          </Button>
        </div>
        <p className="mona-muted">
          Showing {filtered.length} of {view.rows.length} rows.
        </p>
        <ul className="agent-tree">
          {filtered.map((row) => (
            <CapabilityRowView key={row.id} row={row} focused={row.id === focusId} />
          ))}
        </ul>
      </section>
    </Card>
  );
}

function CapabilityRowView({ row, focused }: { row: CapabilityRow; focused: boolean }): React.JSX.Element {
  return (
    <li
      id={`capability-${row.id}`}
      data-testid={`capability-${row.id}`}
      className={focused ? 'capability-focus' : undefined}
    >
      <details open={focused || undefined}>
        <summary>
          <span className="agent-row">
            <Badge tone={statusTone(row.status)}>{row.status}</Badge>
            <Badge tone={integrationTone(row.integration)}>{row.integration}</Badge>
            <strong>{row.upstream.name}</strong>
            <span className="mona-muted mona-mono">{row.id}</span>
          </span>
        </summary>
        <p className="agent-event">
          {row.upstream.surface} · {row.upstream.source} · {row.upstream.version}
        </p>
        <p className="agent-event">
          Platform {row.platform} · class {row.kind} · cost {row.costImplications}
        </p>
        <p className="agent-event">Permission: {row.permissionImplications}</p>
        <p className="agent-event">Arguments: {row.requiredArguments}</p>
        <p className="agent-event">UI location: {row.uiLocation}</p>
        <p className="agent-event mona-mono">
          Tests: {row.tests.length === 0 ? 'none recorded' : row.tests.join(', ')}
        </p>
        <p className="agent-event">
          Evidence: help {row.evidence.helpCapture ?? 'none'} · report {row.evidence.contractReport ?? 'none'}
        </p>
        {row.gap ? <p className="agent-event">Gap: {row.gap}</p> : null}
      </details>
    </li>
  );
}

function flagLabel(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'true' : 'false';
}
