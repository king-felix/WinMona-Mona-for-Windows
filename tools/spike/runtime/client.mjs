// P01 spike client for the Codewhale 0.10.2 HTTP/SSE Runtime API.
//
// This is a disposable integration spike, not the product adapter. P03 replaces
// it with the contract-tested adapter package. Every route and field used here
// was observed from the installed binary (0.10.2, ff466b2ed0bf): /v1/runtime/info,
// the embedded mobile client, and live responses recorded under
// docs/evidence/P01-contract.json. No route is guessed from prose.
//
// Security posture: loopback only, bearer token supplied through the child
// environment (never argv), no network access other than 127.0.0.1.

import { spawn } from 'node:child_process';

export const DEFAULT_HOME_HEALTH = '/health';

export class RuntimeHttpError extends Error {
  constructor(status, path, body) {
    super(`HTTP ${status} ${path}: ${truncate(body, 400)}`);
    this.name = 'RuntimeHttpError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Minimal JSON client for a loopback Runtime API. */
export class RuntimeClient {
  constructor({ baseUrl, token, timeoutMs = 15000 }) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
      throw new Error(`refusing non-loopback base URL: ${baseUrl}`);
    }
    if (typeof token !== 'string' || token.length < 8) {
      throw new Error('a runtime bearer token is required');
    }
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
    if (!path.startsWith('/')) throw new Error(`path must be absolute: ${path}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) throw new RuntimeHttpError(res.status, path, text);
      return { status: res.status, headers: res.headers, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    const res = await this.request('GET', '/health');
    return res.json;
  }

  async runtimeInfo() {
    return (await this.request('GET', '/v1/runtime/info')).json;
  }

  async effectiveConfig() {
    return (await this.request('GET', '/v1/config')).json;
  }

  async providers() {
    return (await this.request('GET', '/v1/providers')).json;
  }

  async createThread({
    mode = 'agent',
    allowShell = true,
    trustMode = true,
    autoApprove = true,
    operationKey,
  } = {}) {
    const body = {
      mode,
      allow_shell: allowShell,
      trust_mode: trustMode,
      auto_approve: autoApprove,
    };
    if (operationKey) body.operation_key = operationKey;
    const res = await this.request('POST', '/v1/threads', body);
    return { thread: res.json, status: res.status };
  }

  async getThread(threadId) {
    return (await this.request('GET', `/v1/threads/${encodeURIComponent(threadId)}`)).json;
  }

  async threadSummary(limit = 20) {
    return (
      await this.request(
        'GET',
        `/v1/threads/summary?limit=${limit}&include_archived=false`,
      )
    ).json;
  }

  async history(threadId) {
    return (
      await this.request('GET', `/v1/threads/${encodeURIComponent(threadId)}/history`)
    ).json;
  }

  /**
   * Submit one turn. Persist the operation key before calling: on a replayed
   * key the runtime answers 200 with idempotent_replay instead of creating a
   * second turn (capability turn_operation_idempotency).
   */
  async submitTurn(
    threadId,
    { prompt, allowShell = true, trustMode = true, autoApprove = true, operationKey },
  ) {
    const body = {
      prompt,
      allow_shell: allowShell,
      trust_mode: trustMode,
      auto_approve: autoApprove,
    };
    if (operationKey) body.operation_key = operationKey;
    const res = await this.request(
      'POST',
      `/v1/threads/${encodeURIComponent(threadId)}/turns`,
      body,
    );
    return { status: res.status, receipt: res.json, replayed: res.json?.idempotent_replay === true };
  }

  async lookupTurnOperation(threadId, operationKey) {
    const res = await this.request(
      'GET',
      `/v1/threads/${encodeURIComponent(threadId)}/turn-operations/${encodeURIComponent(operationKey)}`,
    );
    return { status: res.status, json: res.json };
  }

  async interrupt(threadId, turnId) {
    return (
      await this.request(
        'POST',
        `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        {},
      )
    ).json;
  }

  async turnReceipt(threadId, turnId) {
    return (
      await this.request(
        'GET',
        `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/receipt`,
      )
    ).json;
  }

  async cancelTask(taskId) {
    return (await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {})).json;
  }

  async usage() {
    return (await this.request('GET', '/v1/usage')).json;
  }

  async threadUsage(threadId) {
    return (
      await this.request('GET', `/v1/threads/${encodeURIComponent(threadId)}/usage`)
    ).json;
  }

  /**
   * Subscribe to a thread's durable journal. Yields {id, event, data} frames.
   * `sinceSeq` resumes inclusively after that durable seq; the runtime honours
   * both this query parameter and Last-Event-ID (event_stream_resume).
   */
  async *subscribe(threadId, { sinceSeq = 0, replayLimit = 0, signal } = {}) {
    const query = new URLSearchParams({ since_seq: String(sinceSeq) });
    if (replayLimit) query.set('replay_limit', String(replayLimit));
    const url = `${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?${query}`;
    // Wait for open and termination. Abort is the caller's stop signal.
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      const body = res.body ? await res.text() : '';
      throw new RuntimeHttpError(res.status, `/v1/threads/${threadId}/events`, body);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        // SSE frames end with a blank line; accept CRLF as well as LF.
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
          const frame = parseSseFrame(raw);
          if (frame) yield frame;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }
  }
}

export function parseSseFrame(raw) {
  let event = 'message';
  let id;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === 'message' && id === undefined) return null;
  const dataText = dataLines.join('\n');
  let data;
  try {
    data = dataText ? JSON.parse(dataText) : undefined;
  } catch {
    data = { raw: dataText };
  }
  return { id, event, data };
}

/**
 * Start an owned runtime. The token travels through the environment because
 * --auth-token is visible in the process list (engine help says so explicitly).
 */
export async function startOwnedRuntime({
  executable,
  workspace,
  port,
  token,
  extraArgs = [],
  startupTimeoutMs = 20000,
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`invalid port ${port}`);
  }
  const args = ['app-server', '--http', '--port', String(port), ...extraArgs];
  const child = spawnImpl(executable, args, {
    cwd: workspace,
    env: { ...process.env, CODEWHALE_RUNTIME_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr += chunk.toString('utf8');
  });

  const deadline = Date.now() + startupTimeoutMs;
  const baseUrl = `http://127.0.0.1:${port}`;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited during startup (${child.exitCode}): ${output.stderr}`);
    }
    try {
      const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = await res.json();
        if (body?.service === 'codewhale-runtime-api') {
          return {
            child,
            baseUrl,
            output,
            async stop({ timeoutMs = 5000 } = {}) {
              if (child.exitCode !== null) return child.exitCode;
              const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
              child.kill();
              const code = await Promise.race([
                exited,
                new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
              ]);
              if (code === null && child.exitCode === null) child.kill('SIGKILL');
              return child.exitCode ?? code;
            },
          };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error(`runtime did not become ready: ${lastError?.message ?? 'timeout'}`);
}

export function makeToken() {
  return `mona-p01-${crypto.randomUUID().replaceAll('-', '')}`;
}
