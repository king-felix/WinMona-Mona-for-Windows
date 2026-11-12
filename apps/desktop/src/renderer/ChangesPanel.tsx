import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, VirtualList, type Tone } from '@mona/ui';
import type { CatalogProject } from '../shared/catalog.js';
import type { ChangesDiffView, ChangesView, ChangeEntry } from '../shared/changes.js';

const CHANGE_ROW_HEIGHT = 30;
const DIFF_ROW_HEIGHT = 18;
const MAX_RENDERED_PATHS = 2_000;

const CHANGE_TONE: Record<ChangeEntry['change'], Tone> = {
  added: 'success',
  modified: 'attention',
  deleted: 'critical',
};

const CHANGE_LABEL: Record<ChangeEntry['change'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

function whenLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

type DiffLine = { index: number; text: string; kind: 'added' | 'removed' | 'meta' | 'context' };

function classifyDiff(text: string): DiffLine[] {
  const raw = text.split('\n');
  // A trailing newline is a terminator, not an empty final line.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((line, index) => ({
    index,
    text: line,
    kind:
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')
        ? 'meta'
        : line.startsWith('+')
          ? 'added'
          : line.startsWith('-')
            ? 'removed'
            : 'context',
  }));
}

/**
 * The Changes view. It reports workspace facts and recorded receipts, and it
 * keeps "unavailable" visibly different from "nothing changed": a missing
 * baseline, a missing folder, a non-Git workspace and a real empty change list
 * all say what they are.
 */
export function ChangesPanel({ project }: { project: CatalogProject | null }): React.JSX.Element {
  const [view, setView] = useState<ChangesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ChangesDiffView | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const projectId = project?.id ?? null;
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setView(null);
      return;
    }
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setError(null);
    try {
      const result = await window.mona.changesView({ projectId });
      if (seq !== requestSeq.current) return;
      if (result.ok) {
        setView(result.data);
        setSelected((current) =>
          current && result.data.changes.some((entry) => entry.path === current) ? current : null,
        );
      } else {
        setView(null);
        setError(result.error.message);
      }
    } catch {
      if (seq === requestSeq.current) setError('The application bridge did not answer.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelected(null);
    setDiff(null);
    setDiffError(null);
    setNotice(null);
    void load();
  }, [load]);

  const openDiff = useCallback(
    async (path: string): Promise<void> => {
      if (!projectId) return;
      setSelected(path);
      setDiff(null);
      setDiffError(null);
      setDiffLoading(true);
      try {
        const result = await window.mona.changesDiff({ projectId, path });
        if (result.ok) setDiff(result.data);
        else setDiffError(result.error.message);
      } catch {
        setDiffError('The diff could not be requested.');
      } finally {
        setDiffLoading(false);
      }
    },
    [projectId],
  );

  const capture = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setCapturing(true);
    setNotice(null);
    try {
      const result = await window.mona.changesCapture({ projectId, label: 'captured from Changes' });
      if (result.ok) {
        setNotice(
          `Compared from now on against ${result.data.fileCount} file(s) captured ${whenLabel(result.data.capturedAt)}${
            result.data.truncated ? ', at the scan file cap' : ''
          }.`,
        );
        await load();
      } else {
        setNotice(result.error.message);
      }
    } catch {
      setNotice('The baseline could not be captured.');
    } finally {
      setCapturing(false);
    }
  }, [projectId, load]);

  const lines = useMemo(() => (diff?.available ? classifyDiff(diff.text) : []), [diff]);
  const changes = view?.changes ?? [];
  const shownChanges = changes.slice(0, MAX_RENDERED_PATHS);

  if (!project) {
    return (
      <section className="panel" aria-labelledby="changes-title">
        <p className="eyebrow">Changes</p>
        <h2 id="changes-title">Changes</h2>
        <EmptyState title="No project open" body="Choose a project before reviewing changes and test receipts." />
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="changes-title">
      <p className="eyebrow">Changes</p>
      <h2 id="changes-title">Changes and evidence</h2>
      <p className="lede">
        Read from the workspace itself: a hash comparison against a baseline you captured, Git status and Git text
        diffs, and the test receipts Mona recorded. No model is involved.
      </p>

      <div className="changes-toolbar">
        <div className="mona-row">
          <Button size="sm" onClick={() => void load()} disabled={loading} data-testid="changes-refresh">
            {loading ? 'Reading…' : 'Refresh'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void capture()}
            disabled={capturing || !view?.workspaceExists}
          >
            {capturing ? 'Capturing…' : 'Capture baseline'}
          </Button>
        </div>
        <span className="mona-muted">
          Scan bound: {view?.scan.maxFiles?.toLocaleString() ?? 'unknown'} files; skipping{' '}
          {view?.scan.excluded.join(', ') ?? 'no recorded exclusions'}.
        </span>
      </div>

      {notice ? <p className="mona-muted">{notice}</p> : null}
      {error ? <ErrorState title="Changes unavailable" detail={error} /> : null}

      {view?.unavailableReason ? <ErrorState title="Changes unavailable" detail={view.unavailableReason} /> : null}

      {view && !view.unavailableReason ? (
        <>
          <div className="changes-facts">
            <div className="fact">
              <span className="fact-label">Repository</span>
              <span>
                {view.repository.kind === 'none'
                  ? 'No Git repository'
                  : view.repository.kind === 'worktree'
                    ? 'Git worktree'
                    : 'Git repository'}
                {view.repository.branch ? ` · ${view.repository.branch}` : ''}
              </span>
              <span className="mona-muted mona-mono">
                {view.repository.head ? view.repository.head.slice(0, 12) : 'no HEAD'}
                {view.repository.worktreeOf ? ` · worktree of ${view.repository.worktreeOf}` : ''}
              </span>
              {view.repository.unavailableReason ? (
                <span className="mona-muted">Git: {view.repository.unavailableReason}</span>
              ) : null}
            </div>
            <div className="fact">
              <span className="fact-label">Git working tree</span>
              <span>
                {view.repository.staged} staged · {view.repository.unstaged} unstaged · {view.repository.untracked}{' '}
                untracked
              </span>
              {view.repository.conflicts.length > 0 ? (
                <span className="mona-muted">{view.repository.conflicts.length} conflicted path(s)</span>
              ) : null}
            </div>
            <div className="fact">
              <span className="fact-label">Baseline</span>
              {view.baseline ? (
                <>
                  <span>
                    {view.baseline.fileCount} file(s) · {whenLabel(view.baseline.capturedAt)}
                  </span>
                  <span className="mona-muted">
                    {view.baseline.label}
                    {view.baseline.truncated ? ' · truncated at the file cap' : ''}
                  </span>
                </>
              ) : (
                <span className="mona-muted">
                  No baseline captured yet, so no change list exists. This is not an empty diff.
                </span>
              )}
            </div>
          </div>

          <h3>
            Changed paths{' '}
            {view.comparable ? (
              <span className="mona-muted">
                {view.counts.added} added · {view.counts.modified} modified · {view.counts.deleted} deleted
              </span>
            ) : null}
          </h3>

          {!view.comparable ? (
            <EmptyState
              title="Changes unavailable"
              body="Capture a baseline to compare the workspace with it. Without one, Mona cannot tell a changed file from an unchanged one."
            />
          ) : changes.length === 0 ? (
            <EmptyState
              title="No changes since the baseline"
              body={`Compared against ${view.baseline?.fileCount ?? 0} captured file(s). Files skipped by the scan are listed below.`}
            />
          ) : (
            <VirtualList
              label="Changed paths"
              rowHeight={CHANGE_ROW_HEIGHT}
              rowCount={shownChanges.length}
              className="changes-list"
              renderRow={(index) => {
                const entry = shownChanges[index]!;
                return (
                  <button
                    type="button"
                    className={`change-row${selected === entry.path ? ' is-selected' : ''}`}
                    onClick={() => void openDiff(entry.path)}
                    aria-current={selected === entry.path ? 'true' : undefined}
                  >
                    <Badge tone={CHANGE_TONE[entry.change]}>{CHANGE_LABEL[entry.change]}</Badge>
                    <span className="mona-mono change-path" title={entry.path}>
                      {entry.path}
                    </span>
                    <span className="change-meta mona-muted">
                      {entry.attribution === 'tool_recorded' ? 'tool-recorded' : 'unattributed'}
                      {entry.preview === 'binary'
                        ? ' · binary'
                        : entry.preview === 'oversized'
                          ? ' · oversized'
                          : entry.preview === 'missing'
                            ? ' · missing'
                            : ''}
                    </span>
                  </button>
                );
              }}
            />
          )}

          {changes.length > shownChanges.length ? (
            <p className="mona-muted">
              Showing the first {MAX_RENDERED_PATHS.toLocaleString()} of {changes.length.toLocaleString()} changed
              paths.
            </p>
          ) : null}

          <p className="mona-muted">{view.attributionNote}</p>
          {view.skipped.length > 0 ? (
            <details className="changes-skipped">
              <summary>{view.skipped.length} path(s) were skipped by the scan</summary>
              <ul className="brief-list">
                {view.skipped.slice(0, 50).map((entry) => (
                  <li key={entry.path}>
                    <span className="mona-mono">{entry.path}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <h3>Diff{diff ? ` · ${diff.path}` : ''}</h3>
          {!selected ? (
            <p className="mona-muted">Choose a changed path to read its diff. Text diffs come from Git.</p>
          ) : diffLoading ? (
            <p className="mona-muted">Reading the diff…</p>
          ) : diffError ? (
            <ErrorState title="Diff unavailable" detail={diffError} />
          ) : diff && !diff.available ? (
            <p className="mona-muted" data-testid="diff-unavailable">
              Diff unavailable: {diff.reason ?? 'Git reported no textual baseline.'} The change list above still comes
              from the baseline comparison.
            </p>
          ) : diff ? (
            <>
              <p className="mona-muted">
                {diff.lines.toLocaleString()} line(s) · <span className="diff-added">+{diff.addedLines}</span>
                {' · '}
                <span className="diff-removed">−{diff.removedLines}</span>
                {diff.truncated ? ' · truncated by Git at the size bound' : ''}
              </p>
              {lines.length === 0 ? (
                <p className="mona-muted">Git returned an empty diff for this path.</p>
              ) : (
                <DiffLines lines={lines} path={diff.path} />
              )}
            </>
          ) : null}

          <h3>Test receipts</h3>
          {view.receipts.length === 0 ? (
            <p className="mona-muted">
              No test receipts recorded for this project. A receipt exists only when a command was actually run and its
              output stored.
            </p>
          ) : (
            <ul className="brief-list" aria-label="Test receipts">
              {view.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <div className="mona-row">
                    <Badge
                      tone={
                        receipt.outcome === 'passed'
                          ? 'success'
                          : receipt.outcome === 'failed'
                            ? 'critical'
                            : 'attention'
                      }
                    >
                      {receipt.outcome}
                    </Badge>
                    <span className="mona-mono">{receipt.command}</span>
                  </div>
                  <p className="mona-muted">
                    Exit {receipt.exitCode === null ? 'unknown' : receipt.exitCode} · {whenLabel(receipt.createdAt)}
                    {receipt.commit ? ` · ${receipt.commit.slice(0, 12)}` : ' · no commit'}
                    {receipt.durationMs === null ? '' : ` · ${receipt.durationMs} ms`}
                    {receipt.outputSha256 ? ` · output ${receipt.outputSha256.slice(0, 12)}…` : ' · no stored output'}
                    {receipt.outputTruncated ? ' (truncated)' : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function DiffLines({ lines, path }: { lines: DiffLine[]; path: string }): React.JSX.Element {
  return (
    <VirtualList
      label={`Diff for ${path}`}
      rowHeight={DIFF_ROW_HEIGHT}
      rowCount={lines.length}
      className="diff-view"
      renderRow={(index) => {
        const line = lines[index]!;
        return (
          <div className={`diff-line diff-${line.kind}`}>
            <span className="diff-number" aria-hidden="true">
              {line.index + 1}
            </span>
            <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
          </div>
        );
      }}
    />
  );
}
