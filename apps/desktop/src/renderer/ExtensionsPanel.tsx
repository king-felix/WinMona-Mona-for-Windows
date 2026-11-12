import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Notification, type Tone } from '@mona/ui';
import type { ExtensionsView, McpHealthView, McpServerEntry, PluginEntry, SkillEntry } from '@mona/contracts';
import type { CatalogProject } from '../shared/catalog.js';

function originLabel(origin: McpServerEntry['origin']): string {
  if (origin === 'global') return 'Global';
  if (origin === 'project') return 'Project';
  return 'Unknown scope';
}

export function ExtensionsPanel({ project }: { project: CatalogProject | null }): React.JSX.Element {
  const [view, setView] = useState<ExtensionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, McpHealthView>>({});

  const load = useCallback(async (): Promise<void> => {
    if (!project) {
      setView(null);
      return;
    }
    setError(null);
    const result = await window.mona.extensionsGet({ projectId: project.id });
    if (result.ok) setView(result.data);
    else setError(result.error.message);
  }, [project?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setEnabled(server: McpServerEntry, enabled: boolean): Promise<void> {
    if (!project || !view?.mcp.revision) return;
    setBusy(`toggle:${server.name}`);
    try {
      const result = await window.mona.extensionsSetMcp({
        projectId: project.id,
        name: server.name,
        enabled,
        expectedRevision: view.mcp.revision,
      });
      if (result.ok) {
        setNotice({
          tone: result.data.verified ? 'success' : 'attention',
          title: result.data.verified ? `${server.name} ${enabled ? 'enabled' : 'disabled'}` : 'Change not confirmed',
          body: result.data.detail,
        });
      } else {
        setNotice({ tone: 'critical', title: 'MCP change refused', body: result.error.message });
      }
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function checkHealth(server: McpServerEntry): Promise<void> {
    if (!project || !view?.mcp.revision) return;
    setBusy(`health:${server.name}`);
    try {
      const result = await window.mona.extensionsCheckMcp({
        projectId: project.id,
        name: server.name,
        expectedRevision: view.mcp.revision,
      });
      if (result.ok) {
        setHealth((current) => ({ ...current, [server.name]: result.data }));
      } else {
        setNotice({ tone: 'critical', title: 'Health check failed', body: result.error.message });
      }
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!project) {
    return (
      <Card title="Extensions">
        <EmptyState
          title="No project open"
          body="Open a project to inspect MCP servers, skills, plugins, hooks and rules."
        />
      </Card>
    );
  }

  return (
    <Card title="Extensions">
      <p className="mona-muted">
        Mona reads the engine’s own extension inventory. Opening this page does not connect an MCP server, approve a
        hook, or send tool descriptions to the model.
      </p>
      {notice ? (
        <Notification tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notification>
      ) : null}
      {error ? (
        <Notification tone="critical" title="Extensions unavailable">
          {error}
        </Notification>
      ) : null}
      {view ? (
        <>
          <div className="facts">
            <div>
              <span className="fact-label">Engine</span>
              <span className="fact-value" data-testid="extensions-engine">
                {view.connected ? 'connected' : view.engineState}
              </span>
            </div>
            <div>
              <span className="fact-label">Workspace</span>
              <span className="fact-value mona-mono">{view.workspace ?? 'unknown'}</span>
            </div>
            <div>
              <span className="fact-label">MCP</span>
              <span className="fact-value" data-testid="extensions-count-mcp">
                {view.counts.mcpServers} configured · {view.counts.mcpEnabled} enabled
              </span>
            </div>
            <div>
              <span className="fact-label">Skills / plugins / hooks</span>
              <span className="fact-value">
                {view.counts.skills} / {view.counts.plugins} / {view.counts.hooks}
              </span>
            </div>
            <div>
              <span className="fact-label">Instructions loaded</span>
              <span className="fact-value">{view.counts.instructionsLoaded}</span>
            </div>
          </div>

          {view.caveats.map((caveat) => (
            <p className="mona-muted" key={caveat} data-testid="extensions-caveat">
              {caveat}
            </p>
          ))}

          <section aria-labelledby="extension-scopes">
            <h3 id="extension-scopes">What each scope affects</h3>
            <ul className="agent-tree">
              {view.scopes.map((scope) => (
                <li key={scope.id}>
                  <div className="agent-row">
                    <Badge tone="info">{scope.label}</Badge>
                  </div>
                  <p className="agent-event">{scope.detail}</p>
                </li>
              ))}
            </ul>
          </section>

          <McpSectionView view={view} busy={busy} health={health} onToggle={setEnabled} onCheck={checkHealth} />
          <SkillsView section={view.skills} />
          <PluginsView section={view.plugins} />
          <HooksView section={view.hooks} />
          <InstructionsView section={view.instructions} />
        </>
      ) : (
        <EmptyState title="Reading extensions" body="No engine extension inventory has been read yet." />
      )}
    </Card>
  );
}

function McpSectionView({
  view,
  busy,
  health,
  onToggle,
  onCheck,
}: {
  view: ExtensionsView;
  busy: string | null;
  health: Record<string, McpHealthView>;
  onToggle: (server: McpServerEntry, enabled: boolean) => Promise<void>;
  onCheck: (server: McpServerEntry) => Promise<void>;
}): React.JSX.Element {
  const section = view.mcp;
  const canWrite = Boolean(section.revision) && view.connected;
  return (
    <section aria-labelledby="extension-mcp">
      <h3 id="extension-mcp">MCP servers</h3>
      {section.status === 'unavailable' ? (
        <Notification tone="attention" title="MCP inventory unavailable">
          {section.note ?? 'The engine did not report MCP servers.'}
        </Notification>
      ) : section.servers.length === 0 ? (
        <p className="mona-muted" data-testid="mcp-empty">
          No MCP servers are configured. Add one through the engine’s own command; Mona will list it here.
        </p>
      ) : (
        <ul className="agent-tree">
          {section.servers.map((server) => {
            const result = health[server.name];
            return (
              <li key={server.name} data-testid={`mcp-server-${server.name}`}>
                <div className="agent-row">
                  <Badge tone={server.enabled ? 'success' : 'info'}>{server.enabled ? 'enabled' : 'disabled'}</Badge>
                  <Badge tone={server.connected ? 'success' : 'attention'}>
                    {server.connected ? 'connected' : 'not connected'}
                  </Badge>
                  <strong>{server.name}</strong>
                  <span className="mona-muted">{originLabel(server.origin)}</span>
                  {server.required ? <Badge tone="attention">required</Badge> : null}
                  {server.authRequired ? <Badge tone="info">auth</Badge> : null}
                </div>
                <p className="agent-event mona-mono">
                  {server.transport} · {server.command ?? server.url ?? 'no command reported'}
                  {server.argumentCount > 0 ? ` · ${server.argumentCount} argument(s)` : ''}
                </p>
                {server.envKeys.length > 0 ? (
                  <p className="agent-event">Environment keys reported by name only: {server.envKeys.join(', ')}</p>
                ) : null}
                {server.scopes.length > 0 ? <p className="agent-event">Scopes: {server.scopes.join(', ')}</p> : null}
                {server.detailNote ? <p className="agent-event mona-muted">{server.detailNote}</p> : null}
                <div className="mona-row">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canWrite || busy === `health:${server.name}`}
                    onClick={() => void onCheck(server)}
                  >
                    Check health
                  </Button>
                  <Button
                    size="sm"
                    variant={server.enabled ? 'secondary' : 'primary'}
                    disabled={!canWrite || busy === `toggle:${server.name}` || (server.required && server.enabled)}
                    {...(server.required && server.enabled
                      ? { title: 'This server is marked required and cannot be disabled here.' }
                      : {})}
                    onClick={() => void onToggle(server, !server.enabled)}
                  >
                    {server.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </div>
                {result ? (
                  <div className="agent-event" data-testid={`mcp-health-${server.name}`}>
                    <Badge tone={result.connected ? 'success' : 'critical'}>
                      {result.connected ? 'healthy' : 'unreachable'}
                    </Badge>{' '}
                    {result.error ? <span>{result.error}</span> : <span>{result.tools.length} tool(s) reported.</span>}
                    {result.tools.length > 0 ? (
                      <p className="mona-mono">{result.tools.map((tool) => tool.prefixedName).join(', ')}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mona-muted">
        Revision <span className="mona-mono">{section.revision ?? 'unavailable'}</span>. Enable and disable are sent to
        the engine with this revision; a stale edit is refused rather than overwritten.
      </p>
      <details>
        <summary>Advanced MCP actions</summary>
        <p className="mona-muted">
          Adding or removing a server uses the engine’s own command, for example{' '}
          <code>codewhale mcp add &lt;name&gt; --command &lt;executable&gt;</code> and{' '}
          <code>codewhale mcp remove &lt;name&gt;</code>. Mona never assembles that command from remote content.
        </p>
      </details>
    </section>
  );
}

function SkillsView({ section }: { section: ExtensionsView['skills'] }): React.JSX.Element {
  return (
    <section aria-labelledby="extension-skills">
      <h3 id="extension-skills">Skills</h3>
      {section.status === 'unavailable' ? (
        <Notification tone="attention" title="Skill inventory unavailable">
          {section.note}
        </Notification>
      ) : (
        <>
          <p className="mona-muted">
            {section.skills.length} skill(s) reported. Skill bodies stay on disk until the engine loads one for a turn.
          </p>
          {section.warnings.length > 0 ? (
            <details>
              <summary>{section.warnings.length} shadowed-skill warning(s)</summary>
              <ul>
                {section.warnings.slice(0, 20).map((warning) => (
                  <li key={warning} className="agent-event">
                    {warning}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <details>
            <summary>All skills ({section.skills.length})</summary>
            <ul className="agent-tree">
              {section.skills.map((skill) => (
                <SkillRow key={`${skill.path}:${skill.name}`} skill={skill} />
              ))}
            </ul>
          </details>
          <p className="mona-muted">
            Install, update and trust stay with the engine’s reviewed routes. Mona shows the engine’s state and does not
            approve downloaded content.
          </p>
        </>
      )}
    </section>
  );
}

function SkillRow({ skill }: { skill: SkillEntry }): React.JSX.Element {
  return (
    <li>
      <div className="agent-row">
        <Badge tone={skill.enabled ? 'success' : 'info'}>{skill.enabled ? 'enabled' : 'disabled'}</Badge>
        <strong>{skill.name}</strong>
        <span className="mona-muted">
          {skill.source}
          {skill.bundled ? ' · bundled' : ''}
          {skill.bundledTier ? ` · ${skill.bundledTier}` : ''}
        </span>
        {skill.pluginId ? <Badge tone="info">plugin {skill.pluginId}</Badge> : null}
      </div>
      <p className="agent-event">{skill.description || 'No description reported.'}</p>
      <p className="agent-event mona-mono">
        {skill.invocation}
        {skill.aliases.length > 0 ? ` · aliases: ${skill.aliases.join(', ')}` : ''}
      </p>
      <p className="agent-event mona-muted mona-mono">{skill.path}</p>
    </li>
  );
}

function PluginsView({ section }: { section: ExtensionsView['plugins'] }): React.JSX.Element {
  return (
    <section aria-labelledby="extension-plugins">
      <h3 id="extension-plugins">Plugins</h3>
      {section.status === 'unavailable' ? (
        <Notification tone="attention" title="Plugin inventory unavailable">
          {section.note}
        </Notification>
      ) : section.plugins.length === 0 ? (
        <p className="mona-muted">No plugins are installed or bundled.</p>
      ) : (
        <ul className="agent-tree">
          {section.plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} />
          ))}
        </ul>
      )}
      {section.registryDiagnostics.length > 0 ? (
        <details>
          <summary>Registry diagnostics ({section.registryDiagnostics.length})</summary>
          <ul>
            {section.registryDiagnostics.map((diagnostic) => (
              <li key={diagnostic} className="agent-event">
                {diagnostic}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mona-muted">
        A plugin runs its skills, MCP servers and hooks only after the engine’s review. Install and trust remain engine
        actions with their own consent step.
      </p>
    </section>
  );
}

function PluginRow({ plugin }: { plugin: PluginEntry }): React.JSX.Element {
  return (
    <li data-testid={`plugin-${plugin.name}`}>
      <div className="agent-row">
        <Badge tone={plugin.active ? 'success' : plugin.enabled ? 'attention' : 'info'}>
          {plugin.active ? 'active' : plugin.state}
        </Badge>
        <strong>{plugin.displayName}</strong>
        <span className="mona-muted">
          {plugin.version} · {plugin.scope} · {plugin.trustStatus}
        </span>
        {plugin.compatibility !== 'full' ? <Badge tone="attention">{plugin.compatibility}</Badge> : null}
      </div>
      <p className="agent-event">{plugin.description}</p>
      <p className="agent-event">
        Inventory: {plugin.inventory.skills} skill(s), {plugin.inventory.mcpServers} MCP server(s),{' '}
        {plugin.inventory.commands} command(s), {plugin.inventory.hooks} hook(s)
        {plugin.inventory.lifecycleMutation ? ' · lifecycle mutation declared' : ''}
      </p>
      {plugin.platforms.length > 0 ? (
        <p className="agent-event mona-muted">Reported platforms: {plugin.platforms.join(', ')}</p>
      ) : null}
      {plugin.diagnostics.length > 0 ? <p className="agent-event">{plugin.diagnostics.join(' ')}</p> : null}
      {plugin.homepage ? (
        <p className="agent-event mona-mono">
          Source: {plugin.homepage} · content {plugin.contentHash?.slice(0, 16) ?? 'unknown'}
        </p>
      ) : null}
    </li>
  );
}

function HooksView({ section }: { section: ExtensionsView['hooks'] }): React.JSX.Element {
  return (
    <section aria-labelledby="extension-hooks">
      <h3 id="extension-hooks">Hooks</h3>
      {section.status === 'unavailable' ? (
        <Notification tone="attention" title="Hook inventory unavailable">
          {section.note}
        </Notification>
      ) : (
        <>
          <p>
            <Badge tone={section.enabled ? 'success' : 'info'}>
              {section.enabled ? 'hooks enabled' : 'hooks disabled'}
            </Badge>{' '}
            <span className="mona-muted">
              Hook commands are shown with credential-shaped values redacted. Mona does not execute or edit them.
            </span>
          </p>
          {section.hooks.length === 0 ? (
            <p className="mona-muted">No hooks are configured.</p>
          ) : (
            <ul className="agent-tree">
              {section.hooks.map((hook) => (
                <li key={`${hook.source}:${hook.name}:${hook.event}`}>
                  <div className="agent-row">
                    <Badge tone="info">{hook.event}</Badge>
                    <strong>{hook.name}</strong>
                    <span className="mona-muted">{hook.source}</span>
                  </div>
                  <p className="agent-event mona-mono">{hook.command || 'no command reported'}</p>
                  <p className="agent-event mona-muted">
                    {hook.background ? 'background' : 'foreground'}
                    {hook.timeoutSecs === null ? '' : ` · timeout ${hook.timeoutSecs}s`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {section.problems.length > 0 ? (
            <NotificationsList title="Hook configuration problems" items={section.problems} />
          ) : null}
          <p className="mona-muted">
            Project hooks run only after the engine reviews and approves their exact bytes. Use the engine’s{' '}
            <code>/hooks review</code> and <code>/hooks approve &lt;digest&gt;</code> flow; Mona never approves them.
          </p>
        </>
      )}
    </section>
  );
}

function InstructionsView({ section }: { section: ExtensionsView['instructions'] }): React.JSX.Element {
  return (
    <section aria-labelledby="extension-instructions">
      <h3 id="extension-instructions">Rules and instructions</h3>
      {section.status === 'unavailable' ? (
        <Notification tone="attention" title="Instruction sources unavailable">
          {section.note}
        </Notification>
      ) : (
        <>
          <p className="mona-muted">
            These are the files the engine reports for this workspace. A missing file loads nothing; imported
            instructions stay inert until the engine selects them.
          </p>
          <ul className="agent-tree">
            {section.sources.map((source) => (
              <li key={`${source.kind}:${source.path}`} data-testid={`instruction-${source.kind}-${source.status}`}>
                <div className="agent-row">
                  <Badge tone={source.exists ? 'success' : 'info'}>{source.status}</Badge>
                  <strong>{source.relativePath ?? source.path}</strong>
                  <span className="mona-muted">{source.kind}</span>
                </div>
                <p className="agent-event mona-mono">{source.exists ? `${source.bytes ?? 0} bytes` : 'not present'}</p>
                {source.warning ? <p className="agent-event">{source.warning}</p> : null}
              </li>
            ))}
          </ul>
          <p className="mona-muted">
            Aggregate budget {section.aggregateBudgetBytes.toLocaleString()} bytes
            {section.generatedFallback ? ' · engine generated a fallback instruction block' : ''}.
          </p>
          {section.warnings.length > 0 ? (
            <NotificationsList title="Instruction warnings" items={section.warnings} />
          ) : null}
          {section.foreignImports.length > 0 ? (
            <details>
              <summary>Imported instruction files ({section.foreignImports.length})</summary>
              <ul>
                {section.foreignImports.map((path) => (
                  <li key={path} className="agent-event mona-mono">
                    {path}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function NotificationsList({ title, items }: { title: string; items: string[] }): React.JSX.Element {
  return (
    <details>
      <summary>
        {title} ({items.length})
      </summary>
      <ul>
        {items.map((item) => (
          <li key={item} className="agent-event">
            {item}
          </li>
        ))}
      </ul>
    </details>
  );
}
