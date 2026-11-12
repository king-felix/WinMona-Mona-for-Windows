import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  CommandPalette,
  Dialog,
  EmptyState,
  Harness,
  HarnessScreen,
  Notification,
  Skeleton,
  type HarnessScreenId,
  type PaletteItem,
  type Tone,
} from '@mona/ui';
import { ENGINE_STATUS_LABEL } from '../shared/engine-status.js';
import { StudioPanel } from './StudioPanel.js';
import { BriefingPanel } from './BriefingPanel.js';
import { projectIdentity, PROJECT_COLORS } from '../shared/identity.js';
import type { AttentionFocus, AttentionView, Density } from '../shared/attention.js';
import type { BriefingView } from '../shared/briefing.js';
import type {
  CatalogProject,
  EngineView,
  IpcResult,
  ProjectSpend,
  ProjectView,
  UiStateView,
} from '../shared/catalog.js';
import type { AppInfo } from '../shared/ipc.js';
import type { LaunchReceipt } from '../shared/launch.js';

type Theme = 'daybreak' | 'afterglow';
type Notice = { tone: Tone; title: string; body: string };

const HARNESS_SCREENS: HarnessScreenId[] = ['home', 'studio', 'work', 'cost', 'blocker', 'settings', 'states'];

const NAV: Array<{ id: ProjectView; label: string; hint: string }> = [
  { id: 'home', label: 'Home', hint: 'Projects, recents, and what needs attention' },
  { id: 'studio', label: 'Studio', hint: 'Project conversation, drafts, and engine connection' },
  { id: 'work', label: 'Work', hint: 'Prompt board and queue' },
  { id: 'cost', label: 'Cost', hint: 'Recorded usage and spend' },
  { id: 'settings', label: 'Settings', hint: 'Route, permission, appearance, diagnostics' },
];

/** Query-driven visual harness route. The main process enables it for development only. */
function harnessRequest(): { screen: HarnessScreenId | 'all' } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('harness') === null) return null;
    const requested = params.get('screen') ?? 'all';
    return {
      screen: HARNESS_SCREENS.includes(requested as HarnessScreenId) ? (requested as HarnessScreenId) : 'all',
    };
  } catch {
    return null;
  }
}

function initialTheme(): Theme {
  try {
    const requested = new URLSearchParams(window.location.search).get('theme');
    if (requested === 'daybreak' || requested === 'afterglow') return requested;
    return localStorage.getItem('mona.theme') === 'afterglow' ? 'afterglow' : 'daybreak';
  } catch {
    return 'daybreak';
  }
}

function formatSpend(spend: ProjectSpend | null): { label: string; unknown: boolean } {
  if (!spend || spend.turnCount === 0) return { label: 'No recorded spend', unknown: false };
  if (spend.knownCostMicros <= 0)
    return { label: spend.unknownCostRecords > 0 ? 'Unknown' : 'No recorded spend', unknown: true };
  const dollars = `$${(spend.knownCostMicros / 1_000_000).toFixed(4)}`;
  if (spend.unknownCostRecords > 0) return { label: `${dollars} + unknown`, unknown: true };
  return { label: dollars, unknown: false };
}

function repoLabel(project: CatalogProject): string {
  if (project.repoKind === 'worktree') return 'Git worktree';
  if (project.repoKind === 'git') return 'Git repository';
  return 'No Git repository';
}

function draftFor(ui: UiStateView | null, projectId: string | null): { sessionId: string | null; text: string } {
  if (!ui || !projectId) return { sessionId: null, text: '' };
  const entry = ui.projects[projectId];
  if (!entry) return { sessionId: null, text: '' };
  const session = entry.sessions.find((item) => item.sessionId === entry.currentSessionId);
  return { sessionId: entry.currentSessionId, text: session?.text ?? '' };
}

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [projects, setProjects] = useState<CatalogProject[]>([]);
  const [ui, setUi] = useState<UiStateView | null>(null);
  const [selected, setSelected] = useState<CatalogProject | null>(null);
  const [engine, setEngine] = useState<EngineView | null>(null);
  const [spend, setSpend] = useState<ProjectSpend | null>(null);
  const [screen, setScreen] = useState<ProjectView>('home');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [relocation, setRelocation] = useState<{
    project: CatalogProject;
    observedPath: string;
    reason: string;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CatalogProject | null>(null);
  const [renameTarget, setRenameTarget] = useState<CatalogProject | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createParent, setCreateParent] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [briefing, setBriefing] = useState<BriefingView | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [attention, setAttention] = useState<AttentionView | null>(null);
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [identityTarget, setIdentityTarget] = useState<CatalogProject | null>(null);
  const [identityColor, setIdentityColor] = useState('#1F5F8B');
  const [identityMonogram, setIdentityMonogram] = useState('');
  const [quitOpen, setQuitOpen] = useState(false);
  const appliedLaunch = useRef(0);
  const liveSelection = useRef<{ projectId: string | null; sessionId: string | null; draft: string }>({
    projectId: null,
    sessionId: null,
    draft: '',
  });
  const savingDrafts = useRef<Map<string, string>>(new Map());
  const harness = harnessRequest();

  const unwrap = useCallback(async <T,>(promise: Promise<IpcResult<T>>, title = 'Action failed'): Promise<T | null> => {
    try {
      const result = await promise;
      if (result.ok) return result.data;
      setNotice({ tone: 'critical', title, body: result.error.message });
      return null;
    } catch {
      setNotice({ tone: 'critical', title, body: 'The application bridge did not respond.' });
      return null;
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    const result = await unwrap(window.mona.listProjects({ includeArchived: true }), 'Catalog unavailable');
    if (result) setProjects(result);
    return result;
  }, [unwrap]);

  const loadSpend = useCallback(
    async (projectId: string) => {
      const result = await unwrap(window.mona.projectSpend(projectId), 'Cost unavailable');
      setSpend(result);
    },
    [unwrap],
  );

  const loadUi = useCallback(async () => {
    const result = await unwrap(window.mona.getUiState(), 'Draft state unavailable');
    if (result) setUi(result);
    return result;
  }, [unwrap]);

  const loadBriefing = useCallback(async (projectId: string, markSeen = true) => {
    const result = await window.mona.briefingGet({ projectId, markSeen });
    if (result.ok) {
      setBriefing(result.data);
      setBriefingError(null);
    } else {
      setBriefing(null);
      setBriefingError(result.error.message);
    }
  }, []);

  const activateProject = useCallback(
    async (project: CatalogProject, persistDraftFor: { projectId: string; sessionId: string; text: string } | null) => {
      if (persistDraftFor && persistDraftFor.sessionId) {
        await window.mona.saveDraft(persistDraftFor);
      }
      const result = await unwrap(window.mona.selectProject(project.id), 'Could not open that project');
      if (!result) return;
      setSelected(result.project);
      setUi(result.ui);
      setEngine(result.engine);
      const entry = result.ui.projects[project.id];
      setScreen(entry?.view ?? 'studio');
      const next = draftFor(result.ui, project.id);
      setSessionId(next.sessionId);
      setDraftText(next.text);
      setSpend(null);
      setFocusedEvidence(null);
      void loadSpend(project.id);
      void loadBriefing(project.id);
    },
    [loadBriefing, loadSpend, unwrap],
  );

  // Initial load: app info, catalog, persisted UI state and the selected project.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const appInfo = await window.mona.getAppInfo();
        if (!alive) return;
        if (appInfo.ok) setInfo(appInfo.data);
        else setBridgeError(appInfo.error.message);

        const catalog = await window.mona.listProjects({ includeArchived: true });
        if (!alive) return;
        if (catalog.ok) setProjects(catalog.data);
        else setBridgeError(catalog.error.message);

        const state = await window.mona.getUiState();
        if (!alive) return;
        if (state.ok) setUi(state.data);
        else setBridgeError(state.error.message);

        const connection = await window.mona.engineState();
        if (!alive) return;
        if (connection.ok) setEngine(connection.data);

        const currentId = state.ok ? state.data.currentProjectId : null;
        if (currentId) {
          const selectedResult = await window.mona.selectProject(currentId);
          if (!alive) return;
          if (selectedResult.ok) {
            setSelected(selectedResult.data.project);
            setUi(selectedResult.data.ui);
            setEngine(selectedResult.data.engine);
            const entry = selectedResult.data.ui.projects[currentId];
            if (entry) setScreen(entry.view);
            const next = draftFor(selectedResult.data.ui, currentId);
            setSessionId(next.sessionId);
            setDraftText(next.text);
            const usage = await window.mona.projectSpend(currentId);
            if (alive && usage.ok) setSpend(usage.data);
            if (alive) void loadBriefing(currentId);
          }
        }
      } catch {
        if (alive) setBridgeError('The application bridge did not respond.');
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The launch flow reads this snapshot when a shell selection arrives, so a
  // switch never loses an unsent draft.
  useEffect(() => {
    liveSelection.current = { projectId: selected?.id ?? null, sessionId, draft: draftText };
  }, [draftText, selected, sessionId]);

  /**
   * One Explorer selection. The main process already opened or reused the
   * project, recorded the studio view and started the runtime; the shell mirrors
   * that receipt and puts the caret in the composer. It never submits a task.
   */
  const applyLaunch = useCallback(
    async (receipt: LaunchReceipt) => {
      if (receipt.seq <= appliedLaunch.current) return;
      appliedLaunch.current = receipt.seq;

      if (receipt.status === 'ready' || receipt.status === 'opened') {
        if (receipt.project) {
          const live = liveSelection.current;
          await refreshCatalog();
          await activateProject(
            receipt.project,
            live.projectId && live.sessionId
              ? { projectId: live.projectId, sessionId: live.sessionId, text: live.draft }
              : null,
          );
          setScreen('studio');
          if (receipt.focusComposer) setFocusToken((value) => value + 1);
        }
        setNotice({
          tone: receipt.status === 'ready' ? 'success' : 'attention',
          title: receipt.status === 'ready' ? 'Opened from Explorer' : 'Opened, with a caveat',
          body: [receipt.detail, ...receipt.warnings].join(' '),
        });
        return;
      }
      if (receipt.status === 'needs-selection') {
        setNotice({ tone: 'attention', title: 'Choose a project folder', body: receipt.detail });
        return;
      }
      if (receipt.status === 'relocation-required') {
        setNotice({
          tone: 'attention',
          title: 'This folder moved',
          body: [receipt.detail, ...receipt.warnings].join(' '),
        });
        return;
      }
      setNotice({
        tone: 'critical',
        title: 'Launch did not open a project',
        body: [receipt.detail, ...receipt.warnings].join(' '),
      });
    },
    [activateProject, refreshCatalog],
  );

  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    const unsubscribe = window.mona.onLaunchEvent((receipt) => {
      if (alive) void applyLaunch(receipt);
    });
    void (async () => {
      const state = await window.mona.getLaunchState();
      if (!alive || !state.ok || !state.data.latest) return;
      await applyLaunch(state.data.latest);
    })();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [applyLaunch, loaded]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('mona.theme', theme);
    } catch {
      /* storage is optional; the theme still applies for this session */
    }
  }, [theme]);

  // Attention state is local policy: notification toggle, quiet hours, density.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await window.mona.attentionGet();
      if (alive && result.ok) setAttention(result.data);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = attention?.settings.density ?? 'comfortable';
  }, [attention?.settings.density]);

  // Success notices are transient confirmations, not state the user must clear.
  // Warnings and failures stay until dismissed.
  useEffect(() => {
    if (!notice || notice.tone !== 'success') return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const flushDraft = useCallback(async () => {
    if (!selected || !sessionId) return;
    const key = `${selected.id}:${sessionId}`;
    if (savingDrafts.current.get(key) === draftText) return;
    const result = await window.mona.saveDraft({ projectId: selected.id, sessionId, text: draftText });
    if (result.ok) {
      savingDrafts.current.set(key, draftText);
      setUi(result.data);
    }
  }, [draftText, selected, sessionId]);

  useEffect(() => {
    if (!selected || !sessionId) return;
    const timer = setTimeout(() => void flushDraft(), 350);
    return () => clearTimeout(timer);
  }, [flushDraft, selected, sessionId]);

  const openFolder = useCallback(async () => {
    const picked = await unwrap(window.mona.pickFolder('open'), 'Folder picker unavailable');
    if (!picked?.path) return;
    const outcome = await unwrap(window.mona.openProject(picked.path), 'Could not open that folder');
    if (!outcome) return;
    if (outcome.status === 'relocation_required') {
      setRelocation(outcome);
      await refreshCatalog();
      return;
    }
    await refreshCatalog();
    await activateProject(outcome.project, null);
    setNotice({
      tone: 'success',
      title: 'Project open',
      body: `${outcome.project.label} is ready. No request was sent.`,
    });
  }, [activateProject, refreshCatalog, unwrap]);

  const pickCreateParent = useCallback(async () => {
    const picked = await unwrap(window.mona.pickFolder('create-parent'), 'Folder picker unavailable');
    if (!picked?.path) return;
    setCreateParent(picked.path);
    setCreateName('');
  }, [unwrap]);

  const confirmCreate = useCallback(async () => {
    if (!createParent) return;
    const created = await unwrap(
      window.mona.createProject({ parent: createParent, name: createName }),
      'Could not create that project',
    );
    if (!created) return;
    setCreateParent(null);
    await refreshCatalog();
    await activateProject(created, null);
  }, [activateProject, createName, createParent, refreshCatalog, unwrap]);

  const updateProject = useCallback(
    async (
      project: CatalogProject,
      patch: {
        label?: string;
        pinned?: boolean;
        archived?: boolean;
        color?: string | null;
        monogram?: string | null;
      },
    ) => {
      const updated = await unwrap(
        window.mona.updateProject({ projectId: project.id, expectedRevision: project.revision, patch }),
        'Could not update the project',
      );
      if (!updated) return null;
      await refreshCatalog();
      if (selected?.id === updated.id) setSelected(updated);
      return updated;
    },
    [refreshCatalog, selected, unwrap],
  );

  const removeProject = useCallback(
    async (project: CatalogProject) => {
      const removed = await unwrap(window.mona.removeProject(project.id), 'Could not remove the catalog entry');
      setConfirmRemove(null);
      if (!removed) return;
      if (selected?.id === project.id) {
        setSelected(null);
        setSessionId(null);
        setDraftText('');
        setSpend(null);
      }
      await refreshCatalog();
      await loadUi();
      setNotice({
        tone: 'success',
        title: 'Removed from the catalog',
        body: removed.folderStillExists
          ? 'The folder and its files are still on disk.'
          : 'The folder was already missing; nothing on disk was changed.',
      });
    },
    [loadUi, refreshCatalog, selected, unwrap],
  );

  const relocateProject = useCallback(async () => {
    if (!relocation) return;
    const picked = await unwrap(window.mona.pickFolder('open'), 'Folder picker unavailable');
    if (!picked?.path) return;
    const rebound = await unwrap(
      window.mona.relocateProject({
        projectId: relocation.project.id,
        expectedRevision: relocation.project.revision,
        path: picked.path,
      }),
      'Could not relocate that project',
    );
    if (!rebound) return;
    setRelocation(null);
    await refreshCatalog();
    await activateProject(rebound, null);
    setNotice({ tone: 'success', title: 'Project relocated', body: 'The catalog entry now points at the new folder.' });
  }, [activateProject, refreshCatalog, relocation, unwrap]);

  const reveal = useCallback(
    async (project: CatalogProject) => {
      const result = await unwrap(window.mona.revealProject(project.id), 'Could not reveal the folder');
      if (result)
        setNotice({ tone: result.revealed ? 'success' : 'attention', title: 'Reveal folder', body: result.detail });
    },
    [unwrap],
  );

  const startEngine = useCallback(async () => {
    if (!selected) return;
    setBusy('engine');
    const started = await unwrap(window.mona.startEngine(selected.id), 'The engine did not start');
    setBusy(null);
    if (!started) return;
    setEngine(started.engine);
    setSelected(started.project);
    await refreshCatalog();
    setNotice({
      tone: 'success',
      title: 'Engine connected',
      body: 'Starting the runtime sent no task and no prompt. Choose Plan or Work and submit when you are ready.',
    });
  }, [refreshCatalog, selected, unwrap]);

  const stopEngine = useCallback(async () => {
    setBusy('engine');
    const stopped = await unwrap(window.mona.stopEngine(), 'The engine did not stop cleanly');
    setBusy(null);
    if (!stopped) return;
    setEngine(stopped.engine);
    await refreshCatalog();
    setNotice({
      tone: 'neutral',
      title: 'Engine stopped',
      body: 'Sent work is not rolled back; restart is deliberate.',
    });
  }, [refreshCatalog, unwrap]);

  const newSession = useCallback(async () => {
    if (!selected) return;
    const result = await unwrap(window.mona.newSession(selected.id), 'Could not start a new session');
    if (!result) return;
    setUi(result);
    const next = draftFor(result, selected.id);
    setSessionId(next.sessionId);
    setDraftText(next.text);
  }, [selected, unwrap]);

  const changeScreen = useCallback(
    async (next: ProjectView) => {
      await flushDraft();
      setScreen(next);
      if (selected && next !== 'home') {
        const result = await window.mona.setProjectView({ projectId: selected.id, view: next });
        if (result.ok) setUi(result.data);
      }
    },
    [flushDraft, selected],
  );

  const layout = selected ? (ui?.projects[selected.id]?.layout ?? 'standard') : 'standard';
  const focusMode = layout === 'focus';

  const toggleFocus = useCallback(async () => {
    if (!selected) return;
    const next = layout === 'focus' ? 'standard' : 'focus';
    const result = await window.mona.setProjectLayout({ projectId: selected.id, layout: next });
    if (result.ok) {
      setUi(result.data);
      setNotice({
        tone: 'neutral',
        title: next === 'focus' ? 'Focus Mode on' : 'Focus Mode off',
        body: 'The layout is saved for this project. Execution controls and Interrupt now stay available.',
      });
    }
  }, [layout, selected]);

  const saveAttention = useCallback(async (patch: Parameters<typeof window.mona.attentionSet>[0]) => {
    const result = await window.mona.attentionSet(patch);
    if (result.ok) setAttention(result.data);
    else setNotice({ tone: 'critical', title: 'Notification setting not saved', body: result.error.message });
  }, []);

  const applyAttentionFocus = useCallback(
    async (focus: AttentionFocus) => {
      const list = await refreshCatalog();
      const target = (list ?? projects).find((project) => project.id === focus.projectId);
      if (target) {
        await activateProject(
          target,
          selected && sessionId ? { projectId: selected.id, sessionId, text: draftText } : null,
        );
      }
      await changeScreen('home');
      setFocusedEvidence(focus.evidencePath);
      await loadBriefing(focus.projectId, false);
      setNotice({
        tone: focus.kind === 'blocker' ? 'attention' : 'success',
        title: focus.kind === 'blocker' ? 'Blocker needs attention' : 'Run finished',
        body: 'Focused this project and its recorded evidence. No task was started.',
      });
    },
    [activateProject, changeScreen, draftText, loadBriefing, projects, refreshCatalog, selected, sessionId],
  );

  useEffect(() => {
    const unsubscribe = window.mona.onAttentionFocus((focus) => {
      void applyAttentionFocus(focus);
    });
    return unsubscribe;
  }, [applyAttentionFocus]);

  const quitAndStop = useCallback(async () => {
    setQuitOpen(false);
    const result = await window.mona.attentionQuitStop();
    if (!result.ok) {
      setNotice({ tone: 'critical', title: 'Quit was not requested', body: result.error.message });
    }
  }, []);

  // Keyboard flow: Alt+1…5 for sections, Ctrl+Shift+F for Focus Mode,
  // Ctrl+Shift+N for a new session, Ctrl+/ for the shortcut list. Interrupting
  // work stays a deliberate click on the execution controls.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.altKey && !ctrl && !event.shiftKey) {
        const targets: Record<string, ProjectView> = {
          '1': 'home',
          '2': 'studio',
          '3': 'work',
          '4': 'cost',
          '5': 'settings',
        };
        const target = targets[event.key];
        if (target) {
          event.preventDefault();
          void changeScreen(target);
        }
        return;
      }
      if (ctrl && event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === 'f') {
          event.preventDefault();
          void toggleFocus();
        } else if (key === 'n') {
          event.preventDefault();
          void newSession();
        } else if (key === '/') {
          event.preventDefault();
          setShortcutsOpen(true);
        }
        return;
      }
      if (event.key === '?' && !ctrl) {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          event.preventDefault();
          setShortcutsOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [changeScreen, newSession, toggleFocus]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { id: 'action:open-folder', label: 'Open a folder…', group: 'Projects' },
      { id: 'action:create-project', label: 'Create a project…', group: 'Projects' },
      { id: 'action:home', label: 'Go to Home', group: 'Navigate' },
      { id: 'action:studio', label: 'Go to Studio', group: 'Navigate', disabled: !selected },
      { id: 'action:work', label: 'Go to Work board', group: 'Navigate' },
      { id: 'action:cost', label: 'Go to Cost lens', group: 'Navigate' },
      { id: 'action:settings', label: 'Go to Settings', group: 'Navigate' },
      {
        id: 'action:toggle-theme',
        label: `Switch to ${theme === 'daybreak' ? 'Afterglow' : 'Daybreak'}`,
        group: 'Appearance',
      },
      { id: 'action:new-session', label: 'Start a new session', group: 'Studio', disabled: !selected },
      {
        id: 'action:start-engine',
        label: 'Connect the engine for this project',
        group: 'Studio',
        disabled: !selected || engine?.state === 'connected',
      },
      { id: 'action:stop-engine', label: 'Stop the engine', group: 'Studio', disabled: engine?.state !== 'connected' },
      {
        id: 'action:toggle-focus',
        label: focusMode ? 'Leave Focus Mode' : 'Enter Focus Mode',
        group: 'Appearance',
        disabled: !selected,
      },
      { id: 'action:shortcuts', label: 'Show keyboard shortcuts', group: 'Help' },
    ];
    if (selected) {
      items.push(
        { id: 'action:reveal', label: 'Reveal the project folder', group: 'Selected project' },
        { id: 'action:rename', label: 'Rename the project label', group: 'Selected project' },
        {
          id: 'action:archive',
          label: selected.archived ? 'Restore from archive' : 'Archive the project',
          group: 'Selected project',
        },
        { id: 'action:relocate', label: 'Locate the folder after a move', group: 'Selected project' },
        { id: 'action:identity', label: 'Edit color and monogram', group: 'Selected project' },
        { id: 'action:remove', label: 'Remove from the catalog…', group: 'Selected project' },
      );
    }
    for (const project of projects) {
      items.push({
        id: `project:${project.id}`,
        label: `Open ${project.label}`,
        hint: project.archived ? 'archived' : (project.branch ?? project.canonicalPath),
        group: 'Projects',
      });
    }
    return items;
  }, [engine?.state, focusMode, projects, selected, theme]);

  const runPaletteAction = useCallback(
    (id: string) => {
      setPaletteOpen(false);
      if (id.startsWith('project:')) {
        const project = projects.find((entry) => entry.id === id.slice('project:'.length));
        if (project)
          void activateProject(
            project,
            selected && sessionId ? { projectId: selected.id, sessionId, text: draftText } : null,
          );
        return;
      }
      switch (id) {
        case 'action:open-folder':
          void openFolder();
          break;
        case 'action:create-project':
          void pickCreateParent();
          break;
        case 'action:home':
        case 'action:studio':
        case 'action:work':
        case 'action:cost':
        case 'action:settings': {
          const target = id.slice('action:'.length) as ProjectView;
          void changeScreen(target);
          break;
        }
        case 'action:toggle-theme':
          setTheme((value) => (value === 'daybreak' ? 'afterglow' : 'daybreak'));
          break;
        case 'action:new-session':
          void newSession();
          break;
        case 'action:start-engine':
          void startEngine();
          break;
        case 'action:stop-engine':
          void stopEngine();
          break;
        case 'action:toggle-focus':
          void toggleFocus();
          break;
        case 'action:shortcuts':
          setShortcutsOpen(true);
          break;
        case 'action:reveal':
          if (selected) void reveal(selected);
          break;
        case 'action:rename':
          if (selected) {
            setRenameTarget(selected);
            setRenameValue(selected.label);
          }
          break;
        case 'action:archive':
          if (selected) {
            void updateProject(selected, { archived: !selected.archived }).then((updated) => {
              if (updated)
                setNotice({ tone: 'success', title: updated.archived ? 'Archived' : 'Restored', body: updated.label });
            });
          }
          break;
        case 'action:relocate':
          if (selected) {
            setRelocation({
              project: selected,
              observedPath: selected.canonicalPath,
              reason: 'Choose the folder’s current location to rebind this project deliberately.',
            });
          }
          break;
        case 'action:identity':
          if (selected) {
            const identity = projectIdentity(selected);
            setIdentityTarget(selected);
            setIdentityColor(identity.color);
            setIdentityMonogram(identity.monogram);
          }
          break;
        case 'action:remove':
          if (selected) setConfirmRemove(selected);
          break;
        default:
          break;
      }
    },
    [
      activateProject,
      changeScreen,
      draftText,
      newSession,
      openFolder,
      pickCreateParent,
      projects,
      reveal,
      selected,
      sessionId,
      startEngine,
      stopEngine,
      toggleFocus,
      updateProject,
    ],
  );

  // The harness renders only when the main process enabled the development flag.
  if (harness && info?.harnessEnabled) {
    return (
      <div className="harness-route mona-root">
        {harness.screen === 'all' ? <Harness /> : <HarnessScreen id={harness.screen} />}
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="mona-root app-shell">
        <main className="boot">
          <Skeleton label="Opening local state…" />
        </main>
      </div>
    );
  }

  const spendView = formatSpend(spend);
  const visible = projects
    .filter((project) => showArchived || !project.archived)
    .filter((project) => {
      const needle = search.trim().toLowerCase();
      if (!needle) return true;
      return (
        project.label.toLowerCase().includes(needle) ||
        project.canonicalPath.toLowerCase().includes(needle) ||
        (project.branch ?? '').toLowerCase().includes(needle)
      );
    });

  const engineWorkspaceMatches = Boolean(selected && engine?.workspace && selected.canonicalPath === engine.workspace);

  return (
    <div className={focusMode ? 'app-shell mona-root focus-mode' : 'app-shell mona-root'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <h1>Mona</h1>
            <p className="brand-sub">{selected ? selected.label : 'Local workbench for Codewhale'}</p>
          </div>
        </div>
        <div className="context" role="status" aria-live="polite" aria-label="Project context">
          <span className="context-item" data-testid="context-project">
            {selected ? selected.label : 'No project open'}
          </span>
          {!focusMode ? (
            <>
              <span className="context-item" data-testid="context-branch">
                {selected ? (selected.branch ?? 'No branch') : '—'}
              </span>
              <span className="context-item" data-testid="engine-state">
                {engine ? ENGINE_STATUS_LABEL[engine.state] : 'Engine state unknown'}
              </span>
              <span className="context-item" data-testid="context-model">
                {info?.route.model ?? 'Model unknown'}
              </span>
              <span className="context-item" data-testid="context-permission">
                {info
                  ? `${info.permission.label}${info.permission.profile ? ` · ${info.permission.profile}` : ''}`
                  : 'Permission unknown'}
              </span>
              <span className="context-item" data-testid="context-spend">
                {spendView.label}
              </span>
            </>
          ) : (
            <span className="context-item" data-testid="engine-state">
              {engine ? ENGINE_STATUS_LABEL[engine.state] : 'Engine state unknown'}
            </span>
          )}
          <button
            type="button"
            className="ghost-button"
            onClick={() => void toggleFocus()}
            disabled={!selected}
            aria-pressed={focusMode}
            aria-label={focusMode ? 'Leave Focus Mode' : 'Enter Focus Mode'}
            data-testid="focus-toggle"
            title="Focus Mode hides the inspector, search and recents. Execution controls stay available."
          >
            {focusMode ? 'Leave focus' : 'Focus'}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open the command palette"
            data-testid="palette-trigger"
          >
            Commands · Ctrl+K
          </button>
        </div>
      </header>

      <div className="layout">
        <nav className="rail" aria-label="Mona sections">
          {!focusMode ? (
            <div className="rail-search">
              <label className="mona-field-label" htmlFor="project-search">
                Search projects
              </label>
              <input
                id="project-search"
                className="mona-input"
                type="search"
                value={search}
                placeholder="Label, path or branch"
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (screen !== 'home') void changeScreen('home');
                }}
              />
              <label className="rail-check">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                Show archived
              </label>
            </div>
          ) : null}
          <ul>
            {NAV.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`nav-${item.id}`}
                  className={item.id === screen ? 'rail-button active' : 'rail-button'}
                  aria-current={item.id === screen ? 'page' : undefined}
                  onClick={() => void changeScreen(item.id)}
                  title={item.hint}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
          {!focusMode ? (
            <div className="rail-recents">
              <p className="eyebrow">Recent</p>
              {projects.filter((project) => !project.archived).length === 0 ? (
                <p className="mona-muted">No projects yet.</p>
              ) : (
                <ul>
                  {[...projects]
                    .filter((project) => !project.archived)
                    .sort((a, b) => {
                      const aOpened = ui?.projects[a.id]?.lastOpenedAt ?? '';
                      const bOpened = ui?.projects[b.id]?.lastOpenedAt ?? '';
                      return bOpened.localeCompare(aOpened) || a.label.localeCompare(b.label);
                    })
                    .slice(0, 6)
                    .map((project) => {
                      const identity = projectIdentity(project);
                      return (
                        <li key={project.id}>
                          <button
                            type="button"
                            className="rail-recent"
                            aria-current={selected?.id === project.id ? 'true' : undefined}
                            onClick={() =>
                              void activateProject(
                                project,
                                selected && sessionId ? { projectId: selected.id, sessionId, text: draftText } : null,
                              )
                            }
                          >
                            <span
                              className="project-mark small"
                              style={{ background: identity.color }}
                              aria-hidden="true"
                            >
                              {identity.monogram}
                            </span>
                            {project.label}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
          ) : null}
          <div className="rail-foot">
            <span className="dot" aria-hidden="true" />
            <span>Idle Mona makes no request</span>
          </div>
        </nav>

        <main className="studio-region">
          {bridgeError ? (
            <div className="panel error-panel" role="alert">
              <h2>Bridge error</h2>
              <p>{bridgeError}</p>
            </div>
          ) : null}
          {notice ? (
            <div className="notice-row">
              <Notification tone={notice.tone} title={notice.title}>
                {notice.body}
              </Notification>
              <Button size="sm" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </div>
          ) : null}

          <div className="workspace">
            <div className="workspace-main">
              {screen === 'home' ? (
                <HomeView
                  projects={visible}
                  ui={ui}
                  selected={selected}
                  busy={busy}
                  briefing={briefing}
                  briefingError={briefingError}
                  focusedEvidence={focusedEvidence}
                  onFocusEvidence={setFocusedEvidence}
                  onRefreshBrief={() => {
                    if (selected) void loadBriefing(selected.id, false);
                  }}
                  onOpenFolder={() => void openFolder()}
                  onCreate={() => void pickCreateParent()}
                  onSelect={(project) =>
                    void activateProject(
                      project,
                      selected && sessionId ? { projectId: selected.id, sessionId, text: draftText } : null,
                    )
                  }
                  onReveal={(project) => void reveal(project)}
                  onPin={(project) =>
                    void updateProject(project, { pinned: !project.pinned }).then((updated) => {
                      if (updated)
                        setNotice({
                          tone: 'success',
                          title: updated.pinned ? 'Pinned' : 'Unpinned',
                          body: updated.label,
                        });
                    })
                  }
                  onArchive={(project) =>
                    void updateProject(project, { archived: !project.archived }).then((updated) => {
                      if (updated)
                        setNotice({
                          tone: 'success',
                          title: updated.archived ? 'Archived' : 'Restored',
                          body: updated.label,
                        });
                    })
                  }
                  onRename={(project) => {
                    setRenameTarget(project);
                    setRenameValue(project.label);
                  }}
                  onIdentity={(project) => {
                    const identity = projectIdentity(project);
                    setIdentityTarget(project);
                    setIdentityColor(identity.color);
                    setIdentityMonogram(identity.monogram);
                  }}
                  onRemove={(project) => setConfirmRemove(project)}
                  onRelocate={(project) =>
                    setRelocation({
                      project,
                      observedPath: project.canonicalPath,
                      reason: 'Choose the folder’s current location to rebind this project deliberately.',
                    })
                  }
                  showArchived={showArchived}
                />
              ) : screen === 'studio' ? (
                <StudioPanel
                  info={info}
                  project={selected}
                  engine={engine}
                  spend={spend}
                  draft={draftText}
                  sessionId={sessionId}
                  ui={ui}
                  busy={busy}
                  focusToken={focusToken}
                  identity={selected ? projectIdentity(selected) : null}
                  favorites={selected ? (ui?.projects[selected.id]?.favorites ?? []) : []}
                  onSaveFavorite={(label, text) => {
                    if (!selected) return;
                    void window.mona.saveFavorite({ projectId: selected.id, label, text }).then((result) => {
                      if (result.ok) setUi(result.data);
                      else setNotice({ tone: 'critical', title: 'Prompt not saved', body: result.error.message });
                    });
                  }}
                  onRemoveFavorite={(favoriteId) => {
                    if (!selected) return;
                    void window.mona.removeFavorite({ projectId: selected.id, favoriteId }).then((result) => {
                      if (result.ok) setUi(result.data);
                    });
                  }}
                  onDraft={(text) => setDraftText(text)}
                  onOpenFolder={() => void openFolder()}
                  onStart={() => void startEngine()}
                  onStop={() => void stopEngine()}
                  onNewSession={() => void newSession()}
                  onDraftSent={() => {
                    setDraftText('');
                    if (selected && sessionId)
                      void window.mona.saveDraft({ projectId: selected.id, sessionId, text: '' });
                  }}
                  onSpendRefresh={() => {
                    if (selected) void loadSpend(selected.id);
                  }}
                  onLocate={() => {
                    if (selected) {
                      setRelocation({
                        project: selected,
                        observedPath: selected.canonicalPath,
                        reason: 'The project folder is missing. Locate it to rebind deliberately.',
                      });
                    }
                  }}
                />
              ) : screen === 'work' ? (
                <WorkView project={selected} />
              ) : screen === 'cost' ? (
                <CostView info={info} project={selected} spend={spend} />
              ) : (
                <SettingsView
                  info={info}
                  theme={theme}
                  onTheme={() => setTheme((value) => (value === 'daybreak' ? 'afterglow' : 'daybreak'))}
                  attention={attention}
                  onAttention={(patch) => void saveAttention(patch)}
                  focusMode={focusMode}
                  canFocus={selected !== null}
                  onToggleFocus={() => void toggleFocus()}
                  onQuit={() => setQuitOpen(true)}
                />
              )}
            </div>
            {focusMode ? null : (
              <InspectorPanel
                project={selected}
                ui={ui}
                engine={engine}
                engineWorkspaceMatches={engineWorkspaceMatches}
              />
            )}
          </div>
        </main>
      </div>

      {drawerOpen ? (
        <aside
          className="drawer"
          id="bottom-drawer"
          aria-label="Diagnostics drawer"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDrawerOpen(false);
            }
          }}
        >
          <div className="drawer-head">
            <strong>Diagnostics</strong>
            <Button size="sm" onClick={() => setDrawerOpen(false)}>
              Close drawer
            </Button>
          </div>
          <div className="drawer-grid">
            <section>
              <h3>Engine</h3>
              <p className="mona-muted">{engine?.detail ?? 'No engine state yet.'}</p>
              <p className="mona-mono">{engine?.endpoint ?? 'No endpoint'}</p>
            </section>
            <section>
              <h3>Local state</h3>
              <p className="mona-muted">{info?.localState.detail ?? 'Not reported.'}</p>
              <p className="mona-muted">Schema: {info?.localState.schemaVersion ?? 'unavailable'}</p>
            </section>
            <section>
              <h3>Terminal and tests</h3>
              <p className="mona-muted">
                The integrated terminal arrives with P23; test output is wired to the live studio.
              </p>
            </section>
          </div>
        </aside>
      ) : null}

      <footer className="statusbar">
        <span>
          {info
            ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · schema ${
                info.localState.schemaVersion ?? 'unavailable'
              }`
            : 'Starting…'}
          {info ? (
            <>
              {' · '}
              <span className="mona-muted" data-testid="app-version">
                v{info.version}
              </span>
            </>
          ) : null}
        </span>
        <div className="statusbar-actions">
          <button
            type="button"
            className="ghost-button"
            aria-expanded={drawerOpen}
            aria-controls="bottom-drawer"
            onClick={() => setDrawerOpen((value) => !value)}
          >
            {drawerOpen ? 'Hide diagnostics' : 'Diagnostics'}
          </button>
          <span>No model requests are made by this window.</span>
        </div>
      </footer>

      <CommandPalette
        open={paletteOpen}
        label="Command palette"
        items={paletteItems}
        onSelect={runPaletteAction}
        onClose={() => setPaletteOpen(false)}
      />

      <Dialog
        open={relocation !== null}
        title="Relocate this project?"
        onClose={() => setRelocation(null)}
        actions={
          <>
            <Button onClick={() => setRelocation(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void relocateProject()}>
              Choose the new location…
            </Button>
          </>
        }
      >
        <p>{relocation?.reason}</p>
        <p className="mona-mono">{relocation?.observedPath}</p>
        <p className="mona-muted">Mona rebinds the catalog entry. It does not copy, move, or delete files.</p>
      </Dialog>

      <Dialog
        open={confirmRemove !== null}
        title="Remove from the catalog?"
        onClose={() => setConfirmRemove(null)}
        actions={
          <>
            <Button onClick={() => setConfirmRemove(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => confirmRemove && void removeProject(confirmRemove)}>
              Remove entry
            </Button>
          </>
        }
      >
        <p>
          {confirmRemove?.label} will disappear from Mona. The folder, its files, and any Git history stay exactly where
          they are.
        </p>
        <p className="mona-mono">{confirmRemove?.canonicalPath}</p>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        title="Rename project label"
        onClose={() => setRenameTarget(null)}
        actions={
          <>
            <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!renameTarget) return;
                void updateProject(renameTarget, { label: renameValue }).then((updated) => {
                  if (updated) {
                    setRenameTarget(null);
                    setNotice({
                      tone: 'success',
                      title: 'Renamed',
                      body: `The folder was not renamed; only Mona’s label is ${updated.label}.`,
                    });
                  }
                });
              }}
            >
              Save label
            </Button>
          </>
        }
      >
        <label className="mona-field-label" htmlFor="rename-label">
          Label
        </label>
        <input
          id="rename-label"
          className="mona-input"
          value={renameValue}
          maxLength={120}
          onChange={(event) => setRenameValue(event.target.value)}
        />
        <p className="mona-muted">This changes Mona’s display label only. The folder name stays untouched.</p>
      </Dialog>

      <Dialog
        open={createParent !== null}
        title="Create a project folder"
        onClose={() => setCreateParent(null)}
        actions={
          <>
            <Button onClick={() => setCreateParent(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmCreate()}>
              Create and open
            </Button>
          </>
        }
      >
        <p className="mona-muted">Parent folder</p>
        <p className="mona-mono">{createParent}</p>
        <label className="mona-field-label" htmlFor="create-name">
          Project folder name
        </label>
        <input
          id="create-name"
          className="mona-input"
          value={createName}
          maxLength={80}
          onChange={(event) => setCreateName(event.target.value)}
        />
        <p className="mona-muted">Mona creates this folder, then records it. No task is invented.</p>
      </Dialog>

      <Dialog
        open={identityTarget !== null}
        title="Project identity"
        onClose={() => setIdentityTarget(null)}
        actions={
          <>
            <Button onClick={() => setIdentityTarget(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!identityTarget) return;
                void updateProject(identityTarget, { color: identityColor, monogram: identityMonogram }).then(
                  (updated) => {
                    if (!updated) return;
                    setIdentityTarget(null);
                    setNotice({
                      tone: 'success',
                      title: 'Identity saved',
                      body: `${updated.label} now uses ${projectIdentity(updated).monogram} ${projectIdentity(updated).color}.`,
                    });
                  },
                );
              }}
            >
              Save identity
            </Button>
          </>
        }
      >
        <p className="mona-muted">
          Identity is curated locally from the project id and label. The palette is fixed; the monogram is yours to
          edit.
        </p>
        <div className="identity-preview">
          <span className="project-mark" style={{ background: identityColor }} aria-hidden="true">
            {identityMonogram || 'M'}
          </span>
          <span>{identityTarget?.label}</span>
        </div>
        <div className="color-row" role="group" aria-label="Project color">
          {PROJECT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={color === identityColor ? 'color-chip active' : 'color-chip'}
              style={{ background: color }}
              aria-label={`Use color ${color}`}
              aria-pressed={color === identityColor}
              onClick={() => setIdentityColor(color)}
            />
          ))}
        </div>
        <label className="mona-field-label" htmlFor="identity-monogram">
          Monogram (1–3 characters)
        </label>
        <input
          id="identity-monogram"
          className="mona-input"
          value={identityMonogram}
          maxLength={3}
          onChange={(event) => setIdentityMonogram(event.target.value.toUpperCase())}
        />
        <p className="mona-muted">Saving changes Mona’s catalog metadata only. The folder is untouched.</p>
      </Dialog>

      <Dialog
        open={shortcutsOpen}
        title="Keyboard shortcuts"
        onClose={() => setShortcutsOpen(false)}
        actions={<Button onClick={() => setShortcutsOpen(false)}>Close</Button>}
      >
        <ul className="shortcut-list">
          <li>
            <kbd>Ctrl</kbd>+<kbd>K</kbd> command palette
          </li>
          <li>
            <kbd>Alt</kbd>+<kbd>1…5</kbd> Home, Studio, Work, Cost, Settings
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> toggle Focus Mode
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> new studio session
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>/</kbd> or <kbd>?</kbd> this list
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Enter</kbd> submit the composed prompt
          </li>
        </ul>
        <p className="mona-muted">
          Interrupting or quitting is never a single unmodified key. Both remain deliberate actions with visible
          controls.
        </p>
      </Dialog>

      <Dialog
        open={quitOpen}
        title="Quit and stop work?"
        onClose={() => setQuitOpen(false)}
        actions={
          <>
            <Button onClick={() => setQuitOpen(false)}>Keep working</Button>
            <Button variant="danger" onClick={() => void quitAndStop()}>
              Quit and stop work
            </Button>
          </>
        }
      >
        <p>
          Mona will interrupt the active turn, then stop the runtimes it owns. Sent work is not rolled back. Closing the
          window alone keeps work alive in the tray.
        </p>
        <p className="mona-muted">The tray menu offers the same action while the window is hidden.</p>
      </Dialog>
    </div>
  );
}

function HomeView({
  projects,
  ui,
  selected,
  busy,
  showArchived,
  briefing,
  briefingError,
  focusedEvidence,
  onFocusEvidence,
  onRefreshBrief,
  onOpenFolder,
  onCreate,
  onSelect,
  onReveal,
  onPin,
  onArchive,
  onRename,
  onIdentity,
  onRemove,
  onRelocate,
}: {
  projects: CatalogProject[];
  ui: UiStateView | null;
  selected: CatalogProject | null;
  busy: string | null;
  showArchived: boolean;
  briefing: BriefingView | null;
  briefingError: string | null;
  focusedEvidence: string | null;
  onFocusEvidence: (path: string) => void;
  onRefreshBrief: () => void;
  onOpenFolder: () => void;
  onCreate: () => void;
  onSelect: (project: CatalogProject) => void;
  onReveal: (project: CatalogProject) => void;
  onPin: (project: CatalogProject) => void;
  onArchive: (project: CatalogProject) => void;
  onRename: (project: CatalogProject) => void;
  onIdentity: (project: CatalogProject) => void;
  onRemove: (project: CatalogProject) => void;
  onRelocate: (project: CatalogProject) => void;
}): React.JSX.Element {
  return (
    <section className="panel home" aria-labelledby="home-title">
      <div className="home-head">
        <div>
          <p className="eyebrow">Home</p>
          <h2 id="home-title">Projects</h2>
          <p className="lede">
            {projects.length === 0
              ? 'Choose a folder to begin. Browsing the catalog needs no API key and makes no request.'
              : 'Pick up where you left off, or open another folder. Browsing the catalog makes no request.'}
          </p>
        </div>
        <div className="mona-row">
          <Button variant="primary" onClick={onOpenFolder} disabled={busy !== null}>
            Open folder…
          </Button>
          <Button onClick={onCreate} disabled={busy !== null}>
            Create project…
          </Button>
        </div>
      </div>

      {selected ? (
        <BriefingPanel
          briefing={briefing}
          error={briefingError}
          focusedEvidence={focusedEvidence}
          onFocusEvidence={onFocusEvidence}
          onRefresh={onRefreshBrief}
        />
      ) : null}

      {projects.length === 0 ? (
        <EmptyState
          title={showArchived ? 'No archived projects' : 'Choose a folder to begin'}
          body="Mona opens an existing folder or creates a new one. It never scans a drive to guess projects."
          action={
            <Button variant="primary" onClick={onOpenFolder}>
              Choose a folder…
            </Button>
          }
        />
      ) : (
        <>
          <div className="home-meta">
            <span className="mona-muted">
              {projects.length} project{projects.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="project-grid" aria-label="Project catalog">
            {projects.map((project) => {
              const entry = ui?.projects[project.id];
              const lastOpened = entry?.lastOpenedAt ? new Date(entry.lastOpenedAt).toLocaleString() : 'Never opened';
              const identity = projectIdentity(project);
              return (
                <li key={project.id} className="project-card">
                  <div className="project-card-head">
                    <span className="project-mark" style={{ background: identity.color }} aria-hidden="true">
                      {identity.monogram}
                    </span>
                    <h3>{project.label}</h3>
                    <div className="badge-row">
                      {project.pinned ? <Badge tone="info">pinned</Badge> : null}
                      {project.archived ? <Badge>archived</Badge> : null}
                      {!project.folderExists ? <Badge tone="critical">folder missing</Badge> : null}
                    </div>
                  </div>
                  <p className="mona-mono mona-truncate" title={project.canonicalPath}>
                    {project.canonicalPath}
                  </p>
                  <div className="badge-row">
                    <Badge tone={project.branch ? 'success' : 'neutral'}>{project.branch ?? 'No branch'}</Badge>
                    <Badge>{repoLabel(project)}</Badge>
                    {project.worktreeSiblingIds.length > 0 ? (
                      <Badge tone="attention">{project.worktreeSiblingIds.length} sibling worktree(s)</Badge>
                    ) : null}
                  </div>
                  <p className="mona-muted">Last opened: {lastOpened}</p>
                  <div className="project-actions">
                    <Button variant="primary" size="sm" onClick={() => onSelect(project)}>
                      Open
                    </Button>
                    <Button size="sm" onClick={() => onReveal(project)}>
                      Reveal
                    </Button>
                    <Button size="sm" onClick={() => onPin(project)}>
                      {project.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <Button size="sm" onClick={() => onRename(project)}>
                      Rename
                    </Button>
                    <Button size="sm" onClick={() => onIdentity(project)}>
                      Identity
                    </Button>
                    <Button size="sm" onClick={() => onArchive(project)}>
                      {project.archived ? 'Restore' : 'Archive'}
                    </Button>
                    {!project.folderExists ? (
                      <Button size="sm" onClick={() => onRelocate(project)}>
                        Locate…
                      </Button>
                    ) : null}
                    <Button variant="danger" size="sm" onClick={() => onRemove(project)}>
                      Remove…
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {selected ? (
        <p className="mona-muted" data-testid="home-selected">
          Selected: {selected.label}
        </p>
      ) : null}
    </section>
  );
}

function WorkView({ project }: { project: CatalogProject | null }): React.JSX.Element {
  return (
    <section className="panel" aria-labelledby="work-title">
      <p className="eyebrow">Work</p>
      <h2 id="work-title">Work board</h2>
      <p className="lede">
        Prompt dependencies, acceptance criteria, and deterministic eligible-task selection arrive with P10.
      </p>
      {project ? (
        <EmptyState
          title="No tasks recorded"
          body="Unstarted tasks stay unstarted. Mona does not guess percentages or invent progress for this project."
        />
      ) : (
        <EmptyState title="No project open" body="Choose a project before assigning a bounded prompt." />
      )}
      <div className="queue-note">
        <h3>Queue</h3>
        <p className="mona-muted">
          Pause after task, interrupt now, and cancel queued connect to the engine in P08/P11. Queue controls are not
          shown as enabled before they exist.
        </p>
      </div>
    </section>
  );
}

function CostView({
  info,
  project,
  spend,
}: {
  info: AppInfo | null;
  project: CatalogProject | null;
  spend: ProjectSpend | null;
}): React.JSX.Element {
  const view = formatSpend(spend);
  return (
    <section className="panel" aria-labelledby="cost-title">
      <p className="eyebrow">Cost lens</p>
      <h2 id="cost-title">Recorded spend</h2>
      <p className="lede">
        Only usage already recorded for this project is shown. A missing price is labeled unknown, never $0.00.
      </p>
      {project ? (
        <div className="facts">
          <div>
            <span className="fact-label">Project</span>
            <span className="fact-value">{project.label}</span>
          </div>
          <div>
            <span className="fact-label">Known cost</span>
            <span className="fact-value" data-testid="cost-known">
              {view.label}
            </span>
          </div>
          <div>
            <span className="fact-label">Turns with usage</span>
            <span className="fact-value">{spend?.turnCount ?? 0}</span>
          </div>
          <div>
            <span className="fact-label">Unknown-priced records</span>
            <span className="fact-value">{spend?.unknownCostRecords ?? 0}</span>
          </div>
          <div>
            <span className="fact-label">Route</span>
            <span className="fact-value">{info ? `${info.route.provider} · ${info.route.model}` : 'Unknown'}</span>
          </div>
          <div>
            <span className="fact-label">Pricing source</span>
            <span className="fact-value">{info?.route.source ?? 'Unknown'}</span>
          </div>
        </div>
      ) : (
        <EmptyState title="No project open" body="Open a project to see its recorded cost." />
      )}
      <p className="mona-muted">
        Budget controls and export arrive with P12. No remaining balance is inferred locally.
      </p>
    </section>
  );
}

function SettingsView({
  info,
  theme,
  onTheme,
  attention,
  onAttention,
  focusMode,
  canFocus,
  onToggleFocus,
  onQuit,
}: {
  info: AppInfo | null;
  theme: Theme;
  onTheme: () => void;
  attention: AttentionView | null;
  onAttention: (patch: Parameters<typeof window.mona.attentionSet>[0]) => void;
  focusMode: boolean;
  canFocus: boolean;
  onToggleFocus: () => void;
  onQuit: () => void;
}): React.JSX.Element {
  const settings = attention?.settings;
  const quiet = settings?.quietHours;
  const density: Density = settings?.density ?? 'comfortable';
  return (
    <section className="panel" aria-labelledby="settings-title">
      <p className="eyebrow">Settings</p>
      <h2 id="settings-title">Route, appearance and attention</h2>
      <p className="lede">
        These values are shown from the running build. Mona does not contact the provider to display them, and nothing
        on this screen starts inference.
      </p>
      <div className="facts">
        <div>
          <span className="fact-label">Provider</span>
          <span className="fact-value">{info?.route.provider ?? 'Unknown'}</span>
        </div>
        <div>
          <span className="fact-label">Model</span>
          <span className="fact-value">{info?.route.model ?? 'Unknown'}</span>
        </div>
        <div>
          <span className="fact-label">Endpoint</span>
          <span className="fact-value mona-mono">{info?.route.endpoint ?? 'Unknown'}</span>
        </div>
        <div>
          <span className="fact-label">Permission profile</span>
          <span className="fact-value">
            {info ? `${info.permission.label} · ${info.permission.profile ?? 'none'}` : 'Unknown'}
          </span>
        </div>
        <div>
          <span className="fact-label">Local state</span>
          <span className="fact-value">
            {info?.localState.available ? `schema v${info.localState.schemaVersion}` : 'unavailable'}
          </span>
        </div>
        <div>
          <span className="fact-label">Theme</span>
          <span className="fact-value">{theme}</span>
        </div>
      </div>
      <div className="mona-row">
        <Button onClick={onTheme}>Switch to {theme === 'daybreak' ? 'Afterglow' : 'Daybreak'}</Button>
      </div>

      <section className="settings-block" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance">Appearance</h3>
        <div className="mona-row" role="group" aria-label="Density">
          {(['comfortable', 'compact'] as Density[]).map((value) => (
            <Button
              key={value}
              size="sm"
              aria-pressed={density === value}
              variant={density === value ? 'primary' : 'secondary'}
              onClick={() => onAttention({ density: value })}
              data-testid={`density-${value}`}
            >
              {value === 'comfortable' ? 'Comfortable' : 'Compact'}
            </Button>
          ))}
        </div>
        <div className="mona-row">
          <Button size="sm" onClick={onToggleFocus} disabled={!canFocus} aria-pressed={focusMode}>
            {focusMode ? 'Leave Focus Mode' : 'Enter Focus Mode'}
          </Button>
          <span className="mona-muted">
            Focus Mode is saved per project. Execution controls and Interrupt now stay visible.
          </span>
        </div>
      </section>

      <section className="settings-block" aria-labelledby="settings-attention">
        <h3 id="settings-attention">Notifications and quiet hours</h3>
        <label className="rail-check">
          <input
            type="checkbox"
            checked={settings?.notificationsEnabled ?? true}
            onChange={(event) => onAttention({ notificationsEnabled: event.target.checked })}
          />
          Deliver completion and blocker notifications
        </label>
        <label className="rail-check">
          <input
            id="quiet-enabled"
            type="checkbox"
            checked={quiet?.enabled ?? false}
            onChange={(event) => onAttention({ quietHours: { enabled: event.target.checked } })}
          />
          Quiet hours
        </label>
        <div className="mona-row quiet-row">
          <label className="mona-field-label" htmlFor="quiet-start">
            From
          </label>
          <input
            id="quiet-start"
            className="mona-input"
            type="time"
            value={minutesToTime(quiet?.startMinute ?? 22 * 60)}
            onChange={(event) => onAttention({ quietHours: { startMinute: timeToMinutes(event.target.value) } })}
          />
          <label className="mona-field-label" htmlFor="quiet-end">
            To
          </label>
          <input
            id="quiet-end"
            className="mona-input"
            type="time"
            value={minutesToTime(quiet?.endMinute ?? 7 * 60)}
            onChange={(event) => onAttention({ quietHours: { endMinute: timeToMinutes(event.target.value) } })}
          />
          <label className="mona-field-label" htmlFor="quiet-zone">
            Timezone
          </label>
          <input
            key={quiet?.timeZone ?? 'local'}
            id="quiet-zone"
            className="mona-input mona-mono"
            defaultValue={quiet?.timeZone ?? 'local'}
            onBlur={(event) => onAttention({ quietHours: { timeZone: event.target.value.trim() || 'local' } })}
          />
        </div>
        <p className="mona-muted" data-testid="quiet-detail">
          {attention?.quietDetail ?? 'Quiet hours are off. Notifications can be delivered at any time.'}
        </p>
        <p className="mona-muted">
          Quiet hours silence notification delivery only. They never pause a running turn. Use “local” to follow the
          system timezone as it changes.
        </p>
        <p className="mona-muted" data-testid="tray-detail">
          Tray: {attention?.tray.tooltip ?? 'Not reported'} — {attention?.tray.detail ?? ''}
        </p>
      </section>

      <section className="settings-block" aria-labelledby="settings-quit">
        <h3 id="settings-quit">Stopping work</h3>
        <p className="mona-muted">
          Closing the window keeps owned work alive in the tray. Quit and stop work interrupts the active turn, then
          stops the runtimes Mona owns. Sent work is not rolled back.
        </p>
        <Button variant="danger" onClick={onQuit}>
          Quit and stop work…
        </Button>
      </section>

      <Notification tone="success" title="No Mona telemetry">
        Diagnostics are local and redacted. Credentials stay with Codewhale; Mona never reads or echoes them.
      </Notification>
    </section>
  );
}

function minutesToTime(minutes: number): string {
  const bounded = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  return Math.min(1439, Number(match[1]) * 60 + Number(match[2]));
}

function InspectorPanel({
  project,
  ui,
  engine,
  engineWorkspaceMatches,
}: {
  project: CatalogProject | null;
  ui: UiStateView | null;
  engine: EngineView | null;
  engineWorkspaceMatches: boolean;
}): React.JSX.Element {
  const entry = project ? ui?.projects[project.id] : null;
  return (
    <aside className="inspector panel" aria-label="Inspector">
      <h2>Inspector</h2>
      {project ? (
        <>
          <div className="inspector-block">
            <span className="fact-label">Path</span>
            <span className="mona-mono break">{project.canonicalPath}</span>
          </div>
          <div className="inspector-block">
            <span className="fact-label">Repository</span>
            <span>{repoLabel(project)}</span>
            {project.worktreeSiblingIds.length > 0 ? (
              <span className="mona-muted">
                {project.worktreeSiblingIds.length} sibling worktree(s) share this repo.
              </span>
            ) : null}
          </div>
          <div className="inspector-block">
            <span className="fact-label">Runtime binding</span>
            {project.binding ? (
              <span>
                {project.binding.state} · {project.binding.engineVersion ?? 'version unknown'}
              </span>
            ) : (
              <span className="mona-muted">Never connected.</span>
            )}
          </div>
          <div className="inspector-block">
            <span className="fact-label">Engine</span>
            <span>{engine ? ENGINE_STATUS_LABEL[engine.state] : 'Unknown'}</span>
            {engine?.state === 'connected' ? (
              <span className="mona-muted">
                {engineWorkspaceMatches ? 'Serving this project.' : 'Serving another workspace.'}
              </span>
            ) : null}
          </div>
          <div className="inspector-block">
            <span className="fact-label">Drafts</span>
            <span>{entry ? `${entry.sessions.length} session(s)` : 'No saved sessions'}</span>
          </div>
          <div className="inspector-block">
            <span className="fact-label">Agents</span>
            <span className="mona-muted">No delegated work. Children appear only when the engine reports them.</span>
          </div>
        </>
      ) : (
        <p className="mona-muted">No project selected. The inspector never fills itself with invented facts.</p>
      )}
    </aside>
  );
}

export {};
