import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActivityRecorder,
  activityFile,
  clearActivity,
  isActiveRunState,
  readActivity,
  writeActivity,
  type InstallActivity,
} from './install-gate.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mona-gate-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('install activity gate', () => {
  it('treats only in-flight run states as active', () => {
    for (const state of ['preparing', 'running', 'interrupting', 'awaiting_approval']) {
      expect(isActiveRunState(state)).toBe(true);
    }
    for (const state of ['idle', 'completed', 'failed', 'stopped', 'paused', null, undefined, '']) {
      expect(isActiveRunState(state)).toBe(false);
    }
  });

  it('writes and reads a record atomically, creating the runtime directory', () => {
    const file = activityFile(temporaryRoot());
    const record: InstallActivity = {
      schema: 1,
      pid: process.pid,
      version: '0.1.0',
      state: 'active',
      projectId: 'project-1',
      runState: 'running',
      updatedUtc: new Date().toISOString(),
    };
    writeActivity(file, record);
    expect(readActivity(file)).toEqual(record);
  });

  it('ignores a malformed or foreign record instead of guessing', () => {
    const file = activityFile(temporaryRoot());
    writeActivity(file, {
      schema: 1,
      pid: process.pid,
      version: '0.1.0',
      state: 'idle',
      projectId: null,
      runState: null,
      updatedUtc: '2026-11-12T00:00:00.000Z',
    });
    expect(readActivity(file)?.state).toBe('idle');
    rmSync(file);
    expect(readActivity(file)).toBeNull();
  });

  it('records only meaningful transitions and clears on quit', () => {
    const root = temporaryRoot();
    const file = activityFile(root);
    const recorder = new ActivityRecorder({ file, version: '0.1.0', pid: 4242 });
    recorder.record(null);
    const first = readFileSync(file, 'utf8');
    recorder.record(null);
    expect(readFileSync(file, 'utf8')).toBe(first);
    recorder.record('running', 'project-7');
    const running = readActivity(file);
    expect(running?.state).toBe('active');
    expect(running?.pid).toBe(4242);
    expect(running?.projectId).toBe('project-7');
    recorder.clear();
    expect(readActivity(file)).toBeNull();
  });

  it('never throws when the location is unusable', () => {
    const file = activityFile(path.join(temporaryRoot(), '\u0000bad'));
    const recorder = new ActivityRecorder({ file, version: '0.1.0' });
    expect(() => recorder.record('running')).not.toThrow();
    expect(() => recorder.clear()).not.toThrow();
    expect(() => clearActivity(file)).not.toThrow();
  });
});
