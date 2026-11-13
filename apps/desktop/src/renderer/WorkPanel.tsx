import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, type Tone } from '@mona/ui';
import type { CatalogProject } from '../shared/catalog.js';
import type { TaskBoardView, TaskCardView, TaskStatusView } from '../shared/tasks.js';

/**
 * The Work board. Every task, step, acceptance criterion, dependency edge and
 * eligibility verdict shown here was read from the task service. Creation is the
 * only write: creating a task starts nothing. Running a task still goes through
 * Studio, so this surface cannot become a second scheduler.
 */

const STATUS_TONE: Record<TaskStatusView, Tone> = {
  pending: 'neutral',
  running: 'info',
  verifying: 'attention',
  completed: 'success',
  blocked: 'critical',
  interrupted: 'attention',
  skipped: 'neutral',
};

const STATUS_LABEL: Record<TaskStatusView, string> = {
  pending: 'Pending',
  running: 'Running',
  verifying: 'Verifying',
  completed: 'Completed',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  skipped: 'Skipped',
};

const STEP_GLYPH: Record<TaskCardView['steps'][number]['status'], string> = {
  pending: '○',
  running: '▶',
  done: '✓',
  failed: '✕',
};

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function TaskCard({ task, titleById }: { task: TaskCardView; titleById: Map<string, string> }): React.JSX.Element {
  const label = (id: string): string => titleById.get(id) ?? id;
  return (
    <li className="task-card" data-testid="task-card" data-status={task.status}>
      <div className="task-head">
        <strong>{task.title}</strong>
        <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
        <span className="mona-muted">
          {task.owner === 'mona_queue' ? "Mona's queue" : 'Native workflow'} · #{task.ordinal}
        </span>
      </div>
      {task.description ? <p className="mona-muted">{task.description}</p> : null}
      <p className="mona-muted" data-testid="task-eligibility">
        {task.eligible ? 'Eligible to start now.' : `Not eligible: ${task.eligibilityReason}`}
      </p>
      {task.blockedReason ? <p className="mona-muted">Blocked: {task.blockedReason}</p> : null}
      {task.skippedReason ? <p className="mona-muted">Skipped: {task.skippedReason}</p> : null}

      {task.dependencies.length > 0 ? (
        <p className="mona-muted">
          Depends on {task.dependencies.map(label).join(', ')}
          {task.dependents.length > 0 ? ` · blocks ${task.dependents.map(label).join(', ')}` : ''}
        </p>
      ) : task.dependents.length > 0 ? (
        <p className="mona-muted">Blocks {task.dependents.map(label).join(', ')}</p>
      ) : null}

      {task.steps.length > 0 ? (
        <div>
          <span className="fact-label">Steps</span>
          <ol className="task-steps">
            {task.steps.map((step) => (
              <li key={step.id} aria-label={`${step.title}: ${step.status}`}>
                <span aria-hidden="true">{STEP_GLYPH[step.status]}</span> {step.title}
                <span className="mona-muted"> — {step.status}</span>
                {step.detail ? <span className="mona-muted"> ({step.detail})</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {task.criteria.length > 0 ? (
        <div>
          <span className="fact-label">Acceptance</span>
          <ul className="task-criteria">
            {task.criteria.map((criterion) => (
              <li key={criterion.id} aria-label={`${criterion.description}: ${criterion.satisfied ? 'met' : 'unmet'}`}>
                <span aria-hidden="true">{criterion.satisfied ? '✓' : '○'}</span> {criterion.description}
                <span className="mona-muted">
                  {' '}
                  — {criterion.satisfied ? 'met' : 'unmet'}
                  {criterion.required ? ' · required' : ' · optional'} ·{' '}
                  {criterion.kind === 'human' ? 'human' : 'check'}
                </span>
                {criterion.note ? <span className="mona-muted"> ({criterion.note})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {task.evidence.length > 0 ? (
        <div>
          <span className="fact-label">Evidence</span>
          <ul className="task-evidence">
            {task.evidence.map((item) => (
              <li key={item.id} className="mona-mono break">
                {item.path}
                <span className="mona-muted">
                  {' '}
                  · {item.recordedAt}
                  {item.stale ? ' · stale: no longer matches the file' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {task.requirementRefs.length > 0 ? (
        <p className="mona-muted">Traces to {task.requirementRefs.join(', ')}</p>
      ) : null}
    </li>
  );
}

export function WorkPanel({ project }: { project: CatalogProject | null }): React.JSX.Element {
  const [board, setBoard] = useState<TaskBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [criteria, setCriteria] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const projectId = project?.id ?? null;

  const load = useCallback(async () => {
    if (!projectId) {
      setBoard(null);
      return;
    }
    setLoading(true);
    const result = await window.mona.taskBoard({ projectId });
    setLoading(false);
    if (result.ok) {
      setBoard(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of board?.tasks ?? []) map.set(task.id, task.title);
    return map;
  }, [board]);

  const create = async (): Promise<void> => {
    if (!projectId) return;
    setFormError(null);
    if (title.trim() === '') {
      setFormError('A task needs a title.');
      return;
    }
    setSaving(true);
    const result = await window.mona.taskCreate({
      projectId,
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      owner: 'mona_queue',
      ...(lines(steps).length > 0 ? { steps: lines(steps) } : {}),
      ...(lines(criteria).length > 0 ? { criteria: lines(criteria) } : {}),
      ...(dependsOn ? { dependsOn: [dependsOn] } : {}),
    });
    setSaving(false);
    if (result.ok) {
      setBoard(result.data);
      setTitle('');
      setDescription('');
      setSteps('');
      setCriteria('');
      setDependsOn('');
    } else {
      setFormError(result.error.message);
    }
  };

  if (!project) {
    return (
      <section className="panel" aria-labelledby="work-title">
        <p className="eyebrow">Work</p>
        <h2 id="work-title">Work board</h2>
        <EmptyState title="No project open" body="Choose a project before assigning a bounded prompt." />
      </section>
    );
  }

  const tasks = board?.tasks ?? [];
  const nextTitle = board?.next ? (titleById.get(board.next) ?? board.next) : null;

  return (
    <section className="panel" aria-labelledby="work-title">
      <p className="eyebrow">Work</p>
      <h2 id="work-title">Work board</h2>
      <p className="lede">
        Tasks, steps, acceptance criteria and dependencies as the task service recorded them. A task is eligible only
        when its own dependencies and recorded evidence allow it.
      </p>

      {error ? (
        <div className="panel error-panel" role="alert">
          <h3>Tasks could not be read</h3>
          <p>{error}</p>
          <Button size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {board ? (
        <>
          <div className="work-summary">
            <span data-testid="work-count">
              {tasks.length} task{tasks.length === 1 ? '' : 's'}
            </span>
            <span className="mona-muted">
              {board.eligible.length} eligible · next: {nextTitle ?? 'nothing'}
            </span>
            <Button size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          <div className="work-badges">
            {Object.entries(board.counts)
              .filter(([, count]) => count > 0)
              .map(([status, count]) => (
                <Badge key={status} tone={STATUS_TONE[status as TaskStatusView]}>
                  {STATUS_LABEL[status as TaskStatusView]} {count}
                </Badge>
              ))}
          </div>

          {tasks.length === 0 ? (
            <EmptyState
              title="No tasks recorded"
              body="Unstarted tasks stay unstarted. Mona does not guess percentages or invent progress for this project."
            />
          ) : (
            <ul className="task-list">
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} titleById={titleById} />
              ))}
            </ul>
          )}

          <form
            className="task-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <h3>Add a task</h3>
            <p className="mona-muted">
              Creating a task records it as pending. It starts no engine and sends no prompt; run it from Studio when
              you choose to.
            </p>
            <label>
              <span className="fact-label">Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                aria-label="Task title"
                placeholder="e.g. Validate the export path"
              />
            </label>
            <label>
              <span className="fact-label">Description (optional)</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-label="Task description"
                rows={2}
              />
            </label>
            <label>
              <span className="fact-label">Steps, one per line (optional)</span>
              <textarea
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                aria-label="Task steps, one per line"
                rows={3}
              />
            </label>
            <label>
              <span className="fact-label">Acceptance criteria, one per line (optional)</span>
              <textarea
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                aria-label="Acceptance criteria, one per line"
                rows={3}
              />
            </label>
            {tasks.length > 0 ? (
              <label>
                <span className="fact-label">Depends on (optional)</span>
                <select
                  value={dependsOn}
                  onChange={(event) => setDependsOn(event.target.value)}
                  aria-label="Depends on"
                >
                  <option value="">Nothing</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {formError ? (
              <p className="mona-muted" role="alert" data-testid="task-form-error">
                {formError}
              </p>
            ) : null}
            <Button size="sm" type="submit" variant="primary" disabled={saving}>
              {saving ? 'Adding…' : 'Add task'}
            </Button>
          </form>
        </>
      ) : loading ? (
        <p className="mona-muted">Reading the board…</p>
      ) : null}
    </section>
  );
}
