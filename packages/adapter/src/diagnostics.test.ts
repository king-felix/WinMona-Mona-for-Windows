import { describe, expect, it } from 'vitest';
import type { RuntimeTransport, TransportOptions, TransportResponse } from './http.js';
import type { Result } from './errors.js';
import { EngineDiagnostics, redactLogText } from './diagnostics.js';

class FakeTransport implements RuntimeTransport {
  readonly calls: Array<{ method: string; path: string; options: TransportOptions | undefined }> = [];
  constructor(
    private readonly handler: (
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      options: TransportOptions | undefined,
    ) => Result<TransportResponse>,
  ) {}

  async json(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    _body?: unknown,
    options?: TransportOptions,
  ): Promise<Result<TransportResponse>> {
    this.calls.push({ method, path, options });
    return this.handler(method, path, options);
  }

  async stream(): Promise<Result<AsyncIterable<Uint8Array>>> {
    return { ok: false, error: { code: 'transport_failed', message: 'unused', retryable: false } };
  }
}

function success(json: unknown, status = 200): Result<TransportResponse> {
  return { ok: true, value: { status, json, bytes: 0 } };
}

describe('engine diagnostics', () => {
  it('maps runtime identity and capability flags', async () => {
    const transport = new FakeTransport(() =>
      success({
        service: 'codewhale-runtime-api',
        runtime_api_version: '1.0',
        codewhale_version: '0.10.2',
        codewhale_commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
        bind_host: '127.0.0.1',
        port: 7878,
        auth_required: true,
        capabilities: { terminal_stream: false, threads: true },
      }),
    );
    const info = await new EngineDiagnostics(transport).runtimeInfo();
    if (!info.ok) throw new Error('runtime info failed');
    expect(info.value.version).toBe('0.10.2');
    expect(info.value.capabilities).toEqual({ terminal_stream: false, threads: true });
  });

  it('lists logs and reads a bounded slice', async () => {
    const transport = new FakeTransport((method, path) => {
      if (path === '/v1/logs') {
        return success({
          sources: [
            { dir: 'C:\\home\\logs', files: [{ name: 'runtime.log', size: 100, modified: '2026-11-12T00:00:00Z' }] },
          ],
        });
      }
      if (path.startsWith('/v1/logs/runtime.log?')) {
        return success({
          name: 'runtime.log',
          size: 100,
          modified: '2026-11-12T00:00:00Z',
          offset: 0,
          content: 'secret=super-secret-value\nhello',
        });
      }
      return success({});
    });
    const diagnostics = new EngineDiagnostics(transport, () => new Date('2026-11-12T10:00:00Z'));
    const catalog = await diagnostics.listLogs();
    if (!catalog.ok) throw new Error('list failed');
    expect(catalog.value.sources[0].files[0].name).toBe('runtime.log');
    const log = await diagnostics.readLog({ name: 'runtime.log', offset: 0, limit: 10 });
    if (!log.ok) throw new Error('read failed');
    expect(log.value.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(log.value.content).not.toContain('super-secret-value');
    expect(log.value.redacted).toBe(true);
    expect(log.value.truncated).toBe(true);
    expect(transport.calls.some((call) => call.path.includes('limit=10'))).toBe(true);
  });

  it('rejects path-like log names', async () => {
    const transport = new FakeTransport(() => success({}));
    const diagnostics = new EngineDiagnostics(transport);
    for (const name of ['..\\config.toml', 'sub/dir.log', '..', '.', 'C:\\secret.log']) {
      const result = await diagnostics.readLog({ name });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid_request');
    }
    expect(transport.calls).toHaveLength(0);
  });

  it('reports a 501 terminal route as an explicit unsupported answer', async () => {
    const transport = new FakeTransport((_method, _path, options) => {
      expect(options?.acceptStatuses).toContain(501);
      return success({ error: { message: 'terminal sessions are Unix-only in this build', status: 501 } }, 501);
    });
    const result = await new EngineDiagnostics(transport).checkTerminal();
    if (!result.ok) throw new Error('terminal check failed');
    expect(result.value.supported).toBe(false);
    expect(result.value.statusCode).toBe(501);
    expect(result.value.message).toContain('Unix-only');
  });

  it('redacts credential-shaped values in log text', () => {
    const text = redactLogText('token=super-secret FIXTURE_TOKEN=abc123 Authorization: Bearer abcdefghijklmnop');
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('abcdefghijklmnop');
  });
});
