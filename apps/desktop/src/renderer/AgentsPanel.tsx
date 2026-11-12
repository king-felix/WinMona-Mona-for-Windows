import { useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Notification, type Tone } from '@mona/ui';
import type { AgentNode, CostEvidence, ObservatoryView } from '@mona/contracts';
import type { CatalogProject } from '../shared/catalog.js';

const ROLES = [
  'worker',
  'explore',
  'builder',
  'reviewer',
  'verifier',
  'consultant',
  'synthesizer',
  'planner',
  'manager',
  'operator',
];

const OWNER_TONE: Record<ObservatoryView['ownership']['owner'], Tone> = {
  none: 'neutral',
  mona_queue: 'info',
  native_goal: 'attention',
  native_fleet: 'attention',
  native_agent: 'info',
};

function costLabel(cost: CostEvidence): string {
  if (cost.status === 'known') return `$${cost.usd.toFixed(4)}`;
  return `unknown — ${cost.reason}`;
}

function statusTone(status: string): Tone {
  if (['completed', 'complete', 'succeeded'].includes(status)) return 'success';
  if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) return 'critical';
  if (['running', 'starting', 'active'].includes(status)) return 'attention';
  return 'neutral';
}

function nodeIndent(node: AgentNode, nodes: AgentNode[]): number {
  let depth = 0;
  let cursor = node;
  const seen = new Set<string>();
  while (cursor.parentId && depth < 6 && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = nodes.find((candidate) => candidate.id === cursor.parentId);
    if (!parent) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

export function AgentsPanel({
  project,
  sessionId,
}: {
  project: CatalogProject | null;
  sessionId: string | null;
}): React.JSX.Element {
  const [view, setView] = useState<ObservatoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [goalText, setGoalText] = useState('');
  const [runName, setRunName] = useState('mona-run');
  const [runRole, setRunRole] = useState('worker');
  const [runInstructions, setRunInstructions] = useState('Reply with exactly OK. Do not use tools.');

  async function load(): Promise<void> {
    if (!project || !sessionId) {
      setView(null);
      return;
    }
    setError(null);
    const studio = await window.mona.studioGet({ projectId: project.id, sessionId });
    const activeThread = studio.ok ? (studio.data.thread?.threadId ?? null) : null;
    setThreadId(activeThread);
    const result = await window.mona.observatoryGet({ projectId: project.id, threadId: activeThread });
    if (result.ok) setView(result.data);
    else setError(result.error.message);
  }

  useEffect(() => {
    void load();
  }, [project?.id, sessionId]);

  async function act<T>(
    key: string,
    call: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>,
    describe: (data: T) => { tone: Tone; title: string; body: string },
  ): Promise<void> {
    setBusy(key);
    try {
      const result = await call();
      if (result.ok) setNotice(describe(result.data));
      else setNotice({ tone: 'critical', title: 'Action refused', body: result.error.message });
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!project) {
    return (
      <section className="panel" aria-labelledby="agents-title">
        <p className="eyebrow">Agents</p>
        <h2 id="agents-title">Native orchestration</h2>
        <EmptyState
          title="No project open"
          body="Open a project to inspect its native goals, fleets and child agents."
        />
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="agents-title">
      <p className="eyebrow">Agents</p>
      <h2 id="agents-title">Agent observatory</h2>
      <p className="lede">
        This view reads the engine’s own goals, fleet runs and child-agent records. Unknown spend stays unknown, and
        Mona never starts a second scheduler beside a native run.
      </p>

      {notice ? (
        <Notification tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notification>
      ) : null}
      {error ? (
        <Notification tone="critical" title="Observatory unavailable">
          {error}
        </Notification>
      ) : null}

      {view ? (
        <>
          <div className="facts">
            <div>
              <span className="fact-label">Execution owner</span>
              <span className="fact-value">
                <Badge tone={OWNER_TONE[view.ownership.owner]}>{view.ownership.owner}</Badge>{' '}
                {view.ownership.runId ?? ''}
              </span>
            </div>
            <div>
              <span className="fact-label">Owner detail</span>
              <span className="fact-value" data-testid="ownership-detail">
                {view.ownership.detail}
              </span>
            </div>
            <div>
              <span className="fact-label">Thread spend</span>
              <span className="fact-value">{costLabel(view.spend.threadCost)}</span>
            </div>
            <div>
              <span className="fact-label">Aggregate</span>
              <span className="fact-value" data-testid="aggregate-spend">
                {costLabel(view.spend.aggregate)}
              </span>
            </div>
            <div>
              <span className="fact-label">Child spend reported</span>
              <span className="fact-value">
                {view.spend.childrenKnownMicros === null
                  ? 'unknown'
                  : `$${(view.spend.childrenKnownMicros / 1_000_000).toFixed(4)}`}
              </span>
            </div>
            <div>
              <span className="fact-label">Captured</span>
              <span className="fact-value">{new Date(view.capturedAt).toLocaleTimeString()}</span>
            </div>
          </div>
          <p className="mona-muted" data-testid="spend-note">
            {view.spend.note}
          </p>

          {view.caveats.map((caveat) => (
            <p className="mona-muted" key={caveat}>
              {caveat}
            </p>
          ))}

          <Card title="Graph">
            {view.nodes.length === 0 ? (
              <p className="mona-muted">No native records are present for this thread.</p>
            ) : (
              <ul className="agent-tree" data-testid="agent-tree">
                {view.nodes.map((node) => (
                  <li key={node.id} style={{ marginLeft: `${nodeIndent(node, view.nodes) * 18}px` }}>
                    <div className="agent-row">
                      <Badge tone={statusTone(node.status)}>{node.status}</Badge>
                      <strong>{node.label}</strong>
                      <span className="mona-muted">{node.kind}</span>
                      {node.role ? <span className="mona-muted">{node.role}</span> : null}
                      <span className="mona-mono" title={node.spend.status === 'known' ? 'engine priced' : 'unknown'}>
                        {costLabel(node.spend)}
                      </span>
                      {node.spendIncludedInParent ? <Badge tone="info">in parent total</Badge> : null}
                    </div>
                    {node.lastEvent ? <p className="agent-event">{node.lastEvent}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Native goals">
            {view.goals.length === 0 ? (
              <p className="mona-muted">No native goal is recorded for this thread.</p>
            ) : (
              <ul className="agent-tree">
                {view.goals.map((goal) => (
                  <li key={goal.goalId}>
                    <div className="agent-row">
                      <Badge tone={statusTone(goal.status)}>{goal.status}</Badge>
                      <strong>{goal.objective || goal.goalId}</strong>
                      <span className="mona-muted">{goal.tokensUsed.toLocaleString()} tokens</span>
                    </div>
                    {goal.status === 'active' && threadId ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === 'goal-complete'}
                        onClick={() =>
                          void act(
                            'goal-complete',
                            () => window.mona.completeGoal({ projectId: project.id, threadId }),
                            () => ({
                              tone: 'success',
                              title: 'Goal completed',
                              body: 'The engine marked the goal complete.',
                            }),
                          )
                        }
                      >
                        Complete goal
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {threadId ? (
              <div className="mona-row">
                <label>
                  <span className="fact-label">New goal objective</span>
                  <textarea
                    value={goalText}
                    onChange={(event) => setGoalText(event.target.value)}
                    rows={2}
                    maxLength={4_000}
                    placeholder="State one objective. Creating a goal starts a native goal kickoff turn."
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!goalText.trim() || busy === 'goal-create'}
                  onClick={() =>
                    void act(
                      'goal-create',
                      () =>
                        window.mona.createGoal({
                          projectId: project.id,
                          threadId,
                          objective: goalText.trim(),
                        }),
                      (data) => ({ tone: 'attention', title: 'Native goal created', body: data.detail }),
                    ).then(() => setGoalText(''))
                  }
                >
                  Create native goal
                </Button>
              </div>
            ) : (
              <p className="mona-muted">Open a studio thread before creating a goal.</p>
            )}
          </Card>

          <Card title="Native fleet runs">
            {view.fleetRuns.length === 0 ? (
              <p className="mona-muted">No fleet run is recorded for this project.</p>
            ) : (
              <ul className="agent-tree" data-testid="fleet-runs">
                {view.fleetRuns.map((run) => (
                  <li key={run.id}>
                    <div className="agent-row">
                      <Badge tone={statusTone(run.lifecycleStatus)}>{run.lifecycleStatus}</Badge>
                      <strong>{run.name}</strong>
                      <span className="mona-muted">
                        {run.taskCount} task(s) · {run.workerCount} worker(s) · {run.workflowKind}
                      </span>
                      <span className="mona-mono">{run.id}</span>
                    </div>
                    <p className="agent-event">
                      queued {run.counts.queued} · running {run.counts.running} · completed {run.counts.completed} ·
                      failed {run.counts.failed}
                    </p>
                    <div className="mona-row">
                      {['queued', 'scheduled', 'starting'].includes(run.lifecycleStatus) ? (
                        <Button
                          size="sm"
                          disabled={busy === `start-${run.id}`}
                          onClick={() =>
                            void act(
                              `start-${run.id}`,
                              () => window.mona.startFleetRun({ projectId: project.id, runId: run.id }),
                              (data) => ({
                                tone: data.observation.leased > 0 ? 'success' : 'attention',
                                title: `Start: ${data.receipt.execution}`,
                                body: data.observation.detail,
                              }),
                            )
                          }
                        >
                          Start run
                        </Button>
                      ) : null}
                      {['running', 'queued', 'scheduled', 'starting'].includes(run.lifecycleStatus) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === `stop-${run.id}`}
                          onClick={() =>
                            void act(
                              `stop-${run.id}`,
                              () => window.mona.stopFleetRun({ projectId: project.id, runId: run.id }),
                              (data) => ({
                                tone: data.acknowledged ? 'success' : 'attention',
                                title: 'Stop requested',
                                body: 'The runtime acknowledged the stop. Work already performed is not rolled back.',
                              }),
                            )
                          }
                        >
                          Stop run
                        </Button>
                      ) : null}
                      {run.workers.map((worker) => (
                        <Button
                          key={worker.id}
                          size="sm"
                          variant="secondary"
                          disabled={busy === `worker-${worker.id}`}
                          onClick={() =>
                            void act(
                              `worker-${worker.id}`,
                              () => window.mona.interruptWorker({ projectId: project.id, workerId: worker.id }),
                              (data) => ({
                                tone: data.acknowledged ? 'success' : 'attention',
                                title: 'Worker interrupt',
                                body: worker.name,
                              }),
                            )
                          }
                        >
                          Interrupt {worker.name}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mona-row">
              <label>
                <span className="fact-label">Run name</span>
                <input value={runName} onChange={(event) => setRunName(event.target.value)} maxLength={80} />
              </label>
              <label>
                <span className="fact-label">Role</span>
                <select value={runRole} onChange={(event) => setRunRole(event.target.value)}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              <span className="fact-label">Task instructions</span>
              <textarea
                value={runInstructions}
                onChange={(event) => setRunInstructions(event.target.value)}
                rows={3}
                maxLength={20_000}
              />
            </label>
            <div className="mona-row">
              <Button
                size="sm"
                disabled={!runName.trim() || !runInstructions.trim() || busy === 'create-run'}
                onClick={() =>
                  void act(
                    'create-run',
                    () =>
                      window.mona.createFleetRun({
                        projectId: project.id,
                        name: runName.trim(),
                        instructions: runInstructions.trim(),
                        role: runRole,
                      }),
                    (data) => ({ tone: 'info', title: 'Fleet run created', body: data.detail }),
                  )
                }
              >
                Create serial run
              </Button>
            </div>
            <p className="mona-muted">
              Mona creates one task and one worker. Parallel builder runs need isolated worktrees and a merge boundary;
              this surface does not pretend that support exists.
            </p>
          </Card>

          <Card title="Child agents">
            {view.agentRuns.length === 0 ? (
              <p className="mona-muted">No child agent is recorded for this thread.</p>
            ) : (
              <ul className="agent-tree" data-testid="agent-runs">
                {view.agentRuns.map((run) => (
                  <li key={run.id}>
                    <div className="agent-row">
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      <strong>{run.name}</strong>
                      <span className="mona-muted">
                        {run.role} · {run.model}
                      </span>
                      <span className="mona-mono">
                        {run.usage.status === 'reported' && run.usage.costMicros !== null
                          ? `$${(run.usage.costMicros / 1_000_000).toFixed(4)}`
                          : `unknown — ${run.usage.note ?? 'no usage reported'}`}
                      </span>
                      {run.spendIncludedInParent ? <Badge tone="info">in parent total</Badge> : null}
                    </div>
                    <p className="agent-event">
                      {run.objective || 'No objective text recorded.'} · depth {run.depth}
                      {run.verificationStatus ? ` · ${run.verificationStatus}` : ''}
                    </p>
                    {run.artifacts.length > 0 ? (
                      <p className="agent-event">
                        Artifacts: {run.artifacts.map((artifact) => `${artifact.kind}:${artifact.name}`).join(', ')}
                      </p>
                    ) : null}
                    {['running', 'starting'].includes(run.status) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === `cancel-${run.id}`}
                        onClick={() =>
                          void act(
                            `cancel-${run.id}`,
                            () => window.mona.cancelAgentRun({ projectId: project.id, runId: run.id }),
                            (data) => ({
                              tone: data.acknowledged ? 'success' : 'attention',
                              title: 'Child cancel',
                              body: run.name,
                            }),
                          )
                        }
                      >
                        Cancel child
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Control history">
            {view.diagnostics.length === 0 ? (
              <p className="mona-muted">No control action has been taken from this window.</p>
            ) : (
              <ul className="diagnostics-list">
                {view.diagnostics.slice(-12).map((line) => (
                  <li key={line} className="mona-mono">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="mona-row">
            <Button size="sm" onClick={() => void load()} disabled={busy !== null}>
              Refresh
            </Button>
          </div>
        </>
      ) : (
        <EmptyState title="Reading native state" body="No engine record has been read yet." />
      )}
    </section>
  );
}
