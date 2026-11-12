import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Inspector,
  Notification,
  Select,
  Skeleton,
} from '../primitives.js';
import { Dialog, Menu, Tabs } from '../overlay.js';
import { HARNESS_LABEL, fixtures } from './fixtures.js';

function Screen({ id, title, children }: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mona-screen" aria-labelledby={`${id}-title`} data-screen={id}>
      <header className="mona-screen-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <Badge tone="attention">fixtures</Badge>
      </header>
      {children}
    </section>
  );
}

export function HomeScreen(): React.JSX.Element {
  return (
    <Screen id="home" title="Home">
      <div className="mona-grid-2">
        <Card title="Resume">
          <p className="mona-mono mona-truncate" title={fixtures.project.path}>
            {fixtures.project.path}
          </p>
          <div className="mona-row">
            <Button variant="primary">Open project</Button>
            <Button>Choose a folder…</Button>
          </div>
          <p className="mona-muted">Browsing requires no API key and makes no request.</p>
        </Card>
        <Card title="Needs attention">
          <Notification tone="attention" title="Runtime is not running">
            Opening a project starts one owned runtime. Mona is idle now.
          </Notification>
          <Notification tone="critical" title="Cost unknown for the last turn">
            Usage arrived without complete pricing. Unknown is shown as unknown, never as zero.
          </Notification>
        </Card>
      </div>
    </Screen>
  );
}

export function ProjectStudioScreen(): React.JSX.Element {
  const [tab, setTab] = useState('timeline');
  return (
    <Screen id="studio" title="Project studio">
      <div className="mona-grid-2">
        <Card title={fixtures.project.name}>
          <div className="mona-row">
            <Badge tone="success">connected</Badge>
            <Badge tone="info">{fixtures.project.model}</Badge>
            <Badge tone="attention">{fixtures.project.permission}</Badge>
            <Badge>{fixtures.project.branch}</Badge>
          </div>
          <p className="mona-mono mona-truncate" title={fixtures.project.path}>
            {fixtures.project.path}
          </p>
          <Tabs
            label="Project panels"
            activeId={tab}
            onSelect={setTab}
            items={[
              {
                id: 'timeline',
                label: 'Timeline',
                panel: (
                  <ul className="mona-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {fixtures.events.map((event) => (
                      <li key={event.at} className="mona-row" style={{ justifyContent: 'space-between' }}>
                        <span className="mona-mono">{event.at}</span>
                        <span style={{ flex: 1 }}>{event.text}</span>
                        <Badge>{event.kind}</Badge>
                      </li>
                    ))}
                  </ul>
                ),
              },
              {
                id: 'changes',
                label: 'Changes',
                panel: (
                  <EmptyState
                    title="Changes unavailable"
                    body="The runtime is not connected, so no diff exists. This is not the same as 'no changes'."
                  />
                ),
              },
              { id: 'tests', label: 'Tests', panel: <Skeleton label="Reading test output…" /> },
            ]}
          />
        </Card>
        <Inspector title="Inspector">
          <div className="mona-stack">
            <span className="mona-muted">Current task</span>
            <strong>{fixtures.tasks[1]?.title}</strong>
            <span className="mona-muted">Spend</span>
            <span>{fixtures.project.spend}</span>
            <span className="mona-muted">Submissions</span>
            <span>1 accepted · 0 unknown</span>
            <Button variant="danger">Interrupt now</Button>
            <p className="mona-muted">Interrupt is an engine call with a receipt; it never claims rollback.</p>
          </div>
        </Inspector>
      </div>
      <ControlsRow />
    </Screen>
  );
}

function ControlsRow(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="mona-row">
      <Button>Pause after task</Button>
      <Button variant="primary">Interrupt now</Button>
      <Button>Cancel queued</Button>
      <Button onClick={() => setDialogOpen(true)}>Quit and stop work…</Button>
      <Menu
        label="Queue actions"
        items={[
          { id: 'pause', label: 'Pause after task', hint: 'queue boundary' },
          { id: 'cancel', label: 'Cancel queued', hint: 'future starts only' },
          { id: 'quit', label: 'Quit and stop work', hint: 'interrupt then stop' },
        ]}
      />
      <Dialog
        open={dialogOpen}
        title="Quit and stop owned work?"
        onClose={() => setDialogOpen(false)}
        actions={
          <>
            <Button onClick={() => setDialogOpen(false)}>Keep working</Button>
            <Button variant="danger" onClick={() => setDialogOpen(false)}>
              Quit and stop
            </Button>
          </>
        }
      >
        <p>
          Mona interrupts the running turn, then stops the runtime it owns. Work already sent to the engine is not
          rolled back.
        </p>
      </Dialog>
    </div>
  );
}

export function WorkBoardScreen(): React.JSX.Element {
  return (
    <Screen id="work" title="Work board">
      <div className="mona-grid-2">
        {fixtures.tasks.map((task) => (
          <Card key={task.id} title={`${task.id} · ${task.title}`}>
            <div className="mona-row">
              <Badge tone={task.status === 'running' ? 'info' : task.status === 'verifying' ? 'success' : 'neutral'}>
                {task.status}
              </Badge>
            </div>
            <p className="mona-muted">{task.note}</p>
          </Card>
        ))}
        <Card title="Blocked">
          <ErrorState
            title="P05-ISSUE-002 — 2 of 3 attempts"
            detail={fixtures.blocker.help}
            action={<Button>Open evidence</Button>}
          />
        </Card>
      </div>
    </Screen>
  );
}

export function CostLensScreen(): React.JSX.Element {
  return (
    <Screen id="cost" title="Cost lens">
      <div className="mona-grid-2">
        <Card title="This turn">
          <p style={{ fontSize: 'var(--text-xl)', margin: 0 }}>{fixtures.cost.known}</p>
          <div className="mona-stack">
            {fixtures.cost.buckets.map((bucket) => (
              <div key={bucket.label} className="mona-row" style={{ justifyContent: 'space-between' }}>
                <span className="mona-muted">{bucket.label}</span>
                <span className="mona-mono">{bucket.value}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Previous turn">
          <Badge tone="attention">unknown</Badge>
          <p>{fixtures.cost.unknownLabel}</p>
          <p className="mona-muted">Unknown cost is never displayed as $0.00.</p>
        </Card>
      </div>
    </Screen>
  );
}

export function BlockerCardScreen(): React.JSX.Element {
  return (
    <Screen id="blocker" title="Blocker card">
      <Card title={fixtures.blocker.id}>
        <p style={{ margin: 0 }}>{fixtures.blocker.title}</p>
        <div className="mona-row">
          <Badge tone="critical">blocked</Badge>
          <Badge tone="attention">{`${fixtures.blocker.attempts} of 3 attempts`}</Badge>
          <Badge tone="info">{fixtures.blocker.requirement}</Badge>
        </div>
        <p className="mona-muted">Help needed: {fixtures.blocker.help}</p>
        <div className="mona-row">
          <Button variant="primary">Open evidence</Button>
          <Button>Copy blocker summary</Button>
        </div>
        <p className="mona-mono mona-truncate">{fixtures.blocker.evidence}</p>
      </Card>
    </Screen>
  );
}

export function SettingsScreen(): React.JSX.Element {
  return (
    <Screen id="settings" title="Settings">
      <div className="mona-grid-2">
        <Card title="Route">
          <Field
            label="Provider"
            value={fixtures.settings.provider}
            hint="Engine credential management stays authoritative."
          />
          <Field label="Endpoint" value={fixtures.settings.endpoint} />
          <Select
            label="Model"
            value={fixtures.settings.model}
            options={[
              { value: 'deepseek-flash', label: 'deepseek-flash (default)' },
              { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
            ]}
            hint="Requested and effective values are shown separately when they differ."
          />
        </Card>
        <Card title="Permission and privacy">
          <Field
            label="Posture"
            value={fixtures.settings.posture}
            disabled
            hint="Full Access is an agent preference, not renderer authority."
          />
          <Field label="Telemetry" value={fixtures.settings.telemetry} disabled />
          <Notification tone="success" title="No Mona telemetry">
            Diagnostics are local and redacted by default.
          </Notification>
        </Card>
      </div>
    </Screen>
  );
}

/** The labelled harness. Every screen here is fixture data, never live state. */
export function Harness(): React.JSX.Element {
  return (
    <div className="mona-harness" data-testid="harness">
      <div className="mona-harness-banner" role="note" data-testid="harness-banner">
        <Badge tone="attention">development</Badge>
        {HARNESS_LABEL}
      </div>
      <HomeScreen />
      <ProjectStudioScreen />
      <WorkBoardScreen />
      <CostLensScreen />
      <BlockerCardScreen />
      <SettingsScreen />
      <Screen id="states" title="Non-happy states">
        <div className="mona-grid-2">
          <EmptyState title="No delegated work" body="Agent children appear only when the engine reports them." />
          <EmptyState title="Choose a folder to begin" body="Nothing is inferred from an empty catalog." />
          <Skeleton label="Connecting to the runtime…" />
          <ErrorState
            title="Engine unavailable"
            detail="Codewhale executable was not found at the configured path."
            action={<Button>Choose executable…</Button>}
          />
          <Notification tone="critical" title="Runtime crashed">
            The owned runtime exited (code 7). Restart is bounded; no work is resubmitted automatically.
          </Notification>
          <Notification tone="attention" title="Outcome unknown">
            The submission may have reached the engine. Reconcile before retrying.
          </Notification>
        </div>
      </Screen>
    </div>
  );
}

export type HarnessScreenId = 'home' | 'studio' | 'work' | 'cost' | 'blocker' | 'settings' | 'states';

export function HarnessScreen({ id }: { id: HarnessScreenId }): React.JSX.Element {
  switch (id) {
    case 'home':
      return <HomeScreen />;
    case 'studio':
      return <ProjectStudioScreen />;
    case 'work':
      return <WorkBoardScreen />;
    case 'cost':
      return <CostLensScreen />;
    case 'blocker':
      return <BlockerCardScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'states':
    default:
      return <Harness />;
  }
}
