import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Badge, Button } from '@mona/ui';
import type { CatalogProject } from '../shared/catalog.js';
import { TERMINAL_LIMITS, type TerminalSessionView } from '../shared/terminal.js';

const THEME = {
  background: '#0b1220',
  foreground: '#e8eef7',
  cursor: '#8fd0ff',
  selectionBackground: '#2a4365',
  black: '#0b1220',
  red: '#ff8080',
  green: '#7fd6a2',
  yellow: '#efcf7a',
  blue: '#8fd0ff',
  magenta: '#d6a2ff',
  cyan: '#7fe0e0',
  white: '#e8eef7',
  brightBlack: '#8a97a8',
};

const SEARCH_DECORATIONS = {
  matchBackground: '#2a4365',
  matchBorder: '#3b5f8f',
  matchOverviewRuler: '#2a4365',
  activeMatchBackground: '#8fd0ff',
  activeMatchBorder: '#bfe8ff',
  activeMatchColorOverviewRuler: '#8fd0ff',
};

/**
 * Sessions live in main, not in this component. Remembering the id across
 * mounts is what makes closing and reopening the drawer a reconnect instead of
 * a second shell.
 */
const ACTIVE_SESSIONS = new Map<string, string>();

/**
 * A user-driven local shell. Terminal bytes go through one dedicated channel and
 * nowhere else: no generic invoke, no filesystem, no runtime token. Escape
 * sequences and URLs stay inert text — no link addon is loaded, and OSC 52
 * (clipboard write from the program) is consumed and ignored.
 */
export function TerminalDrawer({
  project,
  open,
  onClose,
}: {
  project: CatalogProject | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const projectRef = useRef<string | null>(null);
  const [session, setSession] = useState<TerminalSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'found' | 'none'>('idle');
  const [ending, setEnding] = useState(false);
  const [starting, setStarting] = useState(false);

  const sendInput = useCallback(async (data: string): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = sessionRef.current;
    if (!projectId || !sessionId) return;
    for (let index = 0; index < data.length; index += 4096) {
      const slice = data.slice(index, index + 4096);
      const result = await window.mona.terminalInput({ projectId, sessionId, data: slice });
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
    }
  }, []);

  // One terminal instance for the life of the drawer. Closing the drawer hides
  // it; the shell keeps running and refresh replays bounded scrollback.
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      // xterm's screen-reader mode deliberately bypasses the textarea input path.
      // It stays off by default until a human screen-reader pass qualifies it.
      screenReaderMode: false,
      theme: THEME,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    // A program inside the terminal must not write the OS clipboard. OSC 52 is
    // consumed so the escape sequence can never reach a browser clipboard path.
    terminal.parser.registerOscHandler(52, () => true);
    terminal.open(hostRef.current);
    termRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    const disposable = terminal.onData((data) => {
      void sendInput(data);
    });
    return () => {
      disposable.dispose();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [sendInput]);

  // Main-process pushes: output, exit and state changes for this session only.
  useEffect(() => {
    return window.mona.onTerminalEvent((event) => {
      const terminal = termRef.current;
      if (!terminal) return;
      if (event.kind === 'data') {
        if (event.sessionId !== sessionRef.current) return;
        terminal.write(event.data);
        return;
      }
      if (event.session.id !== sessionRef.current) return;
      setSession(event.session);
      if (event.kind === 'exit') {
        terminal.write(`\r\n\x1b[33m[${event.reason}] ${event.detail ?? ''}\x1b[0m\r\n`);
        setEnding(false);
        ACTIVE_SESSIONS.delete(event.session.projectId);
        setNotice(
          event.reason === 'killed' ? 'Session ended. Start a new one when you need it.' : (event.detail ?? null),
        );
        if (event.session.state === 'exited') {
          sessionRef.current = null;
          projectRef.current = null;
        }
      }
    });
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!project || !termRef.current || !fitRef.current) return;
    setStarting(true);
    setError(null);
    setNotice(null);
    try {
      const previousProject = projectRef.current;
      if (sessionRef.current && previousProject && previousProject !== project.id) {
        await window.mona.terminalKill({ projectId: previousProject, sessionId: sessionRef.current });
        ACTIVE_SESSIONS.delete(previousProject);
        sessionRef.current = null;
      }
      const remembered = ACTIVE_SESSIONS.get(project.id);
      if (!sessionRef.current && remembered) {
        sessionRef.current = remembered;
        projectRef.current = project.id;
      }
      if (sessionRef.current) {
        const resumed = await window.mona.terminalRefresh({
          projectId: project.id,
          sessionId: sessionRef.current,
        });
        if (resumed.ok && resumed.data.session.state === 'running') {
          if (resumed.data.truncated) termRef.current.reset();
          termRef.current.write(resumed.data.data);
          setSession(resumed.data.session);
          termRef.current.focus();
          return;
        }
        // A remembered session that already exited is not a reconnect.
        ACTIVE_SESSIONS.delete(project.id);
        sessionRef.current = null;
      }
      termRef.current.reset();
      if (hostRef.current && hostRef.current.clientWidth >= 40 && hostRef.current.clientHeight >= 40) {
        fitRef.current.fit();
      }
      const cols = Math.max(TERMINAL_LIMITS.minCols, termRef.current.cols);
      const rows = Math.max(TERMINAL_LIMITS.minRows, termRef.current.rows);
      const result = await window.mona.terminalCreate({ projectId: project.id, cols, rows });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      sessionRef.current = result.data.id;
      projectRef.current = project.id;
      ACTIVE_SESSIONS.set(project.id, result.data.id);
      setSession(result.data);
      termRef.current.focus();
    } finally {
      setStarting(false);
    }
  }, [project]);

  useEffect(() => {
    if (!open || !project) return;
    void start();
  }, [open, project?.id, start]);

  // Fit on open and on container resize; report the size to the PTY.
  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!host || !term || !fit) return;
    const apply = (): void => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      const before = `${term.cols}x${term.rows}`;
      fit.fit();
      const after = `${term.cols}x${term.rows}`;
      if (before === after) return;
      const projectId = projectRef.current;
      const sessionId = sessionRef.current;
      if (!projectId || !sessionId) return;
      void window.mona.terminalResize({ projectId, sessionId, cols: term.cols, rows: term.rows });
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    return () => observer.disconnect();
  }, [open]);

  const writeClipboard = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${text.length} character(s).`);
      return;
    } catch {
      // A window that is not focused can refuse the async clipboard API. Fall
      // back to the OS clipboard through the narrow terminal-copy channel.
    }
    const fallback = await window.mona.terminalCopy({ data: text });
    if (fallback.ok) setNotice(`Copied ${text.length} character(s).`);
    else setNotice(`The clipboard refused the copy: ${fallback.error.message}`);
  }, []);

  const copySelection = useCallback(async (): Promise<void> => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (!selection) {
      setNotice('Select text in the terminal first, or use Copy all.');
      return;
    }
    await writeClipboard(selection);
  }, [writeClipboard]);

  /** Copy the whole visible scrollback. Deterministic, and useful after a build log. */
  const copyAll = useCallback(async (): Promise<void> => {
    const term = termRef.current;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
    if (!text.trim()) {
      setNotice('The terminal buffer is empty.');
      return;
    }
    await writeClipboard(text);
  }, [writeClipboard]);

  const runSearch = useCallback((value: string, backwards = false): void => {
    const search = searchRef.current;
    if (!search) return;
    if (!value) {
      search.clearDecorations();
      setSearchStatus('idle');
      return;
    }
    const hit = backwards
      ? search.findPrevious(value, { decorations: SEARCH_DECORATIONS })
      : search.findNext(value, { decorations: SEARCH_DECORATIONS });
    setSearchStatus(hit ? 'found' : 'none');
  }, []);

  const endSession = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = sessionRef.current;
    if (!projectId || !sessionId) return;
    setEnding(true);
    // The exit event, not this reply, is what proves the shell is gone. The
    // badge shows "closing" until the engine actually reports it.
    const result = await window.mona.terminalKill({ projectId, sessionId });
    if (!result.ok) {
      setEnding(false);
      setNotice(result.error.message);
    }
  }, []);

  const running = session?.state === 'running' && !ending;

  return (
    <section
      className="terminal-drawer"
      data-testid="terminal-drawer"
      data-session-id={session?.id ?? ''}
      hidden={!open}
      aria-label="Terminal"
      onKeyDown={(event) => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
          event.preventDefault();
          void copySelection();
        }
      }}
    >
      <header className="terminal-bar">
        <strong>Terminal</strong>
        {session ? (
          <>
            <Badge tone={running ? 'success' : ending ? 'attention' : 'info'}>
              {ending ? 'closing' : session.state}
            </Badge>
            <span className="mona-muted mona-mono" data-testid="terminal-cwd">
              {session.cwd} · {session.cols}×{session.rows}
            </span>
            {session.exitCode !== null ? (
              <span className="mona-muted" data-testid="terminal-exit">
                exit {session.exitCode}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mona-muted">
            {project ? 'Starting a local shell in this project…' : 'Open a project to start a terminal.'}
          </span>
        )}
        <span className="terminal-spacer" />
        <input
          className="mona-input terminal-search"
          type="search"
          value={query}
          placeholder="Search output"
          aria-label="Search terminal output"
          data-testid="terminal-search"
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            runSearch(value);
          }}
          onKeyDown={(event) => {
            const value = event.currentTarget.value;
            if (event.key === 'Enter') {
              event.preventDefault();
              runSearch(value, event.shiftKey);
            }
            if (event.key === 'Escape') {
              searchRef.current?.clearDecorations();
              setSearchStatus('idle');
              setQuery('');
            }
          }}
        />
        <span className="mona-muted" data-testid="terminal-search-status">
          {searchStatus === 'found' ? 'Match found' : searchStatus === 'none' ? 'No match' : ''}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void copySelection()}>
          Copy
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void copyAll()}>
          Copy all
        </Button>
        <Button size="sm" variant="secondary" disabled={!running} onClick={() => void endSession()}>
          {ending ? 'Closing…' : 'End session'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the terminal drawer">
          Close
        </Button>
      </header>
      {error ? (
        <p className="terminal-notice" data-testid="terminal-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="terminal-notice" data-testid="terminal-notice">
          {notice}
        </p>
      ) : null}
      <div className="terminal-surface" ref={hostRef} data-testid="terminal-surface" />
      {(!session || session.state !== 'running') && !starting && !ending && !error && project ? (
        <p className="terminal-notice">
          {session ? 'That shell has exited.' : 'No shell is running.'}{' '}
          <button type="button" className="ghost-button" onClick={() => void start()}>
            Start a shell
          </button>{' '}
          — it runs inside this project, and nothing it prints can call Mona’s application commands.
        </p>
      ) : null}
    </section>
  );
}
