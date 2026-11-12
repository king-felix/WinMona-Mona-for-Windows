import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyLaunchPath, inspectLaunchPath, workspaceCaveat } from './launch-target.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p09-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

const CWD = 'C:\\Work';

describe('launch path shape', () => {
  it('accepts a folder with spaces, brackets and Unicode', () => {
    const selected = 'C:\\Work\\R&D (beta) — Victor\\ünïcode';
    expect(classifyLaunchPath(selected, { cwd: CWD, platform: 'win32' })).toEqual({
      ok: true,
      path: selected,
      shape: 'folder',
    });
  });

  it('normalizes a trailing separator without changing the folder', async () => {
    const root = await tempDir('trailing');
    const folder = path.join(root, 'alpha');
    await mkdir(folder);
    const inspected = await inspectLaunchPath(`${folder}${path.sep}`, { cwd: root, platform: process.platform });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.path).toBe(path.resolve(folder));
  });

  it('sends drive, share and distribution roots to explicit selection', () => {
    for (const selected of ['C:\\', 'd:/', '\\\\fileserver\\team', '\\\\wsl$\\Ubuntu', '\\\\wsl.localhost\\Ubuntu']) {
      const outcome = classifyLaunchPath(selected, { cwd: CWD, platform: 'win32' });
      expect(outcome.ok, selected).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind, selected).toBe('needs-selection');
      expect(outcome.detail.length).toBeGreaterThan(20);
    }
  });

  it('opens a folder inside a share or a distribution with a recorded caveat', () => {
    const share = classifyLaunchPath('\\\\fileserver\\team\\project', { cwd: CWD, platform: 'win32' });
    expect(share).toMatchObject({ ok: true, shape: 'unc' });
    expect(workspaceCaveat('unc')).toContain('not qualified');

    const wsl = classifyLaunchPath('\\\\wsl$\\Ubuntu\\home\\victor\\project', { cwd: CWD, platform: 'win32' });
    expect(wsl).toMatchObject({ ok: true, shape: 'wsl' });
    expect(workspaceCaveat('wsl')).toContain('not qualified');
    expect(workspaceCaveat('folder')).toBeNull();
  });

  it('rejects empty, oversized and control-character selections', () => {
    expect(classifyLaunchPath('   ', { cwd: CWD, platform: 'win32' })).toMatchObject({ code: 'empty' });
    expect(classifyLaunchPath('C:\\Work\\a\u0000b', { cwd: CWD, platform: 'win32' })).toMatchObject({
      code: 'invalid',
    });
    expect(classifyLaunchPath(`C:\\${'a'.repeat(40_000)}`, { cwd: CWD, platform: 'win32' })).toMatchObject({
      code: 'too_long',
    });
  });
});

describe('launch path reachability', () => {
  it('reports a missing folder instead of registering it', async () => {
    const root = await tempDir('missing');
    const inspected = await inspectLaunchPath(path.join(root, 'gone'), { cwd: root, platform: process.platform });
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.kind).toBe('rejected');
    if (inspected.kind !== 'rejected') return;
    expect(inspected.code).toBe('missing');
    expect(inspected.detail).toContain('was not found');
  });

  it('reports a file selection rather than opening its parent', async () => {
    const root = await tempDir('file');
    const file = path.join(root, 'notes.txt');
    await writeFile(file, 'not a project\n', 'utf8');
    const inspected = await inspectLaunchPath(file, { cwd: root, platform: process.platform });
    expect(inspected.ok).toBe(false);
    if (inspected.ok || inspected.kind !== 'rejected') return;
    expect(inspected.code).toBe('not_a_folder');
    expect(inspected.detail).toContain('is a file');
  });

  it('reports access denial from the operating system', async () => {
    const inspected = await inspectLaunchPath('C:\\denied', {
      cwd: CWD,
      platform: process.platform,
      stat: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(inspected).toMatchObject({ ok: false, kind: 'rejected', code: 'inaccessible' });
  });

  it('bounds a location that never answers', async () => {
    const inspected = await inspectLaunchPath('\\\\slow-server\\share\\project', {
      cwd: CWD,
      platform: 'win32',
      timeoutMs: 25,
      stat: () => new Promise(() => undefined),
    });
    expect(inspected.ok).toBe(false);
    if (inspected.ok || inspected.kind !== 'rejected') return;
    expect(inspected.code).toBe('unreachable');
    expect(inspected.detail).toContain('25 ms');
  });

  it('accepts a real folder and a real junction to it', async () => {
    const root = await tempDir('alias');
    const folder = path.join(root, 'alpha');
    await mkdir(folder);
    const junction = path.join(root, 'alpha-alias');
    let aliasMade = false;
    try {
      await symlink(folder, junction, 'junction');
      aliasMade = true;
    } catch {
      // Creating a junction can be refused by policy; the unit evidence then
      // rests on the real folder and the store-level identity tests.
    }
    const direct = await inspectLaunchPath(folder, { cwd: root, platform: process.platform });
    expect(direct.ok).toBe(true);
    if (aliasMade) {
      const viaAlias = await inspectLaunchPath(junction, { cwd: root, platform: process.platform });
      expect(viaAlias.ok).toBe(true);
    }
  });
});
