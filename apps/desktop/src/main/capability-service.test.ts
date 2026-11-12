import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineAdapter } from '@mona/adapter';
import type { EngineSummary } from './engine-host.js';
import { CapabilityService } from './capability-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function summary(overrides: Partial<EngineSummary> = {}): EngineSummary {
  return {
    state: 'connected',
    detail: 'ready',
    workspace: 'C:\\proj',
    pid: 1234,
    endpoint: 'http://127.0.0.1:7878',
    compatibility: 'qualified',
    descriptors: [],
    ...overrides,
  };
}

function ledger(rows: unknown[]) {
  return {
    schema_version: 1,
    captured_utc: '2026-11-12T00:00:00Z',
    engine: { version: '0.10.2', commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e', platform: 'windows-x64' },
    rows,
  };
}

function row(overrides: Record<string, unknown>) {
  return {
    id: 'CAP-0001',
    upstream: { name: 'run', surface: 'cli', source: 'codewhale --help', version: '0.10.2+ff466b2ed0bf' },
    platform: 'windows-x64',
    class: 'read',
    permission_implications: 'shell',
    cost_implications: 'model',
    required_arguments: 'see help',
    chosen_integration: 'Advanced action',
    ui_location: 'Studio',
    tests: ['test.ts'],
    status: 'qualified',
    gap: null,
    evidence: { help_capture: 'help.txt', captured_utc: null, contract_report: null },
    ...overrides,
  };
}

async function ledgerFile(rows: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mona-p18-'));
  roots.push(root);
  const file = path.join(root, 'capabilities.json');
  await writeFile(file, `${JSON.stringify(ledger(rows), null, 2)}\n`, 'utf8');
  return file;
}

function adapter(options: { capabilities?: Record<string, boolean>; version?: string; commit?: string } = {}) {
  const actions: string[] = [];
  const diagnostics = {
    runtimeInfo: async () => ({
      ok: true as const,
      value: {
        service: 'codewhale-runtime-api',
        apiVersion: '1.0',
        version: options.version ?? '0.10.2',
        commit: options.commit ?? 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
        bindHost: '127.0.0.1',
        port: 7878,
        authRequired: true,
        capabilities: options.capabilities ?? {
          terminal_stream: false,
          terminal_input: false,
          terminal_resize: false,
          terminal_kill: false,
          threads: true,
        },
      },
    }),
    processInfo: async () => ({
      ok: true as const,
      value: {
        pid: 1234,
        version: options.version ?? '0.10.2',
        commit: options.commit ?? 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
        startedAt: '2026-11-12T00:00:00Z',
        uptimeSeconds: 30,
        executable: 'codewhale.exe',
        rssBytes: null,
      },
    }),
    listLogs: async () => {
      actions.push('list-logs');
      return {
        ok: true as const,
        value: {
          status: 'ok' as const,
          note: null,
          sources: [{ dir: 'C:\\home\\logs', files: [{ name: 'runtime.log', size: 10, modifiedAt: null }] }],
        },
      };
    },
    readLog: async (input: { name: string }) => {
      actions.push(`read-log:${input.name}`);
      return {
        ok: true as const,
        value: {
          name: input.name,
          size: 10,
          modifiedAt: null,
          offset: 0,
          requestedLimit: 64 * 1024,
          bytes: 10,
          content: 'redacted\n',
          truncated: false,
          redacted: true,
          readAt: '2026-11-12T00:00:00Z',
        },
      };
    },
    checkTerminal: async () => {
      actions.push('check-terminal');
      return {
        ok: true as const,
        value: {
          supported: false,
          status: 'unavailable' as const,
          statusCode: 501,
          message: 'terminal sessions are Unix-only in this build',
          checkedAt: '2026-11-12T00:00:00Z',
        },
      };
    },
  };
  const instance = { diagnostics: () => diagnostics } as unknown as EngineAdapter;
  return { instance, actions };
}

function service(options: {
  file: string;
  connected?: boolean;
  adapterOptions?: { capabilities?: Record<string, boolean>; version?: string; commit?: string };
  summaryOverrides?: Partial<EngineSummary>;
}) {
  const engineAdapter = adapter(options.adapterOptions);
  const service = new CapabilityService({
    engine: {
      summary: () => summary(options.summaryOverrides),
      adapter: () => (options.connected === false ? null : engineAdapter.instance),
    },
    ledgerPath: options.file,
    now: () => new Date('2026-11-12T10:00:00Z'),
  });
  return { service, actions: engineAdapter.actions };
}

describe('capability service', () => {
  it('joins ledger rows with live identity, flags, terminal state and logs', async () => {
    const file = await ledgerFile([
      row({ id: 'CAP-0001', status: 'qualified' }),
      row({ id: 'CAP-0002', status: 'discovered', upstream: { name: 'eval', surface: 'cli' } }),
      row({
        id: 'CAP-0003',
        status: 'unavailable-on-platform',
        chosen_integration: 'Unavailable',
        upstream: { name: 'terminal', surface: 'runtime-api' },
      }),
    ]);
    const { service: capabilities } = service({ file });
    const result = await capabilities.view();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.identity.drift).toBe('none');
    expect(result.data.rows).toHaveLength(3);
    expect(result.data.coverage).toMatchObject({
      total: 3,
      qualified: 1,
      discovered: 1,
      unavailable: 1,
      verifiedEntryPoints: 1,
      discoveredOnly: 1,
      completenessPercent: 33,
    });
    expect(result.data.liveFlags.find((flag) => flag.name === 'terminal_stream')?.value).toBe(false);
    expect(result.data.terminal.status).toBe('unavailable');
    expect(result.data.terminal.reason).toContain('terminal_stream');
    expect(result.data.logs.sources[0]?.files[0]?.name).toBe('runtime.log');
    expect(result.data.palette.map((item) => item.id)).toEqual([
      'capability:CAP-0001',
      'capability:CAP-0002',
      'capability:CAP-0003',
    ]);
  });

  it('reports version drift instead of inheriting the ledger claim', async () => {
    const file = await ledgerFile([row({})]);
    const { service: capabilities } = service({ file, adapterOptions: { version: '0.10.3' } });
    const result = await capabilities.view();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.identity.drift).toBe('version');
    expect(result.data.caveats.some((caveat) => caveat.includes('0.10.3'))).toBe(true);
  });

  it('keeps the explorer useful when the engine is disconnected', async () => {
    const file = await ledgerFile([row({ status: 'discovered' })]);
    const { service: capabilities } = service({ file, connected: false });
    const result = await capabilities.view();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.connected).toBe(false);
    expect(result.data.identity.version).toBeNull();
    expect(result.data.identity.drift).toBe('unknown');
    expect(result.data.terminal.status).toBe('unknown');
    expect(result.data.logs.status).toBe('unavailable');
    expect(result.data.rows).toHaveLength(1);
  });

  it('forwards log reads and terminal checks through the adapter', async () => {
    const file = await ledgerFile([row({})]);
    const { service: capabilities, actions } = service({ file });
    const log = await capabilities.readLog({ name: 'runtime.log' });
    if (!log.ok) throw new Error(log.error.message);
    expect(log.data.name).toBe('runtime.log');
    const terminal = await capabilities.checkTerminal();
    if (!terminal.ok) throw new Error(terminal.error.message);
    expect(terminal.data.statusCode).toBe(501);
    expect(actions).toEqual(['read-log:runtime.log', 'check-terminal']);
  });

  it('refuses an unreadable ledger', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mona-p18-bad-'));
    roots.push(root);
    const file = path.join(root, 'capabilities.json');
    await writeFile(file, 'not json', 'utf8');
    const { service: capabilities } = service({ file });
    const result = await capabilities.view();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schema_drift');
  });
});
