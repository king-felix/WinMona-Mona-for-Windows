import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@mona/ui';
import type { CatalogProject, IpcResult, PromptFavorite, UiStateView } from '../shared/catalog.js';
import type {
  DiagnosticPreviewView,
  MemorySearchMode,
  MemorySearchView,
  PortableExportKind,
  PortableImportView,
  PromptPreviewView,
} from '../shared/memory.js';

/**
 * Project memory: local search, the versioned prompt shelf, portable
 * handoff/resume bundles and a redacted diagnostic preview. Everything here is
 * local. A prompt is only ever inserted into the composer; the section never
 * submits a turn.
 */
export function MemoryPanel({
  project,
  prompts,
  onUsePrompt,
  onPromptsChanged,
  onCatalogChanged,
}: {
  project: CatalogProject | null;
  prompts: PromptFavorite[];
  onUsePrompt: (text: string) => void;
  onPromptsChanged: (ui: UiStateView) => void;
  onCatalogChanged: () => Promise<void> | void;
}): React.JSX.Element {
  const [mode, setMode] = useState<MemorySearchMode>('history');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<MemorySearchView | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PromptPreviewView | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [acceptanceText, setAcceptanceText] = useState('');
  const [saving, setSaving] = useState(false);

  const [bundleBusy, setBundleBusy] = useState<string | null>(null);
  const [bundleReport, setBundleReport] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<PortableImportView | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticPreviewView | null>(null);

  const selected = useMemo(() => prompts.find((prompt) => prompt.id === selectedId) ?? null, [prompts, selectedId]);
  const variableNames = useMemo(() => detectVariables(template || selected?.template || ''), [template, selected]);

  const call = useCallback(async <T,>(promise: Promise<IpcResult<T>>): Promise<T | null> => {
    setError(null);
    try {
      const response = await promise;
      if (response.ok) return response.data;
      setError(response.error.message);
      return null;
    } catch {
      setError('The application bridge did not respond.');
      return null;
    }
  }, []);

  const runSearch = useCallback(async () => {
    if (!project || !query.trim()) return;
    setSearching(true);
    const data = await call(
      window.mona.memorySearch({
        projectId: project.id,
        query: query.trim(),
        mode,
        ...(mode === 'history' ? { limit: 20 } : {}),
      }),
    );
    setResult(data);
    setSearching(false);
  }, [call, mode, project, query]);

  const reindex = useCallback(async () => {
    if (!project) return;
    setIndexing(true);
    const data = await call(window.mona.memoryReindex(project.id));
    setIndexing(false);
    if (data) {
      setNotice(
        `Indexed ${data.documents} documents (${data.terms} terms). ${data.redacted} document(s) had credential-shaped text redacted before indexing.`,
      );
    }
  }, [call, project]);

  const loadPreview = useCallback(
    async (promptId: string, nextValues: Record<string, string>) => {
      if (!project) return;
      setPreviewBusy(true);
      const data = await call(window.mona.promptPreview({ projectId: project.id, promptId, values: nextValues }));
      setPreview(data);
      setPreviewBusy(false);
    },
    [call, project],
  );

  useEffect(() => {
    if (!project) return;
    setSelectedId(null);
    setPreview(null);
    setResult(null);
    setImportReport(null);
    setDiagnostics(null);
  }, [project?.id]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    void loadPreview(selected.id, values);
  }, [selected?.id]);

  const choosePrompt = (prompt: PromptFavorite): void => {
    setSelectedId(prompt.id);
    setValues({});
    setEditingId(null);
  };

  const beginEdit = (prompt: PromptFavorite): void => {
    setSelectedId(prompt.id);
    setEditingId(prompt.id);
    setLabel(prompt.label);
    setDescription(prompt.description);
    setTemplate(prompt.template);
    setAcceptanceText(prompt.acceptance.map((criterion) => criterion.text).join('\n'));
  };

  const resetEditor = (): void => {
    setEditingId(null);
    setLabel('');
    setDescription('');
    setTemplate('');
    setAcceptanceText('');
  };

  const savePrompt = async (): Promise<void> => {
    if (!project) return;
    if (!label.trim() || !template.trim()) {
      setError('A prompt needs a label and text.');
      return;
    }
    setSaving(true);
    const variables = variableNames.map((name) => {
      const existing = prompts
        .find((prompt) => prompt.id === editingId)
        ?.variables.find((variable) => variable.name === name);
      return (
        existing ?? {
          name,
          description: '',
          required: true,
          defaultValue: null,
        }
      );
    });
    const acceptance = acceptanceText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((text, index) => ({ id: `acc_${index + 1}`, text: text.slice(0, 500) }));
    const data = await call(
      window.mona.promptSave({
        projectId: project.id,
        ...(editingId ? { id: editingId } : {}),
        label: label.trim(),
        description,
        template,
        variables,
        acceptance,
      }),
    );
    setSaving(false);
    if (data) {
      onPromptsChanged(data);
      setNotice(editingId ? 'Saved a new prompt version. Earlier versions stay on the shelf.' : 'Prompt saved.');
      resetEditor();
    }
  };

  const removePrompt = async (promptId: string): Promise<void> => {
    if (!project) return;
    const data = await call(window.mona.promptRemove({ projectId: project.id, promptId }));
    if (data) {
      onPromptsChanged(data);
      if (selectedId === promptId) {
        setSelectedId(null);
        setPreview(null);
      }
    }
  };

  const importPrompts = async (): Promise<void> => {
    if (!project) return;
    const data = await call(window.mona.promptImport(project.id));
    if (!data) return;
    const ui = await call(window.mona.getUiState());
    if (ui) onPromptsChanged(ui);
    setNotice(`Imported ${data.imported} prompt(s) from a pack. Nothing was executed or sent.`);
  };

  const exportPrompts = async (): Promise<void> => {
    if (!project) return;
    const data = await call(window.mona.promptExport(project.id));
    if (data) setNotice(`Exported ${data.count} prompt(s) to ${data.file} (digest ${data.digest.slice(0, 12)}…).`);
  };

  const exportBundle = async (kind: PortableExportKind): Promise<void> => {
    if (!project) return;
    setBundleBusy(kind);
    const data = await call(window.mona.portableExport({ projectId: project.id, kind }));
    setBundleBusy(null);
    if (data) {
      setBundleReport(`${data.kind}: ${data.file} — ${data.detail} digest ${data.digest.slice(0, 12)}…`);
    }
  };

  const importBundle = async (kind: 'handoff' | 'resume' | 'settings'): Promise<void> => {
    setBundleBusy(kind);
    const data = await call(window.mona.portableImport({ kind }));
    setBundleBusy(null);
    if (data) {
      setImportReport(data);
      await onCatalogChanged();
    }
  };

  const loadDiagnostics = async (): Promise<void> => {
    setBundleBusy('diagnostics-preview');
    const data = await call(window.mona.diagnosticsPreview({ verifyArtifacts: false }));
    setBundleBusy(null);
    if (data) setDiagnostics(data);
  };

  if (!project) {
    return (
      <section className="panel" aria-labelledby="memory-title">
        <h1 id="memory-title">Memory</h1>
        <p className="mona-muted">Open a project to search its recorded state and its prompt shelf.</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="memory-title">
      <header className="panel-head">
        <div>
          <h1 id="memory-title">Memory</h1>
          <p className="mona-muted">
            Local search over recorded state, a versioned prompt shelf, portable handoff bundles and a redacted
            diagnostic preview. Nothing here contacts the provider.
          </p>
        </div>
      </header>

      {error ? (
        <p className="mona-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mona-muted">{notice}</p> : null}

      <div className="memory-grid">
        <section className="mona-card" aria-labelledby="memory-search-title">
          <h2 id="memory-search-title">Search</h2>
          <p className="mona-muted">
            History search reads only the local index (metadata, decisions, task evidence and bounded history). File
            search reads the project folder on demand and never copies files into the database.
          </p>
          <div className="mona-row" role="group" aria-label="Search scope">
            <Button size="sm" variant={mode === 'history' ? 'primary' : 'secondary'} onClick={() => setMode('history')}>
              History index
            </Button>
            <Button size="sm" variant={mode === 'files' ? 'primary' : 'secondary'} onClick={() => setMode('files')}>
              Project files
            </Button>
          </div>
          <div className="mona-row">
            <input
              className="mona-input"
              aria-label="Search query"
              placeholder={mode === 'history' ? 'Search decisions, tasks, evidence…' : 'Search text in this folder…'}
              value={query}
              maxLength={200}
              data-testid="memory-search-input"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch();
              }}
            />
            <Button
              size="sm"
              disabled={!query.trim() || searching}
              onClick={() => void runSearch()}
              data-testid="memory-search-run"
            >
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </div>
          <div className="mona-row">
            <Button
              size="sm"
              variant="secondary"
              disabled={indexing}
              onClick={() => void reindex()}
              data-testid="memory-reindex"
            >
              {indexing ? 'Indexing…' : 'Rebuild history index'}
            </Button>
          </div>
          {result ? (
            <div data-testid="memory-results">
              {result.mode === 'history' && !result.indexed ? (
                <p className="mona-muted">
                  This project has no history index yet. Rebuild it to search recorded state.
                </p>
              ) : null}
              {result.mode === 'files' ? (
                <p className="mona-muted">
                  Scanned {result.scannedFiles} file(s), {Math.round(result.scannedBytes / 1024)} KiB. Skipped{' '}
                  {result.skipped.secretPath} credential-shaped, {result.skipped.binary} binary and{' '}
                  {result.skipped.oversize} oversized file(s). Nothing was saved.
                </p>
              ) : null}
              {result.hits.length === 0 ? (
                <p className="mona-muted">{result.indexed || result.mode === 'files' ? 'No matches.' : ''}</p>
              ) : (
                <ul className="brief-list">
                  {result.hits.map((hit) => (
                    <li key={`${hit.docId}:${hit.kind}`} className="brief-item">
                      <div className="mona-row">
                        <span className="mona-badge">{hit.kind === 'file' ? 'file (on demand)' : hit.kind}</span>
                        <strong>{hit.title}</strong>
                        {hit.redacted ? <span className="mona-badge">redacted text</span> : null}
                      </div>
                      <p className="mona-muted">{hit.snippet}</p>
                      <p className="mona-mono mona-muted">{hit.refId}</p>
                    </li>
                  ))}
                </ul>
              )}
              {result.truncated ? <p className="mona-muted">Results are truncated at the stated bound.</p> : null}
            </div>
          ) : null}
        </section>

        <section className="mona-card" aria-labelledby="memory-shelf-title">
          <h2 id="memory-shelf-title">Prompt shelf</h2>
          <p className="mona-muted">
            {prompts.length} saved prompt(s). A variable is written as <code>{'{{name}}'}</code>; preview is the exact
            text inserted into the composer, including the acceptance checklist.
          </p>
          <div className="mona-row">
            <Button size="sm" onClick={() => void importPrompts()} data-testid="prompt-import">
              Import pack
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={prompts.length === 0}
              onClick={() => void exportPrompts()}
              data-testid="prompt-export"
            >
              Export pack
            </Button>
          </div>
          {prompts.length > 0 ? (
            <ul className="brief-list" aria-label="Prompt shelf" data-testid="prompt-list">
              {prompts.map((prompt) => (
                <li key={prompt.id} className="brief-item">
                  <div className="mona-row">
                    <strong>{prompt.label}</strong>
                    <span className="mona-badge">v{prompt.version}</span>
                    {prompt.acceptance.length > 0 ? (
                      <span className="mona-badge">{prompt.acceptance.length} checks</span>
                    ) : null}
                  </div>
                  <p className="mona-muted mona-truncate" title={prompt.template}>
                    {prompt.template}
                  </p>
                  <div className="mona-row">
                    <Button size="sm" onClick={() => choosePrompt(prompt)}>
                      Preview
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => beginEdit(prompt)}>
                      Edit as new version
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Remove ${prompt.label}`}
                      onClick={() => void removePrompt(prompt.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mona-muted">No prompts yet. Save the textarea below, or import a pack.</p>
          )}

          {selected ? (
            <div className="memory-preview" data-testid="prompt-preview">
              <h3>
                Preview · {selected.label} <span className="mona-muted">v{selected.version}</span>
              </h3>
              {variableNames.length > 0 ? (
                <div className="memory-variables">
                  {variableNames.map((name) => (
                    <label key={name} className="mona-field-label">
                      {name}
                      <input
                        className="mona-input"
                        value={values[name] ?? ''}
                        placeholder={
                          selected.variables.find((variable) => variable.name === name)?.defaultValue ??
                          `Value for ${name}`
                        }
                        onChange={(event) => {
                          const next = { ...values, [name]: event.target.value };
                          setValues(next);
                          void loadPreview(selected.id, next);
                        }}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              {previewBusy ? <p className="mona-muted">Rendering preview…</p> : null}
              {preview ? (
                <>
                  <pre className="mona-mono memory-text">{preview.text}</pre>
                  <p className="mona-muted">
                    {preview.characters} characters · sha256{' '}
                    <span className="mona-mono">{preview.sha256.slice(0, 12)}…</span> ·{' '}
                    {preview.ready ? 'ready' : `missing: ${preview.missing.join(', ') || 'malformed placeholder'}`}
                  </p>
                  {preview.acceptance.length > 0 ? (
                    <ul className="memory-checklist">
                      {preview.acceptance.map((criterion) => (
                        <li key={criterion.id}>☐ {criterion.text}</li>
                      ))}
                    </ul>
                  ) : null}
                  {preview.notes.map((note) => (
                    <p key={note} className="mona-muted">
                      {note}
                    </p>
                  ))}
                  <Button
                    size="sm"
                    disabled={!preview.ready}
                    onClick={() => onUsePrompt(preview.text)}
                    data-testid="prompt-use"
                  >
                    Insert into composer
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="memory-editor">
            <h3>{editingId ? 'Edit prompt (new version)' : 'New shelf prompt'}</h3>
            <label className="mona-field-label">
              Label
              <input
                className="mona-input"
                value={label}
                maxLength={120}
                onChange={(event) => setLabel(event.target.value)}
                data-testid="prompt-label"
              />
            </label>
            <label className="mona-field-label">
              Description
              <input
                className="mona-input"
                value={description}
                maxLength={1_000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="mona-field-label">
              Template
              <textarea
                className="mona-input"
                rows={4}
                value={template}
                maxLength={20_000}
                onChange={(event) => setTemplate(event.target.value)}
                data-testid="prompt-template"
              />
            </label>
            <label className="mona-field-label">
              Acceptance criteria (one per line)
              <textarea
                className="mona-input"
                rows={2}
                value={acceptanceText}
                maxLength={10_000}
                onChange={(event) => setAcceptanceText(event.target.value)}
              />
            </label>
            <div className="mona-row">
              <Button
                size="sm"
                disabled={saving || !label.trim() || !template.trim()}
                onClick={() => void savePrompt()}
                data-testid="prompt-save"
              >
                {saving ? 'Saving…' : editingId ? 'Save new version' : 'Save prompt'}
              </Button>
              {editingId ? (
                <Button size="sm" variant="secondary" onClick={resetEditor}>
                  Cancel edit
                </Button>
              ) : null}
            </div>
            {variableNames.length > 0 ? (
              <p className="mona-muted">Detected variables: {variableNames.map((name) => `{{${name}}}`).join(', ')}</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="mona-card" aria-labelledby="memory-portable-title">
        <h2 id="memory-portable-title">Portable handoff and backups</h2>
        <p className="mona-muted">
          A handoff carries tasks, decisions and evidence pointers — no runtime binding, token, engine-owned session or
          repository copy. Import requires a folder on this machine and never executes the imported work. Settings
          restore takes the maintenance lock.
        </p>
        <div className="mona-row">
          <Button
            size="sm"
            disabled={bundleBusy !== null}
            onClick={() => void exportBundle('handoff')}
            data-testid="export-handoff"
          >
            Export handoff
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={bundleBusy !== null}
            onClick={() => void exportBundle('resume')}
          >
            Export resume packet
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={bundleBusy !== null}
            onClick={() => void importBundle('handoff')}
            data-testid="import-handoff"
          >
            Import handoff
          </Button>
        </div>
        <div className="mona-row">
          <Button
            size="sm"
            variant="secondary"
            disabled={bundleBusy !== null}
            onClick={() => void exportBundle('settings')}
          >
            Back up settings
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={bundleBusy !== null}
            onClick={() => void importBundle('settings')}
          >
            Restore settings
          </Button>
        </div>
        {bundleReport ? <p className="mona-mono mona-muted">{bundleReport}</p> : null}
        {importReport ? (
          <div className="memory-report" data-testid="import-report">
            <p>
              Imported {importReport.kind}: {importReport.tasksImported} task(s), {importReport.decisionsImported}{' '}
              decision(s), {importReport.evidenceChecked} evidence pointer(s).
              {importReport.targetFolder ? ` Bound to ${importReport.targetFolder}.` : ''}
            </p>
            {importReport.missingFiles.length > 0 ? (
              <p className="memory-warning">Missing files: {importReport.missingFiles.join(', ')}</p>
            ) : null}
            {importReport.staleEvidence.length > 0 ? (
              <p className="memory-warning">
                Stale evidence: {importReport.staleEvidence.map((entry) => entry.path).join(', ')}
              </p>
            ) : null}
            {importReport.reopenedTasks.length > 0 ? (
              <p className="memory-warning">
                Reopened for verification: {importReport.reopenedTasks.map((entry) => entry.taskId).join(', ')}
              </p>
            ) : null}
            {importReport.restoredScopes.length > 0 ? (
              <p className="mona-muted">
                Restored scopes:{' '}
                {importReport.restoredScopes.map((scope) => `${scope.scope} v${scope.newVersion}`).join(', ')}
              </p>
            ) : null}
            <p className="mona-muted">Nothing was executed automatically.</p>
          </div>
        ) : null}
      </section>

      <section className="mona-card" aria-labelledby="memory-diagnostics-title">
        <h2 id="memory-diagnostics-title">Diagnostic preview</h2>
        <p className="mona-muted">
          Local and redacted by default: credential-shaped values and the account name in a home path are removed before
          the preview exists. Export writes exactly the previewed text.
        </p>
        <div className="mona-row">
          <Button
            size="sm"
            disabled={bundleBusy !== null}
            onClick={() => void loadDiagnostics()}
            data-testid="diagnostics-preview"
          >
            Build preview
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={bundleBusy !== null}
            onClick={() => void exportBundle('diagnostics')}
          >
            Export bundle
          </Button>
        </div>
        {diagnostics ? (
          <div data-testid="diagnostics-text">
            <p className="mona-muted">
              {diagnostics.bytes} bytes · sha256 <span className="mona-mono">{diagnostics.sha256.slice(0, 12)}…</span> ·{' '}
              {diagnostics.redaction.redactions} redaction(s)
              {diagnostics.artifacts.missing.length > 0
                ? ` · missing artifacts: ${diagnostics.artifacts.missing.join(', ')}`
                : ''}
            </p>
            <pre className="mona-mono memory-text">{diagnostics.text}</pre>
          </div>
        ) : null}
      </section>
    </section>
  );
}

/** The shelf's own placeholder syntax; kept local so the renderer needs no Node module. */
function detectVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 24);
}
