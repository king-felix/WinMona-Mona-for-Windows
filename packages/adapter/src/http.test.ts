import { describe, expect, it } from 'vitest';
import { HttpTransport } from './http.js';

const token = 'test-token-1234567890';
const baseUrl = 'http://127.0.0.1:7900';

function transport(fetchImpl: typeof fetch) {
  return new HttpTransport({ baseUrl, token, fetchImpl, maxResponseBytes: 1024 });
}

describe('HTTP transport', () => {
  it('refuses a non-loopback base URL or short token', () => {
    expect(() => new HttpTransport({ baseUrl: 'http://10.0.0.1:7900', token })).toThrow(/loopback/);
    expect(() => new HttpTransport({ baseUrl, token: 'short' })).toThrow(/token/);
  });

  it('maps authentication failures and does not leak the token', async () => {
    const fake = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const result = await transport(fake).json('GET', '/v1/sessions');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('authentication_failed');
      expect(result.error.message).not.toContain(token);
    }
  });

  it('maps not-found and server errors distinctly', async () => {
    const missing = (async () => new Response('{"error":"missing"}', { status: 404 })) as typeof fetch;
    const missingResult = await transport(missing).json('GET', '/v1/threads/x');
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.code).toBe('not_found');

    const broken = (async () => new Response('boom', { status: 503 })) as typeof fetch;
    const brokenResult = await transport(broken).json('GET', '/v1/sessions');
    expect(brokenResult.ok).toBe(false);
    if (!brokenResult.ok) {
      expect(brokenResult.error.code).toBe('transport_failed');
      expect(brokenResult.error.retryable).toBe(true);
    }
  });

  it('rejects a non-JSON success body as schema drift', async () => {
    const fake = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    const result = await transport(fake).json('GET', '/v1/runtime/info');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('schema_drift');
  });

  it('caps an oversized response body', async () => {
    const fake = (async () => new Response('x'.repeat(2000), { status: 200 })) as typeof fetch;
    const result = await transport(fake).json('GET', '/v1/sessions');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('oversize_event');
  });

  it('requires an event-stream content type', async () => {
    const fake = (async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const result = await transport(fake).stream('/v1/threads/x/events');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('schema_drift');
  });

  it('returns a bounded async iterable for a real stream response', async () => {
    const fake = (async () =>
      new Response('event: x\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;
    const result = await transport(fake).stream('/v1/threads/x/events');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.value) chunks.push(chunk);
      expect(new TextDecoder().decode(chunks[0])).toContain('event: x');
    }
  });
});
