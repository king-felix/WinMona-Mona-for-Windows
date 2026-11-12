import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host.js';

/**
 * Real-Electron lifecycle probe used by `--lifecycle-test`. It starts one owned
 * runtime (free: no turn is submitted), then exercises the transitions P04 must
 * distinguish: window close with live work, renderer crash, and relaunch of the
 * existing owner. Results are written as JSON evidence.
 */
export type LifecycleProbeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: unknown }>;
  capturedAt: string;
};

export type LifecycleProbeInput = {
  host: EngineHost;
  workspace: string;
  getWindow: () => BrowserWindow | null;
  signalSecondInstance: () => void;
  outputPath: string;
  timeoutMs?: number;
};

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async (): Promise<void> => {
      if (await predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(() => void tick(), 100);
    };
    void tick();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function loaded(window: BrowserWindow): Promise<void> {
  await waitFor(() => !window.webContents.isLoading(), 15_000, 'window load');
}

export async function runLifecycleProbe(input: LifecycleProbeInput): Promise<LifecycleProbeResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const steps: LifecycleProbeResult['steps'] = [];
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}\n`,
    );
  };

  try {
    const started = await input.host.startProjectRuntime({ workspace: input.workspace, startupTimeoutMs: timeoutMs });
    check(
      'owned runtime started for the lifecycle probe',
      started.ok,
      started.ok ? { endpoint: started.endpoint } : started,
    );
    if (!started.ok) throw new Error('runtime start failed');
    const summary = input.host.summary();
    const runtimePid = summary.pid;
    check('runtime is owned with a real process id', typeof runtimePid === 'number' && pidAlive(runtimePid), {
      pid: runtimePid,
      state: summary.state,
    });

    const first = input.getWindow();
    if (!first) throw new Error('no initial window');
    await loaded(first);

    // 1. Window close must preserve the runtime and hide the window.
    first.close();
    await waitFor(() => input.getWindow()?.isDestroyed() === false, 5_000, 'window hidden');
    await waitFor(() => input.getWindow()?.isVisible() === false, 5_000, 'window hidden state');
    check('closing the window hides it instead of ending owned work', input.getWindow()?.isVisible() === false, {
      windowDestroyed: input.getWindow()?.isDestroyed() ?? true,
      runtimePid,
      runtimeAlive: typeof runtimePid === 'number' && pidAlive(runtimePid),
      hostState: input.host.summary().state,
    });

    // 2. Renderer crash must recreate the window and leave the runtime alone.
    const hidden = input.getWindow();
    if (!hidden) throw new Error('window vanished after close');
    const crashedId = hidden.webContents.id;
    hidden.webContents.forcefullyCrashRenderer();
    await waitFor(
      () => {
        const current = input.getWindow();
        return current !== null && !current.isDestroyed() && current.webContents.id !== crashedId;
      },
      15_000,
      'window recreation',
    );
    const recreated = input.getWindow();
    check('a renderer crash recreates the window', recreated !== null && recreated.webContents.id !== crashedId, {
      crashedWebContentsId: crashedId,
      newWebContentsId: recreated?.webContents.id ?? null,
      windowCount: BrowserWindow.getAllWindows().length,
    });
    await loaded(recreated as BrowserWindow);
    const dom = await (recreated as BrowserWindow).webContents.executeJavaScript(
      `({ title: document.title, version: document.querySelector('[data-testid="app-version"]')?.textContent ?? null })`,
      true,
    );
    check('the recreated window renders the real application', dom?.title === 'Mona', dom);
    check('the runtime survived the renderer crash', typeof runtimePid === 'number' && pidAlive(runtimePid), {
      runtimePid,
      hostState: input.host.summary().state,
    });
    check('the renderer crash did not start a quit', input.host.summary().state === 'connected', {
      hostState: input.host.summary().state,
    });

    // 3. Relaunching the app targets the existing owner instead of a second one.
    (recreated as BrowserWindow).hide();
    input.signalSecondInstance();
    await waitFor(() => input.getWindow()?.isVisible() === true, 5_000, 'window restored');
    check(
      'a second launch restores the existing window and keeps the same runtime',
      input.getWindow()?.isVisible() === true,
      {
        windowCount: BrowserWindow.getAllWindows().length,
        runtimePid,
        sameRuntime: input.host.summary().pid === runtimePid,
      },
    );

    // 4. Quit and stop: the owned runtime is interrupted-free (no active turn)
    // and stopped with a receipt.
    const quit = await input.host.quitAndStopWork();
    const receipt = input.host.shutdownReceipt();
    check('quit and stop ends the owned runtime with a receipt', receipt !== null && receipt.root_exited, {
      outcome: receipt?.outcome,
      rootExited: receipt?.root_exited,
      rollbackClaimed: receipt?.rollback_claimed,
      quit,
    });
    await waitFor(() => typeof runtimePid === 'number' && !pidAlive(runtimePid), 15_000, 'runtime exit');
    check('the runtime process is gone after quit', typeof runtimePid === 'number' && !pidAlive(runtimePid), {
      runtimePid,
    });
  } catch (error) {
    check('lifecycle probe completed without an exception', false, String(error));
  }

  const result: LifecycleProbeResult = {
    ok: steps.every((step) => step.ok),
    steps,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  fs.writeFileSync(input.outputPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
