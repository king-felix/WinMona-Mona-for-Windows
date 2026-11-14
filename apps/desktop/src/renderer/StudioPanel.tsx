import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, Markdown, Notification, type Tone } from '@mona/ui';
import { ENGINE_STATUS_LABEL } from '../shared/engine-status.js';
import type { CatalogProject, EngineView, ProjectSpend, PromptFavorite, UiStateView } from '../shared/catalog.js';
import type { AppInfo } from '../shared/ipc.js';
import type {
  StudioEvent,
  StudioHistoryWindow,
  StudioMode,
  StudioRun,
  StudioSearchResult,
  StudioView as StudioState,
  TimelineItem,
  TimelineKind,
} from '../shared/studio.js';

const PREVIEW_CHARS = 2_000;
const TOOL_PREVIEW_CHARS = 1_500;
/**
 * Rows rendered at once. The shell still loads the newest 500 items into state;
 * this only bounds what exists in the DOM, because rendered rows — not stored
 * text — are what costs memory. Measured: removing 400 of 500 rendered rows from
 * the live DOM released ~23 MB of working set (P23-memory-dev.json).
 */
const TIMELINE_RENDER_PAGE = 120;
/**
 * Rows held in renderer state. History is paged from the store, so this bounds
 * memory without capping what is reachable: the window is a view over a thread
 * that may hold tens of thousands of rows.
 */
const LOADED_ITEM_LIMIT = 2_000;
const HISTORY_PAGE = 500;
const FINAL_STATUSES = new Set(['completed', 'interrupted', 'failed', 'cancelled']);

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

/** Union two item lists by id (newest value wins), ordered by sequence. */
function mergeTimeline(base: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of base) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Keeps renderer state bounded. The dropped end is the one opposite the change:
 * loading older rows drops the newest tail, and live rows drop the oldest head.
 */
function boundTimeline(items: TimelineItem[], keep: 'oldest' | 'newest'): TimelineItem[] {
  if (items.length <= LOADED_ITEM_LIMIT) return items;
  return keep === 'oldest' ? items.slice(0, LOADED_ITEM_LIMIT) : items.slice(items.length - LOADED_ITEM_LIMIT);
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
  /** Called after a prompt is accepted, with the exact text that was accepted. */
  onDraftSent: (sent: { projectId: string; sessionId: string; text: string }) => void;
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
  // State updates are asynchronous; a same-tick second press would still see
  // `submitting === false`. This ref is the renderer's single-flight latch.
  const submittingRef = useRef(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [renderPage, setRenderPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [favoriteLabel, setFavoriteLabel] = useState('');
  const [history, setHistory] = useState<StudioHistoryWindow | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StudioSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastDelta = useRef<Map<string, number>>(new Map());
  /**
   * Follow-scroll is per conversation and per reader: it is on until the reader
   * scrolls away from the newest row. It is not persisted, and it never pulls a
   * reader back while they are reading older history.
   */
  const followScroll = useRef(true);
  /** Set while older rows are being prepended: the reader's place is the anchor. */
  const prependInFlight = useRef(false);
  const threadIdRef = useRef<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectId = project?.id ?? null;
  const session = projectId ? ui?.projects[projectId]?.sessions.find((item) => item.sessionId === sessionId) : null;

  // A new session, project, or mode is a different conversation: paging,
  // search, unread and follow-scroll all start over.
  useEffect(() => {
    setRenderPage(1);
    setSearchResults(null);
    setSearchQuery('');
    setUnread(0);
    setHighlightSeq(null);
    lastDelta.current.clear();
    followScroll.current = true;
  }, [projectId, sessionId, mode]);

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

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
      setHistory(null);
      return;
    }
    let alive = true;
    void (async () => {
      const result = await window.mona.studioGet({ projectId, sessionId, mode });
      if (!alive) return;
      if (result.ok) {
        threadIdRef.current = result.data.thread?.threadId ?? null;
        setStudio(result.data);
        setHistory(result.data.history ?? null);
        setLoadError(null);
        setHistoryError(null);
        // A fresh load starts at the newest row, so following is safe again.
        followScroll.current = true;
        setUnread(0);
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
    const fromThisThread = (threadId: string | null): boolean =>
      threadIdRef.current === null || threadId === threadIdRef.current;
    const unsubscribe = window.mona.onStudioEvent((event: StudioEvent) => {
      if (event.projectId !== projectId) return;
      if (event.type === 'item') {
        // A mode switch keeps one runtime alive for both threads; a row from the
        // other thread must never appear in this conversation.
        if (!fromThisThread(event.threadId)) return;
        setStudio((current) => (current ? { ...current, items: applyItem(current.items, event.item) } : current));
        if (event.item.kind === 'user') {
          setPendingPrompt((pending) => (pending && event.item.body.includes(pending) ? null : pending));
        }
        return;
      }
      if (event.type === 'delta') {
        if (!fromThisThread(event.threadId)) return;
        const seen = lastDelta.current.get(event.itemId) ?? 0;
        if (event.seq <= seen) return;
        lastDelta.current.set(event.itemId, event.seq);
        setStudio((current) => {
          if (!current) return current;
          const existing = current.items.find((item) => item.id === event.itemId);
          if (!existing) return current;
          // A finished card is final even if a late frame arrives.
          if (FINAL_STATUSES.has(existing.status ?? '')) return current;
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
      if (!fromThisThread(event.threadId)) return;
      setStudio((current) =>
        current
          ? { ...current, run: event.run, control: event.control, pending: event.pending, thread: event.thread }
          : current,
      );
    });
    return unsubscribe;
  }, [applyItem, projectId]);

  // Follow only while the reader is at the newest row. Otherwise the new text is
  // counted as unread and a deliberate control brings them back.
  const itemCount = studio?.items.length ?? 0;
  const newestBodyLength = studio?.items[studio.items.length - 1]?.body.length ?? 0;
  const lastItemCount = useRef(0);
  useEffect(() => {
    const node = timelineRef.current;
    const added = Math.max(0, itemCount - lastItemCount.current);
    lastItemCount.current = itemCount;
    if (!node) return;
    if (prependInFlight.current) {
      // Prepending older rows is not new activity at the bottom; the anchor
      // restore in loadEarlier keeps the reader where they were reading.
      prependInFlight.current = false;
      return;
    }
    if (followScroll.current) {
      node.scrollTop = node.scrollHeight;
      setUnread(0);
    } else if (added > 0) {
      setUnread((count) => count + added);
    }
  }, [itemCount, newestBodyLength]);

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
    if (!projectId || !sessionId || !canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setActionError(null);
    const sent = { projectId, sessionId, text: draft };
    setPendingPrompt(sent.text);
    try {
      const result = await window.mona.studioSubmit({
        projectId,
        sessionId,
        text: sent.text,
        mode,
        references,
      });
      if (!result.ok) {
        setPendingPrompt(null);
        setActionError(result.error.message);
        return;
      }
      props.onDraftSent(sent);
      setReferences((current) =>
        current.length === references.length && current.every((item, index) => item === references[index])
          ? []
          : current,
      );
      setNotice(null);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
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

  /**
   * One page back through stored history. The reader's position is preserved by
   * measuring the scroll box before and after the prepend, and the newest tail
   * is released if the window would grow past its bound.
   */
  const loadEarlier = useCallback(async () => {
    if (!projectId || !sessionId || loadingOlder) return;
    const oldest = history?.oldestSeq ?? null;
    if (oldest === null || !history?.hasOlder) return;
    const node = timelineRef.current;
    const anchor = node ? { height: node.scrollHeight, top: node.scrollTop } : null;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const result = await window.mona.studioHistory({
        projectId,
        sessionId,
        mode,
        beforeSeq: oldest,
        limit: HISTORY_PAGE,
      });
      if (!result.ok) {
        setHistoryError(result.error.message);
        return;
      }
      const page = result.data;
      prependInFlight.current = true;
      setStudio((current) => {
        if (!current) return current;
        const merged = mergeTimeline(current.items, page.items);
        const bounded = boundTimeline(merged, 'oldest');
        return { ...current, items: bounded };
      });
      // If the bound released newest rows, they are still stored and reachable
      // with Jump to newest; say so instead of pretending the window is whole.
      const trimmed = (studio?.items.length ?? 0) + page.items.length > LOADED_ITEM_LIMIT;
      setHistory({ ...page.window, hasNewer: page.window.hasNewer || trimmed });
      requestAnimationFrame(() => {
        const target = timelineRef.current;
        if (target && anchor) target.scrollTop = anchor.top + (target.scrollHeight - anchor.height);
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [history, loadingOlder, mode, projectId, sessionId, studio?.items.length]);

  /** Reload the newest stored window; nothing is inferred and no model is called. */
  const jumpToNewest = useCallback(async () => {
    if (!projectId || !sessionId) return;
    setHistoryError(null);
    const result = await window.mona.studioGet({ projectId, sessionId, mode });
    if (!result.ok) {
      setHistoryError(result.error.message);
      return;
    }
    threadIdRef.current = result.data.thread?.threadId ?? null;
    setStudio(result.data);
    setHistory(result.data.history ?? null);
    setRenderPage(1);
    followScroll.current = true;
    setUnread(0);
    requestAnimationFrame(() => {
      const node = timelineRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, [mode, projectId, sessionId]);

  const runSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!projectId || !sessionId || !query) return;
    setSearching(true);
    try {
      const result = await window.mona.studioSearchHistory({ projectId, sessionId, mode, query });
      if (!result.ok) {
        setHistoryError(result.error.message);
        return;
      }
      setSearchResults(result.data);
    } finally {
      setSearching(false);
    }
  }, [mode, projectId, searchQuery, sessionId]);

  /** Load the stored window around a search hit and bring that row into view. */
  const jumpToSeq = useCallback(
    async (seq: number) => {
      if (!projectId || !sessionId) return;
      setHistoryError(null);
      const result = await window.mona.studioHistory({
        projectId,
        sessionId,
        mode,
        aroundSeq: seq,
        limit: HISTORY_PAGE,
      });
      if (!result.ok) {
        setHistoryError(result.error.message);
        return;
      }
      setStudio((current) => (current ? { ...current, items: result.data.items } : current));
      setHistory(result.data.window);
      setRenderPage(1);
      followScroll.current = false;
      setHighlightSeq(seq);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightSeq(null), 4_000);
      requestAnimationFrame(() => {
        const node = timelineRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
        node?.scrollIntoView({ block: 'center' });
        node?.focus?.();
      });
    },
    [mode, projectId, sessionId],
  );

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
  // Only a page of rows is rendered at once. Older *loaded* rows are one click
  // away, and rows outside the loaded window are one request away, so nothing
  // stored becomes unreachable while the DOM and state stay bounded.
  const renderLimit = TIMELINE_RENDER_PAGE * renderPage;
  const hiddenCount = Math.max(0, items.length - renderLimit);
  const visibleItems = hiddenCount > 0 ? items.slice(items.length - renderLimit) : items;
  const hasOlder = history?.hasOlder ?? false;
  const totalStored = history?.total ?? items.length;
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

      <div className="timeline-tools">
        <div className="mona-row">
          <label className="mona-field-label" htmlFor="timeline-search">
            Search this conversation
          </label>
          <input
            id="timeline-search"
            className="mona-input"
            value={searchQuery}
            maxLength={200}
            placeholder="Text recorded in this thread"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void runSearch();
            }}
          />
          <Button
            size="sm"
            onClick={() => void runSearch()}
            disabled={searching || !searchQuery.trim()}
            data-testid="history-search"
          >
            {searching ? 'Searching…' : 'Search'}
          </Button>
          <span className="mona-muted" data-testid="history-window">
            {totalStored.toLocaleString()} stored · {items.length.toLocaleString()} loaded
          </span>
        </div>
        {searchResults ? (
          <div className="mona-muted" data-testid="history-results">
            {searchResults.total === 0 ? (
              <p>
                No stored item in this thread contains “{searchResults.query}”. Nothing is searched on a remote service.
              </p>
            ) : (
              <>
                <p>
                  {searchResults.total.toLocaleString()} stored match(es) for “{searchResults.query}”. Opening one loads
                  the stored rows around it; it does not run anything.
                </p>
                <ul className="brief-list">
                  {searchResults.items.map((hit) => (
                    <li key={hit.id}>
                      <Button size="sm" onClick={() => void jumpToSeq(hit.seq)} data-testid={`history-hit-${hit.seq}`}>
                        #{hit.seq} · {KIND_LABEL[hit.kind]} · {hit.title}
                      </Button>
                      <p className="mona-muted mona-truncate">{hit.body.slice(0, 160)}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Button size="sm" onClick={() => setSearchResults(null)}>
              Clear results
            </Button>
          </div>
        ) : null}
        {historyError ? (
          <Notification tone="critical" title="History could not be read">
            {historyError}
          </Notification>
        ) : null}
      </div>
      <div
        className="timeline"
        ref={timelineRef}
        tabIndex={0}
        role="log"
        aria-label="Turn timeline"
        aria-live="polite"
        onScroll={() => {
          const node = timelineRef.current;
          if (!node) return;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          followScroll.current = atBottom;
          if (atBottom) setUnread(0);
        }}
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
        {hasOlder ? (
          <div className="timeline-earlier" data-testid="timeline-older">
            <Button size="sm" onClick={() => void loadEarlier()} disabled={loadingOlder}>
              {loadingOlder ? 'Loading earlier items…' : 'Load earlier stored items'}
            </Button>
            <span className="mona-muted">Older rows are stored locally. Loading them makes no model call.</span>
          </div>
        ) : items.length > 0 ? (
          <p className="mona-muted" data-testid="timeline-beginning">
            Beginning of the stored conversation.
          </p>
        ) : null}
        {hiddenCount > 0 ? (
          <div className="timeline-earlier" data-testid="timeline-earlier">
            <Button size="sm" onClick={() => setRenderPage((value) => value + 1)}>
              Show {Math.min(hiddenCount, TIMELINE_RENDER_PAGE)} earlier loaded item(s)
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
            highlighted={highlightSeq === item.seq}
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
      {unread > 0 || (history?.hasNewer ?? false) ? (
        <div className="mona-row" data-testid="timeline-jump">
          <Button size="sm" variant="primary" onClick={() => void jumpToNewest()}>
            Jump to newest
          </Button>
          <span className="mona-muted">
            {unread > 0
              ? `${unread} new event(s) arrived while you were reading. The view did not move.`
              : 'Newer stored rows are outside the loaded window.'}
          </span>
        </div>
      ) : null}

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
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
            // An IME composition owns Enter: sending here would submit a
            // half-composed prompt. keyCode 229 covers older Windows IME paths
            // that never set isComposing.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            // Holding the shortcut is one intention, not several.
            if (event.repeat) return;
            void submit();
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
  highlighted,
  onExpand,
  onCopy,
  onInterrupt,
}: {
  item: TimelineItem;
  expanded: boolean;
  highlighted?: boolean;
  onExpand: () => void;
  onCopy: (text: string) => void;
  onInterrupt: () => void;
}): React.JSX.Element {
  const long = item.body.length > (item.kind === 'tool' ? TOOL_PREVIEW_CHARS : PREVIEW_CHARS);
  const limit = item.kind === 'tool' ? TOOL_PREVIEW_CHARS : PREVIEW_CHARS;
  const shown = long && !expanded ? item.body.slice(0, limit) : item.body;
  const tone = KIND_TONE[item.kind];
  return (
    <article
      className={`timeline-item kind-${item.kind}${highlighted ? ' highlighted' : ''}`}
      data-testid={`timeline-${item.kind}`}
      data-seq={item.seq}
      tabIndex={highlighted ? -1 : undefined}
    >
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
