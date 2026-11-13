import { describe, expect, it } from 'vitest';
import type { AppInfo } from '../shared/ipc.js';
import type { AttentionView } from '../shared/attention.js';
import type { AppearanceView } from '../shared/appearance.js';
import type { LaunchStateView } from '../shared/launch.js';
import { registerAgentIpc } from './agents-ipc.js';
import { registerAppearanceIpc } from './appearance-ipc.js';
import { registerAttentionIpc } from './attention-ipc.js';
import { registerBriefingIpc } from './briefing-ipc.js';
import { registerCapabilityIpc } from './capability-ipc.js';
import { registerCatalogIpc } from './catalog-ipc.js';
import { registerChangesIpc } from './changes-ipc.js';
import { registerExtensionIpc } from './extensions-ipc.js';
import { registerIpc, type IpcHandle } from './ipc.js';
import { registerLaunchIpc } from './launch-ipc.js';
import { registerMemoryIpc } from './memory-ipc.js';
import { registerProviderIpc } from './provider-ipc.js';
import { registerStudioIpc } from './studio-ipc.js';
import { registerTerminalIpc } from './terminal-ipc.js';

/**
 * One audit across every IPC module. Each module is wired with a sender that is
 * never trusted and a service that is never available; if any channel answers
 * anything other than `untrusted_sender`, its wrapper is missing the sender
 * check. This is deliberately independent of payload validation.
 */
function wireEverything(): Map<string, (event: unknown, payload: unknown) => unknown> {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const untrusted = (): boolean => false;

  registerIpc({ handle, isTrustedSender: untrusted, getAppInfo: () => ({}) as AppInfo });
  registerCatalogIpc({ handle, isTrustedSender: untrusted, service: null });
  registerStudioIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerChangesIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerAgentIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerProviderIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerExtensionIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerCapabilityIpc({ handle, isTrustedSender: untrusted, service: () => null });
  registerTerminalIpc({ handle, isTrustedSender: untrusted, service: () => null, clipboard: () => undefined });
  registerLaunchIpc({ handle, isTrustedSender: untrusted, state: () => ({}) as LaunchStateView });
  registerAttentionIpc({
    handle,
    isTrustedSender: untrusted,
    view: () => ({}) as AttentionView,
    update: () => ({}) as AttentionView,
    quitAndStop: () => undefined,
  });
  registerAppearanceIpc({
    handle,
    isTrustedSender: untrusted,
    view: () => ({}) as AppearanceView,
    zoom: () => ({}) as AppearanceView,
  });
  registerBriefingIpc({ handle, isTrustedSender: untrusted, service: () => null, ui: () => null });
  registerMemoryIpc({ handle, isTrustedSender: untrusted, service: () => null });
  return listeners;
}

describe('IPC sender audit', () => {
  it('registers the whole named surface', () => {
    const listeners = wireEverything();
    // The P19 surface brought the handled channel count above sixty. Event
    // channels are push-only and are not in this map.
    expect(listeners.size).toBeGreaterThanOrEqual(60);
  });

  it('refuses every handled channel when the sender is not the app frame', async () => {
    const listeners = wireEverything();
    const failures: string[] = [];
    for (const [channel, listener] of listeners) {
      const result = (await listener({ senderFrame: { url: 'https://evil.example/' } }, {})) as {
        ok?: boolean;
        error?: { code?: string };
      };
      if (result?.ok !== false || result.error?.code !== 'untrusted_sender') {
        failures.push(`${channel}: ${JSON.stringify(result).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
