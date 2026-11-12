import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, Markdown, Notification, type Tone } from '@mona/ui';
import { ENGINE_STATUS_LABEL } from '../shared/engine-status.js';
import type { CatalogProject, EngineView, ProjectSpend, PromptFavorite, UiStateView } from '../shared/catalog.js';
import type { AppInfo } from '../shared/ipc.js';
import type { StudioMode, StudioRun, StudioView as StudioState, TimelineItem, TimelineKind } from '../shared/studio.js';

const PREVIEW_CHARS = 2_000;
const TOOL_PREVIEW_CHARS = 1_500;
/**
 * Rows rendered at once. The shell still loads the newest 500 items into state;
 * this only bounds what exists in the DOM, because rendered rows — not stored
 * text — are what costs memory. Measured: removing 400 of 500 rendered rows from
 * the live DOM released ~23 MB of working set (P23-memory-dev.json).
 */
const TIMELINE_RENDER_PAGE = 120;

const KIND_LABEL: Record<TimelineKind, string> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  status: 'Status',
  outcome: 'Outcome',
  approval: 'Approval',
  error: 'Problem',
};

const KIND_TONE: Record<TimelineKind, Tone> = {
  user: 'info',
  assistant: 'neutral',
  tool: 'neutral',
  status: 'neutral',
  outcome: 'success',
  approval: 'attention',
  error: 'critical',
};

const RUN_LABEL: Record<StudioRun['state'], string> = {
  idle: 'Ready',
  preparing: 'Preparing',
  running: 'Running',
  reconnecting: 'Reconnecting',
  interrupting: 'Interrupting',
  awaiting_approval: 'Awaiting approval',
  failed: 'Needs attention',
};

const POSTURE_LABEL: Record<string, string> = {
  full_access: 'Full Access',
  workspace_write: 'Workspace write',
  read_only: 'Read only',
  unknown: 'Unknown posture',
};

function formatSpend(spend: ProjectSpend | null): string {
  if (!spend || spend.turnCount === 0) return 'No recorded spend';
  if (spend.knownCostMicros <= 0) return spend.unknownCostRecords > 0 ? 'Unknown' : 'No recorded spend';
  const dollars = `$${(spend.knownCostMicros / 1_000_000).toFixed(4)}`;
  return spend.unknownCostRecords > 0 ? `${dollars} + unknown` : dollars;
}

function repoLabel(project: CatalogProject): string {
  if (project.repoKind === 'worktree') return 'Git worktree';
  if (project.repoKind === 'git') return 'Git repository';
  return 'No Git repository';
}

function timeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function connectionTone(engine: EngineView | null, project: CatalogProject | null): Tone {
  if (!engine) return 'neutral';
  if (engine.state === 'connected') {
    if (project && engine.workspace && engine.workspace !== project.canonicalPath) return 'attention';
    return 'success';
  }
  if (engine.state === 'failed' || engine.state === 'crashed') return 'critical';
  if (engine.state === 'starting' || engine.state === 'stopping') return 'info';
  return 'neutral';
}

export type StudioPanelProps = {
  info: AppInfo | null;
  project: CatalogProject | null;
  engine: EngineView | null;
  spend: ProjectSpend | null;
  draft: string;
  sessionId: string | null;
  ui: UiStateView | null;
  busy: string | null;
  /** Increments when a launch lands; the ready composer takes focus. */
  focusToken?: number;
  identity?: { color: string; monogram: string } | null;
  favorites?: PromptFavorite[];
  onSaveFavorite?: (label: string, text: string) => void;
  onRemoveFavorite?: (favoriteId: string) => void;
  onDraft: (text: string) => void;
  onOpenFolder: () => void;
  onStart: () => void;
  onStop: () => void;
  onNewSession: () => void;
  onLocate: () => void;
  /** Called after a prompt is accepted: the draft has been sent, not lost. */
  onDraftSent: () => void;
  /** Ask the shell to re-read recorded spend after a turn settles. */
  onSpendRefresh: () => void;
  /** Export the recorded conversation; returns a message for the notice line. */
  onExport?: () => Promise<string>;
};

export function StudioPanel(props: StudioPanelProps): React.JSX.Element {
  const { info, project, engine, spend, draft, sessionId, ui, busy } = props;
  const onSpendRefresh = props.onSpendRefresh;
  const [mode, setMode] = useState<StudioMode>('agent');
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [renderPage, setRenderPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [favoriteLabel, setFavoriteLabel] = useState('');
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastDelta = useRef<Map<string, number>>(new Map());
  const projectId = project?.id ?? null;
  const session = projectId ? ui?.projects[projectId]?.sessions.find((item) => item.sessionId === sessionId) : null;

  // A new session, project or mode starts at the newest page again.
  useEffect(() => {
    setRenderPage(1);
  }, [projectId, sessionId, mode]);

  const unwrap = useCallback(
    async <T,>(promise: Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>, title: string) => {
      try {
        const result = await promise;
        if (result.ok) return result.data;
        setActionError(`${title}: ${result.error.message}`);
        return null;
      } catch {
        setActionError(`${title}: the application bridge did not respond.`);
        return null;
      }
    },
    [],
  );

  // A launch from Explorer leaves the caret in the composer: the project is
  // ready for a task, and no task has been invented for the user.
  useEffect(() => {
    if ((props.focusToken ?? 0) > 0) composerRef.current?.focus();
  }, [props.focusToken]);

  const applyItem = useCallback((items: TimelineItem[], next: TimelineItem): TimelineItem[] => {
    const index = items.findIndex((item) => item.id === next.id);
    if (index === -1) {
      const merged = [...items, next];
      merged.sort((a, b) => a.seq - b.seq);
      return merged;
    }
    const copy = [...items];
    copy[index] = next;
    return copy;
  }, []);

  // Load the persisted studio state for this project/session/mode.
  useEffect(() => {
    if (!projectId || !sessionId) {
      setStudio(null);
      return;
    }
    let alive = true;
    void (async () => {
      const result = await window.mona.studioGet({ projectId, sessionId, mode });
      if (!alive) return;
      if (result.ok) {
        setStudio(result.data);
        setLoadError(null);
      } else {
        setLoadError(result.error.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, sessionId, mode]);

  // One subscription to main-process pushes for the selected project.
  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = window.mona.onStudioEvent((event) => {
      if (event.projectId !== projectId) return;
      if (event.type === 'item') {
        setStudio((current) => (current ? { ...current, items: applyItem(current.items, event.item) } : current));
        if (event.item.kind === 'user') {
          setPendingPrompt((pending) => (pending && event.item.body.includes(pending) ? null : pending));
        }
        return;
      }
      if (event.type === 'delta') {
        const seen = lastDelta.current.get(event.itemId) ?? 0;
        if (event.seq <= seen) return;
        lastDelta.current.set(event.itemId, event.seq);
        setStudio((current) => {
          if (!current) return current;
          const existing = current.items.find((item) => item.id === event.itemId);
          if (!existing) return current;
          return {
            ...current,
            items: applyItem(current.items, {
              ...existing,
              body: `${existing.body}${event.text}`,
              status: 'streaming',
            }),
          };
        });
        return;
      }
      if (event.type === 'diagnostic') {
        setStudio((current) =>
          current ? { ...current, diagnostics: [...current.diagnostics.slice(-199), event.line] } : current,
        );
        return;
      }
      setStudio((current) =>
        current
          ? { ...current, run: event.run, control: event.control, pending: event.pending, thread: event.thread }
          : current,
      );
    });
    return unsubscribe;
  }, [applyItem, projectId]);

  // Refresh the recorded spend once a turn settles.
  const previousState = useRef<StudioRun['state'] | null>(null);
  const runState = studio?.run.state ?? null;
  useEffect(() => {
    if (previousState.current && previousState.current !== 'idle' && runState === 'idle') {
      onSpendRefresh();
    }
    previousState.current = runState;
  }, [onSpendRefresh, runState]);

  const connectedHere = engine?.state === 'connected' && project?.canonicalPath === engine.workspace;
  const run = studio?.run ?? null;
  const running = run !== null && ['preparing', 'running', 'interrupting', 'awaiting_approval'].includes(run.state);
  const paused = studio?.control.pauseRequested ?? false;
  const blockedReason = !project
    ? 'Choose a project first.'
    : !project.folderExists
      ? 'The project folder is missing. Locate it first.'
      : !info?.localState.available
        ? 'Local state is unavailable, so nothing can be recorded.'
        : engine?.state !== 'connected'
          ? 'The engine is not connected. Connect it for this project.'
          : !connectedHere
            ? 'The runtime is serving another workspace. Stop it before submitting here.'
            : running
              ? 'A turn is already running. Interrupt it or wait for it to finish.'
              : paused
                ? 'The queue is paused after the last task. Resume to send work.'
                : submitting
                  ? 'Sending the prompt to the runtime.'
                  : !draft.trim()
                    ? 'Write a prompt before submitting.'
                    : null;
  const canSubmit = blockedReason === null;

  const submit = useCallback(async () => {
    if (!projectId || !sessionId || !canSubmit) return;
    setSubmitting(true);
    setActionError(null);
    const text = draft;
    setPendingPrompt(text);
    const result = await window.mona.studioSubmit({ projectId, sessionId, text, mode, references });
    setSubmitting(false);
    if (!result.ok) {
      setPendingPrompt(null);
      setActionError(result.error.message);
      return;
    }
    props.onDraftSent();
    setReferences([]);
    setNotice(null);
  }, [canSubmit, draft, mode, projectId, props, references, sessionId]);

  const interrupt = useCallback(async () => {
    if (!projectId) return;
    const result = await window.mona.studioInterrupt({ projectId });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setStudio((current) => (current ? { ...current, run: result.data.run, control: result.data.control } : current));
  }, [projectId]);

  const pause = useCallback(async () => {
    if (!projectId) return;
    const result = await window.mona.studioPause({ projectId });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setStudio((current) => (current ? { ...current, run: result.data.run, control: result.data.control } : current));
  }, [projectId]);

  const resume = useCallback(async () => {
    if (!projectId) return;
    const result = await window.mona.studioResume({ projectId });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setStudio((current) => (current ? { ...current, run: result.data.run, control: result.data.control } : current));
  }, [projectId]);

  const pickReferences = useCallback(async () => {
    if (!projectId) return;
    const result = await unwrap(window.mona.studioPickReferences({ projectId }), 'Could not add file references');
    if (!result) return;
    setReferences((current) => [...new Set([...current, ...result.paths])]);
  }, [projectId, unwrap]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied to the clipboard.');
    } catch {
      setNotice('The clipboard is unavailable in this window.');
    }
  }, []);

  const items = studio?.items ?? [];
  // The newest page of rows is rendered; older loaded items stay in state and one
  // click away, so nothing recorded becomes unreachable.
  const renderLimit = TIMELINE_RENDER_PAGE * renderPage;
  const hiddenCount = Math.max(0, items.length - renderLimit);
  const visibleItems = hiddenCount > 0 ? items.slice(items.length - renderLimit) : items;
  const pending = studio?.pending ?? null;
  const blockedProblem = studio?.control.blockedProblem ?? null;
  const thread = studio?.thread ?? null;

  const permissionLabel = thread
    ? `${POSTURE_LABEL[thread.permissionPosture] ?? thread.permissionPosture}${thread.autoApprove ? ' · auto-approve' : ''}`
    : info
      ? `${info.permission.label} (saved)`
      : 'Permission unknown';
  const permissionDetail = thread
    ? 'Observed from the runtime thread. Changing it needs an explicit engine profile; Mona never widens it silently.'
    : info
      ? 'Saved in Mona’s local state; the engine applies it when a thread is created. A connected thread replaces this with the observed posture.'
      : 'No permission information is available.';

  const diagnosticsText = useMemo(() => (studio?.diagnostics ?? []).join('\n'), [studio?.diagnostics]);

  if (!project) {
    return (
      <section className="panel" aria-labelledby="studio-empty">
        <p className="eyebrow">Studio</p>
        <h2 id="studio-empty">Choose a folder to begin</h2>
        <p className="lede">
          The studio shows a project’s conversation, connection, and drafts. Mona does not start a runtime or invent a
          task just to fill this screen.
        </p>
        <EmptyState
          title="No project open"
          body="Open an existing folder or create a new one from Home."
          action={
            <Button variant="primary" onClick={props.onOpenFolder}>
              Open folder…
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section className="panel studio-panel" aria-labelledby="studio-title">
      <div className="studio-head">
        <div className="studio-title-row">
          {props.identity ? (
            <span
              className="project-mark"
              style={{ background: props.identity.color }}
              aria-hidden="true"
              data-testid="studio-identity"
            >
              {props.identity.monogram}
            </span>
          ) : null}
          <div>
            <p className="eyebrow">Studio</p>
            <h2 id="studio-title" data-testid="studio-title" title={project.canonicalPath}>
              {project.label}
            </h2>
          </div>
        </div>
        <div className="badge-row">
          <Badge tone={project.branch ? 'success' : 'neutral'}>{project.branch ?? 'No branch'}</Badge>
          <Badge>{repoLabel(project)}</Badge>
          <Badge tone={connectionTone(engine, project)}>
            {engine ? ENGINE_STATUS_LABEL[engine.state] : 'Engine unknown'}
          </Badge>
          <Badge tone="neutral">
            Spend · <span data-testid="studio-spend">{formatSpend(spend)}</span>
          </Badge>
        </div>
      </div>

      {!project.folderExists ? (
        <ErrorState
          title="Project folder is missing"
          detail="The catalog entry is intact, but the folder is not at the recorded path. Locate it to rebind deliberately; nothing is deleted."
          action={<Button onClick={props.onLocate}>Locate folder…</Button>}
        />
      ) : null}

      {info && !info.localState.available ? (
        <ErrorState
          title="Local state unavailable"
          detail={`${info.localState.detail} The catalog and drafts cannot be trusted until this opens. See Diagnostics.`}
        />
      ) : null}

      {loadError ? <ErrorState title="Studio unavailable" detail={loadError} /> : null}
      {actionError ? (
        <Notification tone="critical" title="That action did not complete">
          {actionError}
        </Notification>
      ) : null}
      {notice ? (
        <div className="mona-row">
          <Notification tone="neutral" title="Note">
            {notice}
          </Notification>
          <Button size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {studio?.warning ? (
        <Notification tone="attention" title="Studio warning">
          {studio.warning}
        </Notification>
      ) : null}

      {engine?.state === 'connected' && !connectedHere ? (
        <Notification tone="attention" title="Runtime serves another project">
          {engine.workspace ?? 'Another workspace'} is live. Stop it before starting this project; Mona owns one runtime
          at a time.
        </Notification>
      ) : null}

      {/* --- execution control strip: never hidden behind the transcript --- */}
      <div className="control-strip" role="region" aria-label="Execution controls">
        <div className="control-run">
          <span className="dot" aria-hidden="true" data-state={run?.state ?? 'idle'} />
          <div>
            <strong data-testid="studio-run-state">{run ? RUN_LABEL[run.state] : 'Ready'}</strong>
            <p className="mona-muted" data-testid="studio-run-detail" aria-live="polite">
              {run?.detail ?? 'Nothing has been sent for this session.'}
            </p>
          </div>
        </div>
        <div className="control-mode" role="group" aria-label="Engine mode">
          {(['plan', 'agent'] as StudioMode[]).map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? 'mode-button active' : 'mode-button'}
              aria-pressed={mode === value}
              data-testid={`mode-${value}`}
              onClick={() => setMode(value)}
              disabled={running}
              title={
                value === 'plan'
                  ? 'Plan mode: the engine plans without writing changes'
                  : 'Work mode: the engine may use tools and change files'
              }
            >
              {value === 'plan' ? 'Plan' : 'Work'}
            </button>
          ))}
        </div>
        <div className="control-facts">
          <span className="fact-label">Permission</span>
          <span className="fact-value" data-testid="studio-permission" title={permissionDetail}>
            {permissionLabel}
          </span>
          {thread ? (
            <span className="mona-muted" data-testid="studio-model">
              {thread.provider} · {thread.model}
            </span>
          ) : null}
        </div>
        <div className="control-actions">
          {paused ? (
            <Button size="sm" onClick={() => void resume()} disabled={busy !== null}>
              Resume queue
            </Button>
          ) : (
            <Button size="sm" onClick={() => void pause()} disabled={busy !== null}>
              Pause after task
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={() => void interrupt()}
            disabled={!running}
            title="Ask the runtime to interrupt the active turn. Sent work is not rolled back."
          >
            Interrupt now
          </Button>
          {engine?.state === 'connected' ? (
            <Button size="sm" onClick={props.onStop} disabled={busy !== null}>
              Stop engine
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={props.onStart}
              disabled={busy !== null || !project.folderExists}
            >
              Connect engine
            </Button>
          )}
        </div>
      </div>

      {blockedProblem ? (
        <div className="pending-card" role="alert" data-testid="studio-blocked-problem">
          <div className="mona-row">
            <Badge tone="critical">Blocked</Badge>
            <span className="mona-mono">{blockedProblem.problemId}</span>
          </div>
          <p>{blockedProblem.detail}</p>
          <p className="mona-muted">
            Three attempts made no material progress, so Mona stops this problem. New work is refused until the problem
            is reopened with new evidence or a Victor decision; acknowledging this card does not reset the count.
          </p>
          <div className="mona-row">
            <Button size="sm" onClick={() => setShowDiagnostics(true)}>
              Show diagnostics
            </Button>
          </div>
        </div>
      ) : null}

      {paused ? (
        <p className="mona-muted" data-testid="queue-paused">
          The queue is paused after the last task. Resume to send new work.
        </p>
      ) : null}

      {pending ? (
        <div className="pending-card" role="alert" data-testid="studio-pending">
          <div className="mona-row">
            <Badge tone="attention">{pending.kind === 'input' ? 'Input needed' : 'Approval needed'}</Badge>
            <span className="mona-mono">{pending.toolName}</span>
          </div>
          <p>{pending.description}</p>
          <p className="mona-muted">
            {studio?.capabilities.approvalResponse.reason ??
              'Mona cannot answer this wait in this build. Interrupt now to stop it.'}
          </p>
          <div className="mona-row">
            <Button size="sm" variant="danger" onClick={() => void interrupt()}>
              Interrupt now
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setShowDiagnostics(true);
              }}
            >
              Show diagnostics
            </Button>
          </div>
        </div>
      ) : null}

      <div
        className="timeline"
        ref={timelineRef}
        tabIndex={0}
        role="log"
        aria-label="Turn timeline"
        aria-live="polite"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            composerRef.current?.focus();
          }
        }}
      >
        {items.length === 0 && !pendingPrompt ? (
          <EmptyState
            title={thread ? 'No events for this thread yet' : 'Nothing sent for this session'}
            body={
              thread
                ? 'The runtime has not reported an event for this thread. The timeline only shows what the runtime actually sends.'
                : 'Write a prompt and submit it once. The timeline fills from the runtime’s own events.'
            }
          />
        ) : null}
        {hiddenCount > 0 ? (
          <div className="timeline-earlier" data-testid="timeline-earlier">
            <Button size="sm" onClick={() => setRenderPage((value) => value + 1)}>
              Show {Math.min(hiddenCount, TIMELINE_RENDER_PAGE)} earlier item(s)
            </Button>
            <span className="mona-muted">
              Showing the newest {visibleItems.length} of {items.length} loaded items. Older items are recorded and one
              click away.
            </span>
          </div>
        ) : null}
        {visibleItems.map((item) => (
          <TimelineEntry
            key={item.id}
            item={item}
            expanded={expanded.has(item.id)}
            onExpand={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              })
            }
            onCopy={(text) => void copy(text)}
            onInterrupt={() => void interrupt()}
          />
        ))}
        {pendingPrompt ? (
          <article className="timeline-item kind-user pending" aria-label="Prompt being sent">
            <div className="timeline-head">
              <Badge tone="info">You</Badge>
              <span className="mona-muted">Sending…</span>
            </div>
            <p className="timeline-plain">{pendingPrompt}</p>
            <p className="mona-muted">Mona is waiting for the runtime to acknowledge this prompt.</p>
          </article>
        ) : null}
      </div>

      <div className="composer">
        <div className="composer-head">
          <label className="mona-field-label" htmlFor="draft">
            Prompt for {project.label}
          </label>
          <div className="mona-row">
            <span className="mona-muted" data-testid="session-id">
              Session {sessionId ? sessionId.slice(0, 12) : 'pending'}
            </span>
            <Button size="sm" onClick={props.onNewSession}>
              New session
            </Button>
            {props.onExport ? (
              <Button
                size="sm"
                onClick={() => {
                  setNotice(null);
                  void props.onExport?.().then((message) => setNotice(message));
                }}
                disabled={!sessionId || items.length === 0}
                title={
                  items.length === 0
                    ? 'This session has no recorded events to export.'
                    : 'Write the recorded conversation to a Markdown file. No model is called.'
                }
              >
                Export
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              onClick={() => void submit()}
              title={blockedReason ?? 'Send this prompt to the runtime once.'}
            >
              Submit
            </Button>
          </div>
        </div>
        <textarea
          id="draft"
          ref={composerRef}
          className="mona-input composer-input"
          value={draft}
          placeholder="Describe the task. Submitting sends this prompt to the configured provider."
          onChange={(event) => props.onDraft(event.target.value)}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {references.length > 0 ? (
          <ul className="chip-row" aria-label="File references">
            {references.map((reference) => (
              <li key={reference} className="chip">
                <span className="mona-mono">{reference}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove reference ${reference}`}
                  onClick={() => setReferences((current) => current.filter((item) => item !== reference))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="composer-foot">
          <div className="mona-row">
            <Button size="sm" onClick={() => void pickReferences()} disabled={!project.folderExists}>
              Reference files…
            </Button>
            <Button
              size="sm"
              disabled
              title={
                studio?.capabilities.attachments.reason ??
                'Attachments are not available until a runtime supports them.'
              }
            >
              Attach file (unsupported)
            </Button>
            <span className="mona-muted">
              {session?.text ? 'Draft saved locally' : 'No saved draft text'} · Ctrl+Enter sends
            </span>
          </div>
        </div>
        <details className="prompt-shelf">
          <summary>Prompt shelf · {props.favorites?.length ?? 0} saved</summary>
          <p className="mona-muted">
            A favorite fills the composer exactly as written. It is a draft until you press Submit; nothing is sent by
            using one. Prompts with variables are previewed and filled in the Memory section.
          </p>
          <div className="mona-row">
            <label className="mona-field-label" htmlFor="favorite-label">
              Label
            </label>
            <input
              id="favorite-label"
              className="mona-input"
              value={favoriteLabel}
              maxLength={120}
              placeholder="e.g. Review the failing test"
              onChange={(event) => setFavoriteLabel(event.target.value)}
            />
            <Button
              size="sm"
              disabled={!draft.trim() || !favoriteLabel.trim() || !props.onSaveFavorite}
              onClick={() => {
                if (!props.onSaveFavorite || !favoriteLabel.trim() || !draft.trim()) return;
                props.onSaveFavorite(favoriteLabel.trim(), draft);
                setFavoriteLabel('');
              }}
              data-testid="save-favorite"
            >
              Save current draft
            </Button>
          </div>
          {props.favorites && props.favorites.length > 0 ? (
            <ul className="brief-list" aria-label="Saved prompts">
              {props.favorites.map((favorite) => (
                <li key={favorite.id} className="favorite-row">
                  <div>
                    <strong>{favorite.label}</strong>
                    <p className="mona-muted mona-truncate" title={favorite.template}>
                      {favorite.template}
                    </p>
                    <p className="mona-muted">
                      v{favorite.version}
                      {favorite.variables.length > 0
                        ? ` · ${favorite.variables.length} variable(s) — fill in Memory`
                        : ''}
                      {favorite.acceptance.length > 0 ? ` · ${favorite.acceptance.length} check(s)` : ''}
                    </p>
                  </div>
                  <div className="mona-row">
                    <Button
                      size="sm"
                      disabled={favorite.variables.length > 0}
                      title={
                        favorite.variables.length > 0
                          ? 'This prompt has variables; preview and fill it in the Memory section.'
                          : 'Insert this prompt into the composer'
                      }
                      onClick={() => {
                        props.onDraft(favorite.template);
                        composerRef.current?.focus();
                      }}
                    >
                      Use
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Remove ${favorite.label}`}
                      onClick={() => props.onRemoveFavorite?.(favorite.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mona-muted">No saved prompts for this project yet.</p>
          )}
        </details>
        <p className="mona-muted">
          {blockedReason ??
            `Mona sends this prompt once to ${thread ? `${thread.provider} · ${thread.model}` : 'the configured route'}. A draft is not a task.`}
        </p>
      </div>

      <details
        className="studio-diagnostics"
        open={showDiagnostics}
        onToggle={(event) => setShowDiagnostics((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Diagnostics · raw runtime events ({studio?.diagnostics.length ?? 0})</summary>
        <p className="mona-muted">
          Raw lifecycle lines, separate from the explanations above. Credentials are never recorded here.
        </p>
        <pre className="diagnostics-log">{diagnosticsText || 'No runtime events recorded for this session.'}</pre>
        <p className="mona-muted" data-testid="connection-detail">
          Engine: {engine?.detail ?? 'No engine state has been reported.'}
        </p>
        <p className="mona-muted">Credentials: {info?.credentials.detail ?? 'Status unknown.'}</p>
        {thread ? (
          <p className="mona-muted mona-mono">
            thread {thread.threadId} · observed {timeLabel(thread.observedAt)} · allowShell{' '}
            {thread.allowShell ? 'on' : 'off'} · trustMode {thread.trustMode ? 'on' : 'off'} · autoApprove{' '}
            {thread.autoApprove ? 'on' : 'off'}
          </p>
        ) : null}
      </details>
    </section>
  );
}

function TimelineEntry({
  item,
  expanded,
  onExpand,
  onCopy,
  onInterrupt,
}: {
  item: TimelineItem;
  expanded: boolean;
  onExpand: () => void;
  onCopy: (text: string) => void;
  onInterrupt: () => void;
}): React.JSX.Element {
  const long = item.body.length > (item.kind === 'tool' ? TOOL_PREVIEW_CHARS : PREVIEW_CHARS);
  const limit = item.kind === 'tool' ? TOOL_PREVIEW_CHARS : PREVIEW_CHARS;
  const shown = long && !expanded ? item.body.slice(0, limit) : item.body;
  const tone = KIND_TONE[item.kind];
  return (
    <article className={`timeline-item kind-${item.kind}`} data-testid={`timeline-${item.kind}`}>
      <div className="timeline-head">
        <Badge tone={tone}>{KIND_LABEL[item.kind]}</Badge>
        <span className="timeline-title">{item.title}</span>
        <span className="mona-muted timeline-meta">
          {timeLabel(item.at)} · #{item.seq}
          {item.status ? ` · ${item.status}` : ''}
        </span>
      </div>
      {item.kind === 'assistant' ? (
        <div className="timeline-body">
          <Markdown text={shown} emptyLabel="The assistant produced no text." />
        </div>
      ) : item.kind === 'tool' || item.kind === 'outcome' || item.kind === 'error' ? (
        <pre className="timeline-code">{shown}</pre>
      ) : (
        <p className="timeline-plain">{shown}</p>
      )}
      {long && !item.truncated ? (
        <Button size="sm" onClick={onExpand}>
          {expanded ? 'Show less' : `Show all ${item.body.length.toLocaleString()} characters`}
        </Button>
      ) : null}
      {item.truncated ? (
        <p className="mona-muted" data-testid="truncated-note">
          This item exceeded the stored limit and is labeled truncated. The full output stays in the runtime’s own log.
        </p>
      ) : null}
      <div className="timeline-actions">
        {item.kind === 'approval' ? (
          <Button size="sm" variant="danger" onClick={onInterrupt}>
            Interrupt now
          </Button>
        ) : null}
        {item.body ? (
          <Button size="sm" onClick={() => onCopy(item.body)}>
            Copy
          </Button>
        ) : null}
      </div>
    </article>
  );
}
