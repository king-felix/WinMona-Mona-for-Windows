import { describe, expect, it } from 'vitest';
import { createAppInfo, registerIpc, type IpcHandle } from './ipc.js';

const info = createAppInfo({
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '140.0.0',
  node: '24.0.0',
  platform: 'win32',
  arch: 'x64',
});

function harness(options: { trusted?: boolean; throwOnInfo?: boolean } = {}) {
  let channel = '';
  let listener: ((event: unknown, payload: unknown) => unknown) | null = null;
  const handle: IpcHandle = (name, fn) => {
    channel = name;
    listener = fn;
  };
  registerIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    getAppInfo: () => {
      if (options.throwOnInfo) throw new Error('boom');
      return info;
    },
  });
  return {
    channel,
    async invoke(payload: unknown) {
      if (!listener) throw new Error('no listener registered');
      return listener({}, payload);
    },
  };
}

describe('app-info IPC', () => {
  it('registers exactly the app-info channel', () => {
    const h = harness();
    expect(h.channel).toBe('mona:app-info');
  });

  it('returns typed app info for an empty object from a trusted frame', async () => {
    const result = await harness().invoke({});
    expect(result).toMatchObject({ ok: true, data: { name: 'Mona', version: '0.1.0' } });
  });

  it('rejects an untrusted sender', async () => {
    const result = await harness({ trusted: false }).invoke({});
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
  });

  it('rejects unknown or unexpected payload fields', async () => {
    for (const payload of [{ extra: true }, null, 'text', [1]]) {
      const result = await harness().invoke(payload);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
  });

  it('returns a typed internal error instead of throwing', async () => {
    const result = await harness({ throwOnInfo: true }).invoke({});
    expect(result).toMatchObject({ ok: false, error: { code: 'internal', retryable: true } });
  });
});
