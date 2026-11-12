// P17 extension probe. Isolated CODEWHALE_HOME and workspace; a real stdio MCP
// fixture; no turn and no provider request. It proves listing, provenance,
// health, enable/disable with If-Match, stale-edit refusal, redaction, and that
// unrelated MCP configuration survives a change.
// Usage: node tools/spike/p17-extensions.mjs [--out <path>]

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HttpTransport } from '../../packages/adapter/dist/http.js';
import { EngineExtensions } from '../../packages/adapter/dist/extensions.js';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const root = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Temp',
  'mona-p17-extensions',
  String(Date.now()),
);
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const secret = `fixture-secret-${Date.now()}`;
const fixtureServer = join(process.cwd(), 'tests', 'fixtures', 'mcp', 'echo-server.mjs');

await mkdir(join(home, 'skills', 'local-note'), { recursive: true });
await mkdir(join(workspace, '.codewhale'), { recursive: true });
await writeFile(
  join(home, 'config.toml'),
  'provider = "deepseek"\nmodel = "deepseek-flash"\n\n[providers.deepseek]\nbase_url = "https://api.deepseek.com"\n',
  'utf8',
);

const mcpBefore = {
  servers: {
    'fixture-echo': {
      command: process.execPath,
      args: [fixtureServer],
      env: {},
      url: null,
      disabled: false,
      enabled: true,
      required: false,
      enabled_tools: [],
      disabled_tools: [],
      x_mona_note: 'keep-this-unknown-server-key',
    },
    'missing-exec': {
      command: 'C:\\nonexistent\\mona-p17-fixture.exe',
      args: [],
      env: { FIXTURE_TOKEN: secret },
      url: null,
      disabled: false,
      enabled: true,
      required: false,
      enabled_tools: [],
      disabled_tools: [],
    },
  },
  x_mona_top_level: { keep: true, note: 'preserve unknown keys' },
};
await writeFile(join(home, 'mcp.json'), `${JSON.stringify(mcpBefore, null, 2)}\n`, 'utf8');
await writeFile(
  join(workspace, '.codewhale', 'mcp.json'),
  `${JSON.stringify(
    {
      servers: {
        'project-only': {
          command: process.execPath,
          args: [fixtureServer],
          env: {},
          enabled: true,
        },
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
await writeFile(
  join(workspace, '.codewhale', 'hooks.toml'),
  [
    '# Harmless project hook used to verify that unapproved project hooks stay inert.',
    '[[hooks]]',
    'name = "fixture noop"',
    'event = "session_start"',
    'command = "node -e \\"process.exit(0)\\""',
    'timeout_secs = 5',
    '',
  ].join('\n'),
  'utf8',
);
await writeFile(join(workspace, 'AGENTS.md'), '# P17 fixture instructions\n\nMona probe only.\n', 'utf8');
await writeFile(
  join(home, 'skills', 'local-note', 'SKILL.md'),
  '---\nname: local-note\ndescription: A harmless local fixture skill for P17.\n---\n\nReturn nothing.\n',
  'utf8',
);

const token = makeToken();
process.env.CODEWHALE_HOME = home;
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7922, token });
const inner = new HttpTransport({ baseUrl: runtime.baseUrl, token });

class RecordingTransport {
  constructor(transport) {
    this.transport = transport;
    this.calls = [];
  }
  json(method, path, body, options) {
    this.calls.push(`${method} ${path}${options?.headers ? ` [${Object.keys(options.headers).join(',')}]` : ''}`);
    return this.transport.json(method, path, body, options);
  }
  stream(path, options) {
    return this.transport.stream(path, options);
  }
}

const recording = new RecordingTransport(inner);
const extensions = new EngineExtensions(recording, () => new Date());
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine: { command: ENGINE, root, home, workspace },
  checks: [],
};
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}
function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}
function usageKey(usage) {
  const totals = usage?.totals ?? {};
  return {
    turns: totals.turns ?? null,
    input_tokens: totals.input_tokens ?? null,
    output_tokens: totals.output_tokens ?? null,
    cost_usd: totals.cost_usd ?? null,
  };
}

try {
  const usageBefore = await api.usage();
  report.usage_before = usageKey(usageBefore);

  const snapshot = await extensions.snapshot(workspace);
  if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.error.message}`);
  const view = snapshot.value;
  report.snapshot = view;
  report.snapshot_calls = recording.calls;
  check('snapshot reports MCP servers with a revision', view.mcp.status === 'ok' && Boolean(view.mcp.revision), {
    revision: view.mcp.revision,
    servers: view.mcp.servers.map((server) => server.name),
  });
  check(
    'snapshot did not request the tool catalog or connect a server',
    !recording.calls.some((call) => call.includes('/v1/apps/mcp/tools')) &&
      !recording.calls.some((call) => call.includes('/reconnect')),
    { calls: recording.calls.length },
  );
  check(
    'global and project scope are reported honestly',
    view.mcp.servers.every((server) => server.origin === 'global') &&
      !view.mcp.servers.some((server) => server.name === 'project-only'),
    { origins: view.mcp.servers.map((server) => `${server.name}:${server.origin}`) },
  );
  check(
    'MCP environment values are reported as key names only',
    JSON.stringify(view.mcp).includes('FIXTURE_TOKEN') && !JSON.stringify(view.mcp).includes(secret),
    {
      missing_server_env_keys: view.mcp.servers.find((server) => server.name === 'missing-exec')?.envKeys,
    },
  );
  check(
    'custom skill is listed with provenance',
    view.skills.status === 'ok' && view.skills.skills.some((skill) => skill.name === 'local-note'),
    {
      skills: view.skills.skills.length,
      local_note: view.skills.skills.find((skill) => skill.name === 'local-note'),
    },
  );
  check(
    'project instructions are reported as loaded',
    view.instructions.status === 'ok' &&
      view.instructions.sources.some((source) => source.relativePath === 'AGENTS.md' && source.status === 'loaded'),
    {
      loaded: view.instructions.sources.filter((source) => source.status === 'loaded').map((source) => source.path),
    },
  );
  check('project hooks are not approved implicitly', view.hooks.status === 'ok' && view.hooks.enabled === false, {
    enabled: view.hooks.enabled,
    hooks: view.hooks.hooks,
    problems: view.hooks.problems,
  });

  const health = await extensions.checkMcpHealth({
    name: 'fixture-echo',
    expectedRevision: view.mcp.revision,
  });
  if (!health.ok) throw new Error(`health failed: ${health.error.message}`);
  report.health_fixture = health.value;
  check(
    'fixture MCP server connects and reports its tool',
    health.value.connected && health.value.tools.some((tool) => tool.name === 'echo_text'),
    {
      connected: health.value.connected,
      tools: health.value.tools,
    },
  );

  const revisionAfterHealth = health.value.revision ?? view.mcp.revision;
  const missingHealth = await extensions.checkMcpHealth({
    name: 'missing-exec',
    expectedRevision: revisionAfterHealth,
  });
  if (!missingHealth.ok) throw new Error(`missing health failed: ${missingHealth.error.message}`);
  report.health_missing = missingHealth.value;
  check(
    'missing executable fails with an actionable redacted error',
    missingHealth.value.connected === false &&
      /spawn failed|not found|failed/i.test(missingHealth.value.error ?? '') &&
      !JSON.stringify(missingHealth.value).includes(secret),
    {
      connected: missingHealth.value.connected,
      error: missingHealth.value.error,
    },
  );

  const beforeState = await extensions.snapshot(workspace);
  if (!beforeState.ok) throw new Error('re-read failed');
  const revisionBeforeDisable = beforeState.value.mcp.revision;
  const disabled = await extensions.setMcpEnabled({
    name: 'fixture-echo',
    enabled: false,
    expectedRevision: revisionBeforeDisable,
  });
  if (!disabled.ok) throw new Error(`disable failed: ${disabled.error.message}`);
  report.disable_receipt = disabled.value;
  check('disable is verified by reading the server back', disabled.value.verified && disabled.value.enabled === false, {
    receipt: disabled.value,
  });

  const afterDisable = await extensions.snapshot(workspace);
  if (!afterDisable.ok) throw new Error('post-disable read failed');
  report.after_disable = afterDisable.value.mcp;
  check(
    'only the intended server changed',
    afterDisable.value.mcp.servers.find((server) => server.name === 'fixture-echo')?.enabled === false &&
      afterDisable.value.mcp.servers.some((server) => server.name === 'missing-exec'),
    {
      servers: afterDisable.value.mcp.servers.map((server) => `${server.name}:${server.enabled}`),
    },
  );

  const mcpAfterText = await readFile(join(home, 'mcp.json'), 'utf8');
  const mcpAfter = JSON.parse(mcpAfterText);
  report.mcp_file_before_hash = hash(JSON.stringify(mcpBefore));
  report.mcp_file_after_hash = hash(JSON.stringify(mcpAfter));
  check(
    'unrelated server and secret survive the edit',
    mcpAfter.servers?.['missing-exec']?.env?.FIXTURE_TOKEN === secret,
    {
      missing_exec_present: Boolean(mcpAfter.servers?.['missing-exec']),
    },
  );
  check(
    'unknown top-level configuration keys are preserved',
    JSON.stringify(mcpAfter.x_mona_top_level) === JSON.stringify(mcpBefore.x_mona_top_level),
    {
      value: mcpAfter.x_mona_top_level,
    },
  );
  check(
    'unknown server-level keys are preserved',
    mcpAfter.servers?.['fixture-echo']?.x_mona_note === 'keep-this-unknown-server-key',
    { value: mcpAfter.servers?.['fixture-echo']?.x_mona_note },
  );

  const staleRevision = revisionBeforeDisable;
  const stale = await extensions.setMcpEnabled({
    name: 'fixture-echo',
    enabled: true,
    expectedRevision: staleRevision,
  });
  report.stale_attempt = stale.ok ? { ok: true, value: stale.value } : { ok: false, error: stale.error };
  check('a stale revision is refused', !stale.ok && stale.error.code === 'conflict', {
    code: stale.ok ? null : stale.error.code,
    message: stale.ok ? null : stale.error.message,
  });

  const afterStale = await extensions.snapshot(workspace);
  if (!afterStale.ok) throw new Error('post-stale read failed');
  check(
    'a refused stale edit leaves the server disabled',
    afterStale.value.mcp.servers.find((server) => server.name === 'fixture-echo')?.enabled === false,
    {
      servers: afterStale.value.mcp.servers.map((server) => `${server.name}:${server.enabled}`),
    },
  );

  const reenabled = await extensions.setMcpEnabled({
    name: 'fixture-echo',
    enabled: true,
    expectedRevision: afterStale.value.mcp.revision,
  });
  if (!reenabled.ok) throw new Error(`re-enable failed: ${reenabled.error.message}`);
  report.reenable_receipt = reenabled.value;
  check('re-enable is verified', reenabled.value.verified && reenabled.value.enabled === true, {
    receipt: reenabled.value,
  });

  const usageAfter = await api.usage();
  report.usage_after = usageKey(usageAfter);
  check('the probe caused zero inference', JSON.stringify(report.usage_before) === JSON.stringify(report.usage_after), {
    before: report.usage_before,
    after: report.usage_after,
  });
} catch (error) {
  report.error = error.stack ?? String(error);
  console.log(`FAILED ${report.error}`);
  process.exitCode = 1;
} finally {
  await runtime.stop().catch(() => {});
  delete process.env.CODEWHALE_HOME;
  report.finished_utc = new Date().toISOString();
  report.ok = report.checks.every((entry) => entry.ok) && !report.error;
  const outIndex = process.argv.indexOf('--out');
  if (outIndex !== -1) {
    const out = process.argv[outIndex + 1];
    await mkdir(dirname(out), { recursive: true }).catch(() => {});
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`wrote ${out}`);
  }
}
