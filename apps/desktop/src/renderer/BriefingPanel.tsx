import { Badge, Button, Card, EmptyState, Notification, type Tone } from '@mona/ui';
import type { DigestItem, DigestTone, ResumeBrief, SinceYouLeft } from '@mona/project-state';
import type { BriefingView } from '../shared/briefing.js';

const TONE: Record<DigestTone, Tone> = {
  info: 'info',
  success: 'success',
  attention: 'attention',
  critical: 'critical',
  neutral: 'neutral',
};

function timeLabel(at: string | null): string {
  if (!at) return 'time not recorded';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

function EvidenceLink({
  path,
  focused,
  onFocus,
}: {
  path: string;
  focused: boolean;
  onFocus: (path: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={focused ? 'evidence-link focused' : 'evidence-link'}
      onClick={() => onFocus(path)}
      title={`Focus ${path}`}
      data-testid="evidence-link"
      data-path={path}
      aria-pressed={focused}
    >
      <span className="mona-mono">{path}</span>
    </button>
  );
}

export function ResidentBrief({
  brief,
  error,
  focusedEvidence,
  onFocusEvidence,
}: {
  brief: ResumeBrief | null;
  error: string | null;
  focusedEvidence: string | null;
  onFocusEvidence: (path: string) => void;
}): React.JSX.Element {
  if (error) {
    return (
      <Card title="Resume Brief">
        <Notification tone="critical" title="Brief unavailable">
          {error}
        </Notification>
        <p className="mona-muted">The brief is built from recorded rows only. It is not guessed.</p>
      </Card>
    );
  }
  if (!brief) {
    return (
      <Card title="Resume Brief">
        <p className="mona-muted" data-testid="brief-loading">
          Reading recorded task, test, spend and workspace rows…
        </p>
      </Card>
    );
  }
  return (
    <Card title="Resume Brief">
      <div className="brief-head">
        <Badge tone="info">No model call</Badge>
        <span className="mona-muted">Generated {timeLabel(brief.generatedAt)}</span>
      </div>

      <section className="brief-block" aria-labelledby="brief-current">
        <h3 id="brief-current">Current prompt</h3>
        {brief.currentPrompt ? (
          <div className="brief-row" data-testid="brief-current">
            <div>
              <strong>{brief.currentPrompt.title}</strong>
              <p className="mona-muted">
                {brief.currentPrompt.id} · {brief.currentPrompt.status} · {brief.currentPrompt.owner}
                {brief.currentPrompt.step ? ` · at ${brief.currentPrompt.step}` : ''}
              </p>
              {brief.currentPrompt.requirementIds.length > 0 ? (
                <p className="mona-muted">Requirements: {brief.currentPrompt.requirementIds.join(', ')}</p>
              ) : null}
            </div>
            <Badge tone={brief.currentPrompt.status === 'running' ? 'info' : 'neutral'}>
              {brief.currentPrompt.status}
            </Badge>
          </div>
        ) : (
          <p className="mona-muted" data-testid="brief-current">
            No task is recorded for this project.
          </p>
        )}
      </section>

      <section className="brief-block" aria-labelledby="brief-blockers">
        <h3 id="brief-blockers">Unresolved blockers</h3>
        {brief.blockers.length === 0 ? (
          <p className="mona-muted">No blocked task or problem is recorded.</p>
        ) : (
          <ul className="brief-list">
            {brief.blockers.map((blocker) => (
              <li key={`${blocker.kind}:${blocker.id}`} className="brief-blocker">
                <div className="brief-row">
                  <strong>
                    {blocker.id} · {blocker.title}
                  </strong>
                  <Badge tone="critical">{blocker.kind}</Badge>
                </div>
                <p>{blocker.detail}</p>
                {blocker.helpNeeded ? <p className="mona-muted">Help needed: {blocker.helpNeeded}</p> : null}
                {blocker.evidencePaths.length > 0 ? (
                  <div className="brief-evidence">
                    {blocker.evidencePaths.map((path) => (
                      <EvidenceLink
                        key={path}
                        path={path}
                        focused={focusedEvidence === path}
                        onFocus={onFocusEvidence}
                      />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="brief-grid">
        <section className="brief-block" aria-labelledby="brief-test">
          <h3 id="brief-test">Last test</h3>
          {brief.lastTest ? (
            <>
              <div className="brief-row">
                <span className="mona-mono">{brief.lastTest.command}</span>
                <Badge
                  tone={
                    brief.lastTest.outcome === 'passed'
                      ? 'success'
                      : brief.lastTest.outcome === 'failed'
                        ? 'critical'
                        : 'attention'
                  }
                >
                  {brief.lastTest.outcome}
                </Badge>
              </div>
              <p className="mona-muted">{timeLabel(brief.lastTest.finishedAt ?? brief.lastTest.recordedAt)}</p>
              {brief.lastTest.outputPath ? (
                <EvidenceLink
                  path={brief.lastTest.outputPath}
                  focused={focusedEvidence === brief.lastTest.outputPath}
                  onFocus={onFocusEvidence}
                />
              ) : (
                <p className="mona-muted">No bounded output artifact was recorded for this receipt.</p>
              )}
            </>
          ) : (
            <p className="mona-muted">No test receipt is recorded.</p>
          )}
        </section>

        <section className="brief-block" aria-labelledby="brief-changes">
          <h3 id="brief-changes">Changed files</h3>
          <div className="brief-row">
            <strong data-testid="brief-changes">
              {brief.changes.count === null ? 'Unknown' : `${brief.changes.count} path(s)`}
            </strong>
            <Badge tone={brief.changes.basis === 'none' ? 'attention' : 'neutral'}>{brief.changes.basis}</Badge>
          </div>
          <p className="mona-muted">{brief.changes.detail}</p>
          {brief.changes.truncated ? <Badge tone="attention">count truncated</Badge> : null}
        </section>

        <section className="brief-block" aria-labelledby="brief-spend">
          <h3 id="brief-spend">Spend confidence</h3>
          <div className="brief-row">
            <strong data-testid="brief-spend">{brief.spend.label}</strong>
            <Badge
              tone={
                brief.spend.confidence === 'known'
                  ? 'success'
                  : brief.spend.confidence === 'none'
                    ? 'neutral'
                    : 'attention'
              }
            >
              {brief.spend.confidence}
            </Badge>
          </div>
          <p className="mona-muted">{brief.spend.records} usage record(s); unknown is not zero.</p>
        </section>
      </div>

      <section className="brief-block" aria-labelledby="brief-next">
        <h3 id="brief-next">Next step</h3>
        <p data-testid="brief-next">{brief.nextStep.text}</p>
      </section>

      <section className="brief-block" aria-labelledby="brief-progress">
        <h3 id="brief-progress">Recorded progress</h3>
        <p className="mona-muted" data-testid="brief-progress">
          {brief.progress.tasksTotal} task(s) · {brief.progress.completed} completed · {brief.progress.blocked} blocked
          · {brief.progress.verifying} verifying · {brief.progress.verifiedEvidence} fresh evidence item(s)
        </p>
        <p className="mona-muted">{brief.progress.note}</p>
      </section>

      {brief.evidence.length > 0 ? (
        <section className="brief-block" aria-labelledby="brief-evidence">
          <h3 id="brief-evidence">Evidence cards</h3>
          <div className="brief-evidence">
            {brief.evidence.map((link) => (
              <EvidenceLink
                key={link.path}
                path={link.path}
                focused={focusedEvidence === link.path}
                onFocus={onFocusEvidence}
              />
            ))}
          </div>
        </section>
      ) : null}

      <details className="brief-disclosure">
        <summary>How this brief is computed</summary>
        <ul className="mona-muted">
          {brief.disclosure.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function DigestRow({
  item,
  focusedEvidence,
  onFocusEvidence,
}: {
  item: DigestItem;
  focusedEvidence: string | null;
  onFocusEvidence: (path: string) => void;
}): React.JSX.Element {
  return (
    <li className="digest-item">
      <div className="brief-row">
        <span className="mona-muted">{timeLabel(item.at)}</span>
        <Badge tone={TONE[item.tone]}>{item.kind}</Badge>
      </div>
      <p>{item.summary}</p>
      {item.evidencePath ? (
        <EvidenceLink
          path={item.evidencePath}
          focused={focusedEvidence === item.evidencePath}
          onFocus={onFocusEvidence}
        />
      ) : null}
    </li>
  );
}

export function SinceYouLeft({
  digest,
  focusedEvidence,
  onFocusEvidence,
}: {
  digest: SinceYouLeft | null;
  focusedEvidence: string | null;
  onFocusEvidence: (path: string) => void;
}): React.JSX.Element {
  if (!digest) {
    return (
      <Card title="Since you left">
        <p className="mona-muted">Nothing has been read yet. This view makes no model request.</p>
      </Card>
    );
  }
  return (
    <Card title="Since you left">
      <p className="mona-muted" data-testid="digest-window">
        {digest.since ? `Since ${timeLabel(digest.since)}` : 'All recorded activity'} · {digest.counts.events} event(s)
        · {digest.counts.timelineItems} timeline item(s) · {digest.counts.changedFiles ?? 'unknown'} changed path(s)
      </p>
      {digest.empty ? (
        <EmptyState
          title="Nothing recorded since your last visit"
          body="No task, test, timeline or spend row was recorded in this window. Silence is reported as silence, not as success."
        />
      ) : (
        <div className="digest-groups">
          {digest.groups.map((group) => (
            <section key={group.id} className="digest-group" aria-labelledby={`digest-${group.id}`}>
              <h3 id={`digest-${group.id}`}>{group.label}</h3>
              <ul className="brief-list">
                {group.items.map((item) => (
                  <DigestRow
                    key={`${item.kind}:${item.at}:${item.summary}`}
                    item={item}
                    focusedEvidence={focusedEvidence}
                    onFocusEvidence={onFocusEvidence}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="mona-muted">{digest.note}</p>
    </Card>
  );
}

export function BriefingPanel({
  briefing,
  error,
  focusedEvidence,
  onFocusEvidence,
  onRefresh,
}: {
  briefing: BriefingView | null;
  error: string | null;
  focusedEvidence: string | null;
  onFocusEvidence: (path: string) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <section className="briefing" aria-label="Resume brief and recent activity">
      <div className="briefing-actions">
        <Button size="sm" onClick={onRefresh}>
          Refresh brief
        </Button>
        <span className="mona-muted">Built from recorded rows. Refreshing makes no model request.</span>
      </div>
      <div className="briefing-grid">
        <ResidentBrief
          brief={briefing?.resume ?? null}
          error={error}
          focusedEvidence={focusedEvidence}
          onFocusEvidence={onFocusEvidence}
        />
        <SinceYouLeft
          digest={briefing?.since ?? null}
          focusedEvidence={focusedEvidence}
          onFocusEvidence={onFocusEvidence}
        />
      </div>
    </section>
  );
}
