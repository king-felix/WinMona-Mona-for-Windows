import { z } from 'zod';
import type { LogCatalog, LogContent, TerminalCheck } from '@mona/contracts';
import { fail, ok, redact, type Result } from './errors.js';
import type { RuntimeTransport } from './http.js';

/**
 * Read-only engine diagnostics: identity, capability flags, bounded log reads
 * and an explicit terminal-route check. Nothing here starts, resizes or kills a
 * terminal; the check exists so Mona can report the engine's exact limitation
 * instead of guessing.
 */

const WireRuntimeInfo = z
  .object({
    service: z.string().optional(),
    runtime_api_version: z.string().optional(),
    codewhale_version: z.string().optional(),
    codewhale_commit: z.string().optional(),
    bind_host: z.string().optional(),
    port: z.number().optional(),
    auth_required: z.boolean().optional(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

const WireProcess = z
  .object({
    pid: z.number().optional(),
    version: z.string().optional(),
    commit: z.string().optional(),
    started_at: z.string().optional(),
    uptime_seconds: z.number().optional(),
    executable: z.string().optional(),
    rss_bytes: z.number().nullable().optional(),
  })
  .passthrough();

const WireLogs = z
  .object({
    sources: z
      .array(
        z
          .object({
            dir: z.string().optional(),
            files: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    size: z.number().optional(),
                    modified: z.string().nullable().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireLog = z
  .object({
    name: z.string().min(1),
    size: z.number().optional(),
    modified: z.string().nullable().optional(),
    offset: z.number().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export type RuntimeIdentity = {
  service: string | null;
  apiVersion: string | null;
  version: string | null;
  commit: string | null;
  bindHost: string | null;
  port: number | null;
  authRequired: boolean | null;
  capabilities: Record<string, boolean>;
};

export type EngineProcess = {
  pid: number | null;
  version: string | null;
  commit: string | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
  executable: string | null;
  rssBytes: number | null;
};

export const MAX_LOG_BYTES = 64 * 1024;

export class EngineDiagnostics {
  private readonly transport: RuntimeTransport;
  private readonly now: () => Date;

  constructor(transport: RuntimeTransport, now: () => Date = () => new Date()) {
    this.transport = transport;
    this.now = now;
  }

  async runtimeInfo(): Promise<Result<RuntimeIdentity>> {
    const response = await this.transport.json('GET', '/v1/runtime/info');
    if (!response.ok) return response;
    const wire = WireRuntimeInfo.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'runtime info did not match the runtime contract');
    return ok({
      service: wire.data.service ?? null,
      apiVersion: wire.data.runtime_api_version ?? null,
      version: wire.data.codewhale_version ?? null,
      commit: wire.data.codewhale_commit ?? null,
      bindHost: wire.data.bind_host ?? null,
      port: wire.data.port ?? null,
      authRequired: wire.data.auth_required ?? null,
      capabilities: wire.data.capabilities ?? {},
    });
  }

  async processInfo(): Promise<Result<EngineProcess>> {
    const response = await this.transport.json('GET', '/v1/process');
    if (!response.ok) return response;
    const wire = WireProcess.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'process info did not match the runtime contract');
    return ok({
      pid: wire.data.pid ?? null,
      version: wire.data.version ?? null,
      commit: wire.data.commit ?? null,
      startedAt: wire.data.started_at ?? null,
      uptimeSeconds: wire.data.uptime_seconds ?? null,
      executable: wire.data.executable ?? null,
      rssBytes: wire.data.rss_bytes ?? null,
    });
  }

  async listLogs(): Promise<Result<LogCatalog>> {
    const response = await this.transport.json('GET', '/v1/logs');
    if (!response.ok) {
      return ok({ status: 'unavailable', note: redactLogText(response.error.message), sources: [] });
    }
    const wire = WireLogs.safeParse(response.value.json);
    if (!wire.success) {
      return ok({
        status: 'unavailable',
        note: 'The engine log list did not match the runtime contract.',
        sources: [],
      });
    }
    return ok({
      status: 'ok',
      note: null,
      sources: (wire.data.sources ?? []).slice(0, 20).map((source) => ({
        dir: source.dir ?? '',
        files: (source.files ?? []).slice(0, 500).map((file) => ({
          name: file.name,
          size: Math.max(0, Math.floor(file.size ?? 0)),
          modifiedAt: file.modified ?? null,
        })),
      })),
    });
  }

  /** Read at most MAX_LOG_BYTES from one log file, with path and secret guards. */
  async readLog(input: { name: string; offset?: number; limit?: number }): Promise<Result<LogContent>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name) || input.name === '.' || input.name === '..') {
      return fail('invalid_request', 'Log name must be a single file name without a path.');
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(MAX_LOG_BYTES, Math.max(1, Math.floor(input.limit ?? MAX_LOG_BYTES)));
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const response = await this.transport.json('GET', `/v1/logs/${encodeURIComponent(input.name)}?${query}`);
    if (!response.ok) return response;
    const wire = WireLog.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'log content did not match the runtime contract');
    const raw = wire.data.content ?? '';
    const redacted = redactLogText(raw);
    const bytes = Buffer.byteLength(redacted, 'utf8');
    const size = Math.max(0, Math.floor(wire.data.size ?? bytes));
    return ok({
      name: wire.data.name,
      size,
      modifiedAt: wire.data.modified ?? null,
      offset: Math.max(0, Math.floor(wire.data.offset ?? offset)),
      requestedLimit: limit,
      bytes,
      content: redacted,
      truncated: size > offset + bytes,
      redacted: redacted !== raw,
      readAt: this.now().toISOString(),
    });
  }

  /**
   * Ask the engine whether its terminal route is usable. The caller must choose
   * to run this; it is never part of a page load. A 501 is a real answer, not a
   * transport failure, so its message reaches the UI.
   */
  async checkTerminal(): Promise<Result<TerminalCheck>> {
    const response = await this.transport.json('GET', '/v1/terminal/mona-probe/output', undefined, {
      acceptStatuses: [404, 501],
    });
    if (!response.ok) return response;
    const status = response.value.status;
    const body = response.value.json;
    const message = errorMessage(body) ?? (status === 200 ? 'The terminal route answered.' : 'No message returned.');
    return ok({
      supported: status === 200,
      status: status === 200 ? 'available' : 'unavailable',
      statusCode: status,
      message: truncate(redactLogText(message), 2_000),
      checkedAt: this.now().toISOString(),
    });
  }
}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body : null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Redact credential-shaped values from local logs before they reach the renderer. */
export function redactLogText(text: string): string {
  return redact(text)
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:token|api_key|key|secret|access_token|auth)=)[^&\s]+/gi, '$1[redacted]');
}
