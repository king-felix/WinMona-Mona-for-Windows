import { fail, isAbortError, ok, redact, type Result } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export type TransportResponse = {
  status: number;
  json: unknown;
  bytes: number;
};

export type TransportOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

export interface RuntimeTransport {
  json(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<Result<TransportResponse>>;
  stream(path: string, options?: TransportOptions): Promise<Result<AsyncIterable<Uint8Array>>>;
}

export type HttpTransportOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
};

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** Loopback-only JSON/SSE transport with bounded bodies and typed failures. */
export class HttpTransport implements RuntimeTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    if (!LOOPBACK.test(options.baseUrl)) throw new Error('runtime base URL must be loopback HTTP');
    if (typeof options.token !== 'string' || options.token.length < 8) throw new Error('runtime token required');
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async json(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: TransportOptions = {},
  ): Promise<Result<TransportResponse>> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.send(path, init, options);
    if (!response.ok) return response;
    const res = response.value;
    const read = await readBounded(res, this.maxResponseBytes);
    if (!read.ok) return read;
    const text = read.value;
    let json: unknown;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        return fail('schema_drift', 'runtime returned non-JSON where JSON was expected', {
          detail: redact(text.slice(0, 200), [this.token]),
        });
      }
    }
    return ok({ status: res.status, json, bytes: text.length });
  }

  async stream(path: string, options: TransportOptions = {}): Promise<Result<AsyncIterable<Uint8Array>>> {
    const response = await this.send(
      path,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
        },
      },
      options,
    );
    if (!response.ok) return response;
    const res = response.value;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      await readBounded(res, 64 * 1024).catch(() => undefined);
      return fail('schema_drift', 'runtime did not answer with an event stream', {
        detail: `content-type=${contentType.slice(0, 100)}`,
      });
    }
    if (!res.body) return fail('stream_closed', 'runtime event stream had no body', { retryable: true });
    const body = res.body;
    return ok(
      (async function* iterate() {
        const reader = body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            if (value) yield value;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* stream already closed */
          }
        }
      })(),
    );
  }

  private async send(path: string, init: RequestInit, options: TransportOptions): Promise<Result<Response>> {
    if (!path.startsWith('/')) return fail('invalid_request', 'runtime path must start with /');
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, { ...init, signal });
    } catch (error) {
      if (options.signal?.aborted) return fail('stream_closed', 'request aborted by caller');
      if (isAbortError(error)) return fail('transport_failed', 'runtime request timed out', { retryable: true });
      return fail('transport_failed', 'runtime request failed', {
        retryable: true,
        detail: redact(error instanceof Error ? error.message : String(error), [this.token]),
      });
    }
    if (response.status === 401 || response.status === 403) {
      await readBounded(response, 16 * 1024).catch(() => undefined);
      return fail('authentication_failed', 'runtime rejected the bearer token');
    }
    if (response.status === 404) {
      const body = await readBounded(response, 16 * 1024).catch(() => '');
      return fail('not_found', 'runtime route or item was not found', {
        detail: redact(typeof body === 'string' ? body.slice(0, 300) : '', [this.token]),
      });
    }
    if (response.status === 409) {
      const body = await readBounded(response, 16 * 1024).catch(() => '');
      return fail('invalid_request', 'runtime refused a conflicting operation key', {
        detail: redact(typeof body === 'string' ? body.slice(0, 300) : '', [this.token]),
      });
    }
    if (response.status >= 500) {
      await readBounded(response, 16 * 1024).catch(() => undefined);
      return fail('transport_failed', `runtime returned HTTP ${response.status}`, { retryable: true });
    }
    if (!response.ok) {
      const body = await readBounded(response, 16 * 1024).catch(() => '');
      return fail('invalid_request', `runtime returned HTTP ${response.status}`, {
        detail: redact(typeof body === 'string' ? body.slice(0, 300) : '', [this.token]),
      });
    }
    return ok(response);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Result<string>> {
  if (!response.body) return ok('');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return fail('oversize_event', `runtime response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return ok(text);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
