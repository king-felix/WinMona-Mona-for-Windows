import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Notification, type Tone } from '@mona/ui';
import type { ModelEntry, ProviderWorkbenchView } from '@mona/contracts';
import type { CatalogProject } from '../shared/catalog.js';

function statusTone(status: ProviderWorkbenchView['diagnostics']['status']): Tone {
  if (status === 'healthy') return 'success';
  if (status === 'missing_credential' || status === 'invalid_endpoint') return 'critical';
  return 'attention';
}

export function ProviderWorkbench({
  project,
  sessionId,
}: {
  project: CatalogProject | null;
  sessionId: string | null;
}): React.JSX.Element {
  const [view, setView] = useState<ProviderWorkbenchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [permission, setPermission] = useState<'ask' | 'auto-review' | 'full-access'>('full-access');
  const [mode, setMode] = useState<'agent' | 'plan'>('agent');

  async function load(providerOverride?: string): Promise<void> {
    if (!project || !sessionId) {
      setView(null);
      return;
    }
    setError(null);
    const result = await window.mona.providerGet({
      projectId: project.id,
      sessionId,
      ...(providerOverride ? { providerId: providerOverride } : {}),
    });
    if (result.ok) {
      setView(result.data);
      setProviderId(
        (current) =>
          providerOverride ?? (current || result.data.selectedProviderId || result.data.requested.provider || ''),
      );
      if (providerOverride) {
        setModelId(result.data.models[0]?.id ?? '');
      } else {
        setModelId((current) => current || result.data.requested.model || result.data.models[0]?.id || '');
      }
    } else {
      setError(result.error.message);
    }
  }

  useEffect(() => {
    void load();
  }, [project?.id, sessionId]);

  const modelsForProvider = useMemo(() => view?.models ?? [], [view]);
  const selectedModel = modelsForProvider.find((model) => model.id === modelId) ?? null;
  const reasoning = reasoningFor(selectedModel);

  async function apply(
    key: string,
    call: () => Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>,
  ): Promise<void> {
    setBusy(key);
    try {
      const result = await call();
      if (result.ok) {
        setNotice({
          tone: 'success',
          title: 'Saved for new threads',
          body: 'The engine confirmed the value. The active thread was not changed.',
        });
      } else {
        setNotice({ tone: 'critical', title: 'Not applied', body: result.error.message });
      }
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!project || !sessionId) {
    return (
      <Card title="Provider and model">
        <EmptyState title="No project open" body="Open a project to inspect and change engine defaults." />
      </Card>
    );
  }

  return (
    <Card title="Provider and model">
      <p className="mona-muted">
        Requested and effective routes are shown separately. Saving a default writes the engine’s own configuration for
        new threads; it never mutates the active thread and never contacts the provider.
      </p>
      {notice ? (
        <Notification tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notification>
      ) : null}
      {error ? (
        <Notification tone="critical" title="Configuration unavailable">
          {error}
        </Notification>
      ) : null}
      {view ? (
        <>
          <div className="facts">
            <div>
              <span className="fact-label">Requested</span>
              <span className="fact-value" data-testid="requested-route">
                {view.requested.provider ?? 'unknown'} · {view.requested.model ?? 'unknown'} ({view.requested.source})
              </span>
            </div>
            <div>
              <span className="fact-label">Effective</span>
              <span className="fact-value" data-testid="effective-route">
                {view.effective.provider} · {view.effective.model}
                {view.effective.threadId ? '' : ' (next thread)'}
              </span>
            </div>
            <div>
              <span className="fact-label">Permission</span>
              <span className="fact-value">{view.effective.permissionPosture}</span>
            </div>
            <div>
              <span className="fact-label">Saved default</span>
              <span className="fact-value">
                {view.savedDefault ? `${view.savedDefault.provider} · ${view.savedDefault.model}` : 'none'}
              </span>
            </div>
            <div>
              <span className="fact-label">Reasoning</span>
              <span className="fact-value">{reasoning.supported ? reasoning.levels.join(', ') : 'not offered'}</span>
            </div>
            <div>
              <span className="fact-label">Config revision</span>
              <span className="fact-value mona-mono">{view.configRevision.slice(0, 24)}…</span>
            </div>
          </div>
          <p className="mona-muted" data-testid="reasoning-note">
            {reasoning.note}
          </p>

          {view.caveats.map((caveat) => (
            <p className="mona-muted" key={caveat}>
              {caveat}
            </p>
          ))}

          <div className="mona-row">
            <label>
              <span className="fact-label">Provider</span>
              <select
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setModelId('');
                  void load(event.target.value);
                }}
                data-testid="provider-select"
              >
                <option value="">Choose a provider</option>
                {view.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName} ({provider.credentialState})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="fact-label">Model</span>
              <select value={modelId} onChange={(event) => setModelId(event.target.value)} data-testid="model-select">
                <option value="">Choose a model</option>
                {modelsForProvider.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              disabled={!providerId || !modelId || busy === 'route'}
              onClick={() =>
                void apply('route', () =>
                  window.mona.providerApplyRoute({
                    projectId: project.id,
                    sessionId,
                    provider: providerId,
                    model: modelId,
                    expectedRevision: view.configRevision,
                  }),
                )
              }
            >
              Save as new-thread default
            </Button>
          </div>

          <div className="mona-row">
            <label>
              <span className="fact-label">New sessions’ permission</span>
              <select
                value={permission}
                onChange={(event) => setPermission(event.target.value as 'ask' | 'auto-review' | 'full-access')}
                data-testid="permission-select"
              >
                {view.permissions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === 'permission'}
              onClick={() =>
                void apply('permission', () =>
                  window.mona.providerApplyPermission({
                    projectId: project.id,
                    sessionId,
                    posture: permission,
                    expectedRevision: view.configRevision,
                  }),
                )
              }
            >
              Save permission default
            </Button>
          </div>

          <div className="mona-row">
            <label>
              <span className="fact-label">Startup mode</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as 'agent' | 'plan')}>
                <option value="agent">Work</option>
                <option value="plan">Plan (read only)</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === 'mode'}
              onClick={() =>
                void apply('mode', () =>
                  window.mona.providerApplyMode({
                    projectId: project.id,
                    sessionId,
                    mode,
                    expectedRevision: view.configRevision,
                  }),
                )
              }
            >
              Save mode default
            </Button>
          </div>

          <section aria-labelledby="provider-diagnostics">
            <h3 id="provider-diagnostics">Connection diagnostics</h3>
            <p>
              <Badge tone={statusTone(view.diagnostics.status)}>{view.diagnostics.status}</Badge>{' '}
              <span className="mona-muted">offline check; no provider request was made</span>
            </p>
            <ul className="agent-tree">
              {view.diagnostics.findings.map((finding) => (
                <li key={finding.id}>
                  <div className="agent-row">
                    <Badge
                      tone={
                        finding.severity === 'error'
                          ? 'critical'
                          : finding.severity === 'warning'
                            ? 'attention'
                            : 'info'
                      }
                    >
                      {finding.severity}
                    </Badge>
                    <strong>{finding.title}</strong>
                  </div>
                  <p className="agent-event">{finding.detail}</p>
                </li>
              ))}
            </ul>
            <details>
              <summary>Redacted diagnostics text</summary>
              <pre className="mona-mono" data-testid="diagnostics-text">
                {view.diagnostics.redactedText}
              </pre>
            </details>
          </section>

          {selectedModel ? (
            <p className="mona-muted">
              Selected model facts: context {selectedModel.contextTokens?.toLocaleString() ?? 'unknown'} tokens · output{' '}
              {selectedModel.outputTokens?.toLocaleString() ?? 'unknown'} tokens · image input{' '}
              {selectedModel.imageInput}
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState title="Reading configuration" body="No engine configuration has been read yet." />
      )}
    </Card>
  );
}

function reasoningFor(model: ModelEntry | null): { supported: boolean; levels: string[]; note: string } {
  if (!model) {
    return {
      supported: false,
      levels: [],
      note: 'No model catalog entry is selected, so Mona offers no reasoning control.',
    };
  }
  if (model.reasoningEffort !== 'supported' || model.reasoningLevels.length === 0) {
    return {
      supported: false,
      levels: [],
      note:
        model.reasoningEffort === 'unknown'
          ? `${model.id} reports reasoning support as unknown. Mona offers no reasoning control and sends none.`
          : `${model.id} reports no supported reasoning levels. Mona offers no reasoning control and sends none.`,
    };
  }
  return {
    supported: true,
    levels: model.reasoningLevels,
    note: `The route reports reasoning levels ${model.reasoningLevels.join(', ')}; the engine route decides the value.`,
  };
}
