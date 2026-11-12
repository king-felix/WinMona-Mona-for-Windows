import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindowConstructorOptions } from 'electron';

/** The renderer may only be our bundled index or the loopback dev server. */
export function isTrustedAppUrl(
  candidate: string,
  options: { indexPath: string; devServerUrl?: string | undefined },
): boolean {
  if (!candidate) return false;
  if (options.devServerUrl) {
    const dev = new URL(options.devServerUrl);
    if (dev.protocol !== 'http:' || dev.hostname !== '127.0.0.1') return false;
    if (candidate === options.devServerUrl) return true;
    if (candidate.startsWith(`${options.devServerUrl}/`)) return true;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(options.indexPath);
  } catch {
    return false;
  }
}

type SenderFrameLike = { url: string; parent: unknown } | null | undefined;

/** A valid IPC sender is the top frame of our app origin, never a subframe. */
export function isTrustedSenderFrame(
  event: { senderFrame?: SenderFrameLike },
  options: { indexPath: string; devServerUrl?: string | undefined },
): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (frame.parent !== null) return false;
  return isTrustedAppUrl(frame.url, options);
}

export function cspFor(options: { devServerUrl?: string | undefined }): string {
  const dev = options.devServerUrl
    ? `script-src 'self' 'unsafe-inline' http://127.0.0.1:${new URL(options.devServerUrl).port}; connect-src 'self' ws://127.0.0.1:${new URL(options.devServerUrl).port} http://127.0.0.1:${new URL(options.devServerUrl).port};`
    : "script-src 'self'; connect-src 'none';";
  return [
    "default-src 'none'",
    dev,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Renderer isolation: sandboxed, context-isolated, no Node integration, no
 * webviews, no remote module, and a single narrow preload.
 */
export function windowOptions(preloadPath: string, options: { isDev: boolean }): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#F7F8FC',
    title: 'Mona',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      devTools: options.isDev,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  };
}
