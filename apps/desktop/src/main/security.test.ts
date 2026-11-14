import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { cspFor, isTrustedAppUrl, isTrustedSenderFrame, windowOptions } from './security.js';

const indexPath = path.resolve('apps/desktop/dist/renderer/index.html');
const indexUrl = pathToFileURL(indexPath).href;

describe('app origin', () => {
  it('accepts the bundled index file only', () => {
    expect(isTrustedAppUrl(indexUrl, { indexPath })).toBe(true);
    expect(
      isTrustedAppUrl(pathToFileURL(path.resolve('apps/desktop/dist/renderer/other.html')).href, { indexPath }),
    ).toBe(false);
    expect(isTrustedAppUrl('https://example.com', { indexPath })).toBe(false);
    expect(isTrustedAppUrl('file:///C:/Windows/System32/drivers/etc/hosts', { indexPath })).toBe(false);
    expect(isTrustedAppUrl('', { indexPath })).toBe(false);
  });

  it('accepts only a loopback dev server when configured', () => {
    expect(isTrustedAppUrl('http://127.0.0.1:5173/', { indexPath, devServerUrl: 'http://127.0.0.1:5173' })).toBe(true);
    expect(isTrustedAppUrl('http://127.0.0.1:5173/evil', { indexPath, devServerUrl: 'http://127.0.0.1:5173' })).toBe(
      true,
    );
    expect(isTrustedAppUrl('http://127.0.0.1:5174/', { indexPath, devServerUrl: 'http://127.0.0.1:5173' })).toBe(false);
    expect(isTrustedAppUrl('http://10.0.0.4:5173/', { indexPath, devServerUrl: 'http://10.0.0.4:5173' })).toBe(false);
  });

  it('rejects subframes and missing frames as IPC senders', () => {
    expect(isTrustedSenderFrame({ senderFrame: { url: indexUrl, parent: null } }, { indexPath })).toBe(true);
    expect(isTrustedSenderFrame({ senderFrame: { url: indexUrl, parent: {} } }, { indexPath })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: null }, { indexPath })).toBe(false);
    expect(isTrustedSenderFrame({}, { indexPath })).toBe(false);
  });
});

describe('content policy', () => {
  it('denies all renderer network access in production', () => {
    const csp = cspFor({});
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('allows only the loopback dev server in development', () => {
    const csp = cspFor({ devServerUrl: 'http://127.0.0.1:5173' });
    expect(csp).toContain('ws://127.0.0.1:5173');
    expect(csp).not.toContain('*');
  });
});

describe('window isolation', () => {
  it('enables sandbox and context isolation and disables Node', () => {
    const options = windowOptions('preload.cjs', { isDev: false });
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.nodeIntegrationInSubFrames).toBe(false);
    expect(options.webPreferences?.webviewTag).toBe(false);
    expect(options.webPreferences?.devTools).toBe(false);
  });

  it('sets a window icon only when a built brand image exists', () => {
    expect(windowOptions('preload.cjs', { isDev: false }).icon).toBeUndefined();
    expect(windowOptions('preload.cjs', { isDev: false, icon: null }).icon).toBeUndefined();
    expect(windowOptions('preload.cjs', { isDev: false, icon: 'C:\\icons\\mona.ico' }).icon).toBe(
      'C:\\icons\\mona.ico',
    );
  });
});
