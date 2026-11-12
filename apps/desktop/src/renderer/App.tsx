import { useEffect, useState } from 'react';
import { Harness, HarnessScreen, type HarnessScreenId } from '@mona/ui';
import { ENGINE_STATUS_LABEL } from '../shared/engine-status.js';
import type { AppInfo } from '../shared/ipc.js';

/** Query-driven visual harness route: fixtures only, never live state. */
function harnessRequest(): { screen: HarnessScreenId | 'all' } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('harness') === null) return null;
    const requested = params.get('screen') ?? 'all';
    const allowed: HarnessScreenId[] = ['home', 'studio', 'work', 'cost', 'blocker', 'settings', 'states'];
    return { screen: allowed.includes(requested as HarnessScreenId) ? (requested as HarnessScreenId) : 'all' };
  } catch {
    return null;
  }
}

type Theme = 'daybreak' | 'afterglow';
type View = 'projects' | 'work' | 'cost' | 'settings';

const VIEWS: Array<{ id: View; label: string; hint: string }> = [
  { id: 'projects', label: 'Projects', hint: 'Project catalog and folder launch' },
  { id: 'work', label: 'Work', hint: 'Prompt board, timeline, and review' },
  { id: 'cost', label: 'Cost', hint: 'Usage, cache evidence, and budgets' },
  { id: 'settings', label: 'Settings', hint: 'Providers, permissions, and appearance' },
];

const VIEW_COPY: Record<View, { title: string; body: string }> = {
  projects: {
    title: 'No project open',
    body: 'Folder launch is not available in this build yet. P02 proves the secure window, the typed bridge, and the theme foundation; the catalog arrives with the project shell.',
  },
  work: {
    title: 'No work in progress',
    body: 'The live studio arrives after the engine adapter. Mona never invents a task or spends tokens to fill an empty screen.',
  },
  cost: {
    title: 'No spend recorded',
    body: 'Cost is shown only when the engine reports it. Unknown cost is labeled unknown, never zero.',
  },
  settings: {
    title: 'Defaults are in effect',
    body: 'Provider route, permissions, and appearance will be editable here once the settings workbench is built.',
  },
};

function initialTheme(): Theme {
  try {
    // An explicit request (the screenshot harness) wins over the stored choice,
    // and must be read before the theme effect writes the attribute.
    const requested = new URLSearchParams(window.location.search).get('theme');
    if (requested === 'daybreak' || requested === 'afterglow') return requested;
    return localStorage.getItem('mona.theme') === 'afterglow' ? 'afterglow' : 'daybreak';
  } catch {
    return 'daybreak';
  }
}

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [view, setView] = useState<View>('projects');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const harness = harnessRequest();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const density = params.get('density');
    if (density === 'compact' || density === 'comfortable') {
      document.documentElement.dataset.density = density;
    }
    const requestedTheme = params.get('theme');
    if (requestedTheme === 'afterglow' || requestedTheme === 'daybreak') {
      document.documentElement.dataset.theme = requestedTheme;
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('mona.theme', theme);
    } catch {
      /* storage is optional; the theme still applies for this session */
    }
  }, [theme]);

  useEffect(() => {
    let alive = true;
    window.mona
      .getAppInfo()
      .then((result) => {
        if (!alive) return;
        if (result.ok) setInfo(result.data);
        else setError(result.error.message);
      })
      .catch(() => {
        if (alive) setError('The application bridge did not respond.');
      });
    return () => {
      alive = false;
    };
  }, []);

  const copy = VIEW_COPY[view];

  if (harness) {
    return (
      <div className="harness-route mona-root">
        {harness.screen === 'all' ? <Harness /> : <HarnessScreen id={harness.screen} />}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <h1>Mona</h1>
            <p className="brand-sub">Local workbench for Codewhale</p>
          </div>
        </div>
        <div className="context" role="status" aria-live="polite">
          <span className="context-item" data-testid="engine-state">
            {info ? ENGINE_STATUS_LABEL[info.engine.status] : 'Engine state pending'}
          </span>
          <span className="context-item muted">Model —</span>
          <span className="context-item muted">Full Access —</span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setTheme(theme === 'daybreak' ? 'afterglow' : 'daybreak')}
            aria-label={`Switch to ${theme === 'daybreak' ? 'Afterglow' : 'Daybreak'} theme`}
          >
            {theme === 'daybreak' ? 'Afterglow' : 'Daybreak'}
          </button>
        </div>
      </header>

      <div className="layout">
        <nav className="rail" aria-label="Mona sections">
          <ul>
            {VIEWS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`nav-${item.id}`}
                  className={item.id === view ? 'rail-button active' : 'rail-button'}
                  aria-current={item.id === view ? 'page' : undefined}
                  onClick={() => setView(item.id)}
                  title={item.hint}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="rail-foot">
            <span className="dot" aria-hidden="true" />
            <span>No inference in this window</span>
          </div>
        </nav>

        <main className="studio">
          {error ? (
            <div className="panel error-panel" role="alert">
              <h2>Bridge error</h2>
              <p>{error}</p>
            </div>
          ) : (
            <section className="panel" aria-labelledby="empty-title">
              <p className="eyebrow">{VIEWS.find((item) => item.id === view)?.label}</p>
              <h2 id="empty-title">{copy.title}</h2>
              <p className="lede">{copy.body}</p>
              <div className="facts">
                <div>
                  <span className="fact-label">Application</span>
                  <span className="fact-value" data-testid="app-version">
                    {info ? `v${info.version}` : 'Loading…'}
                  </span>
                </div>
                <div>
                  <span className="fact-label">Runtime</span>
                  <span className="fact-value">{info ? ENGINE_STATUS_LABEL[info.engine.status] : 'unknown'}</span>
                </div>
                <div>
                  <span className="fact-label">Platform</span>
                  <span className="fact-value">{info ? `${info.platform} ${info.arch}` : 'unknown'}</span>
                </div>
              </div>
            </section>
          )}

          <aside className="inspector" aria-label="Inspector">
            <h2>Inspector</h2>
            <p>{info ? info.engine.detail : 'Waiting for the application bridge.'}</p>
            {info && info.engine.descriptors.length > 0 ? (
              <ul className="facts">
                {info.engine.descriptors.map((descriptor) => (
                  <li key={descriptor}>{descriptor}</li>
                ))}
              </ul>
            ) : null}
          </aside>
        </main>
      </div>

      <footer className="statusbar">
        <span>{info ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}` : 'Starting…'}</span>
        <span>No model requests are made by this window.</span>
      </footer>
    </div>
  );
}
