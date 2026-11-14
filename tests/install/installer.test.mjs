// Installer logic that must hold without touching the machine.
//
// These tests exercise pure decisions and file-level guarantees: checksum
// manifests, package version formatting, the manifest shape Explorer requires,
// the upgrade gate, and the exact registry surface the installer owns. The real
// install/uninstall run is recorded in docs/evidence/P21-windows.md.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  IDENTITY_NAME,
  PACKAGE_CLSID_BARE,
  PACKAGE_IMAGES,
  buildChecksumManifest,
  decideUpgrade,
  installPackageImages,
  installRegistryOps,
  packageVersion,
  pidAlive,
  pngSize,
  pngSolid,
  missingComServerPayloads,
  renderManifest,
  resolveLayout,
  sha256File,
  uninstallRegistryOps,
  verifyChecksumManifest,
  verifyPtyBinaries,
} from '../../tools/install/installer.mjs';

function temporary(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe('installation layout', () => {
  it('keeps the per-user roots separate from user data and Codewhale config', () => {
    const layout = resolveLayout({
      LOCALAPPDATA: 'C:\\Users\\v\\AppData\\Local',
      APPDATA: 'C:\\Users\\v\\AppData\\Roaming',
    });
    assert.equal(layout.installRoot, path.join('C:\\Users\\v\\AppData\\Local', 'Programs', 'Mona'));
    assert.equal(layout.dataRoot, path.join('C:\\Users\\v\\AppData\\Local', 'Mona'));
    assert.equal(layout.userData, path.join('C:\\Users\\v\\AppData\\Roaming', '@mona', 'desktop'));
    assert.equal(layout.userData.toLowerCase().includes('codewhale'), false);
  });

  it('formats a four-part package version', () => {
    assert.equal(packageVersion('0.1.0'), '0.1.0.0');
    assert.equal(packageVersion('1.4'), '1.4.0.0');
    assert.equal(packageVersion('2.3.4-beta.5'), '2.3.4.5');
  });
});

describe('identity package manifest', () => {
  const manifest = renderManifest({ version: '0.1.0' });

  it('declares the modern Explorer menu for folders and folder backgrounds', () => {
    assert.match(manifest, /windows\.fileExplorerContextMenus/);
    assert.match(manifest, /<desktop5:ItemType Type="Directory">/);
    assert.match(manifest, /<desktop5:ItemType Type="Directory\\Background">/);
    assert.match(manifest, new RegExp(`Clsid="${PACKAGE_CLSID_BARE}"`));
  });

  it('registers the COM server without a CLSID brace and with STA threading', () => {
    assert.match(
      manifest,
      new RegExp(`<com:Class Id="${PACKAGE_CLSID_BARE}" Path="MonaMenu.dll" ThreadingModel="STA" />`),
    );
    assert.equal(manifest.includes(`Id="{${PACKAGE_CLSID_BARE}}"`), false);
  });

  it('is a sparse package for an unpackaged app', () => {
    assert.match(manifest, /<uap10:AllowExternalContent>true<\/uap10:AllowExternalContent>/);
    assert.match(manifest, /uap10:RuntimeBehavior="win32App"/);
    assert.match(manifest, /<rescap:Capability Name="runFullTrust" \/>/);
    assert.match(manifest, new RegExp(`<Identity Name="${IDENTITY_NAME}"`));
  });

  it('requires the COM server it declares to be present in the payload', () => {
    const identity = temporary('mona-identity-');
    const empty = temporary('mona-empty-');
    try {
      writeFileSync(path.join(identity, 'AppxManifest.xml'), manifest, 'utf8');
      // Manifest and payload must not diverge: the package should satisfy the
      // declarations it ships, whatever an external location also provides.
      assert.deepEqual(missingComServerPayloads(identity), ['MonaMenu.dll']);
      writeFileSync(path.join(identity, 'MonaMenu.dll'), 'placeholder');
      assert.deepEqual(missingComServerPayloads(identity), []);
      // No manifest at all: nothing can prove the payload, so it is reported.
      assert.deepEqual(missingComServerPayloads(empty), ['MonaMenu.dll']);
    } finally {
      rmSync(identity, { recursive: true, force: true, maxRetries: 3 });
      rmSync(empty, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('checksums', () => {
  it('detects a changed file and reports a missing one', () => {
    const root = temporary('mona-checksum-');
    try {
      mkdirSync(path.join(root, 'nested'), { recursive: true });
      writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
      writeFileSync(path.join(root, 'nested', 'b.bin'), Buffer.from([0, 1, 2, 3]));
      const manifest = buildChecksumManifest(root);
      assert.deepEqual(
        manifest.files.map((entry) => entry.path),
        ['a.txt', 'nested/b.bin'],
      );
      assert.equal(verifyChecksumManifest(root, manifest).ok, true);
      assert.equal(sha256File(path.join(root, 'a.txt')).length, 64);

      writeFileSync(path.join(root, 'a.txt'), 'tampered\n');
      const changed = verifyChecksumManifest(root, manifest);
      assert.equal(changed.ok, false);
      assert.match(changed.problems.join(' '), /does not match/);

      rmSync(path.join(root, 'nested', 'b.bin'));
      const missing = verifyChecksumManifest(root, manifest);
      assert.match(missing.problems.join(' '), /is missing/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('produces a valid PNG header for fixtures', () => {
    const png = pngSolid(44, 44);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual(pngSize(png), { width: 44, height: 44 });
  });
});

describe('package artwork', () => {
  const generated = path.resolve('assets', 'brand', 'generated');

  it('ships the artwork at exactly the sizes the manifest declares', () => {
    const target = temporary('mona-assets-');
    try {
      const installed = installPackageImages(generated, target);
      assert.deepEqual(
        installed,
        PACKAGE_IMAGES.map((image) => image.file),
      );
      for (const { file, size } of PACKAGE_IMAGES) {
        const image = readFileSync(path.join(target, file));
        assert.deepEqual(pngSize(image), { width: size, height: size }, file);
      }
    } finally {
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('refuses to substitute artwork when the generated set is absent', () => {
    assert.throws(() => installPackageImages(null, temporary('mona-assets-none-')), /assets:icons/);
  });

  it('refuses an image whose size disagrees with the manifest', () => {
    const source = temporary('mona-assets-wrong-');
    const target = temporary('mona-assets-out-');
    try {
      writeFileSync(path.join(source, 'StoreLogo.png'), pngSolid(51, 51));
      assert.throws(() => installPackageImages(source, target), /manifest declares 50x50/);
    } finally {
      rmSync(source, { recursive: true, force: true, maxRetries: 3 });
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('upgrade gate', () => {
  const idle = { state: 'idle', pid: 10, projectId: null, runState: null };
  const active = { state: 'active', pid: 10, projectId: 'p1', runState: 'running' };

  it('proceeds when Mona is not running', () => {
    assert.equal(decideUpgrade({ activity: active, alive: false }).action, 'proceed');
    assert.equal(decideUpgrade({ activity: null, alive: false }).action, 'proceed');
  });

  it('defers while task work is in flight, even when asked to close', () => {
    const decision = decideUpgrade({ activity: active, alive: true, closeRunning: true });
    assert.equal(decision.action, 'defer-active');
    assert.match(decision.reason, /p1/);
  });

  it('closes an idle app only when explicitly requested', () => {
    assert.equal(decideUpgrade({ activity: idle, alive: true }).action, 'defer-running');
    assert.equal(decideUpgrade({ activity: idle, alive: true, sameVersion: true }).action, 'defer-running');
    assert.equal(decideUpgrade({ activity: idle, alive: true, closeRunning: true }).action, 'close-then-proceed');
    assert.equal(decideUpgrade({ activity: active, alive: true, force: true }).action, 'force');
  });

  it('treats only a live pid as running', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    const kill = () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal(pidAlive(999999, kill), false);
    const denied = () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    };
    assert.equal(pidAlive(999999, denied), true);
  });
});

describe('owned registry surface', () => {
  it('writes only Mona keys and the Mona uninstall entry', () => {
    const layout = resolveLayout({ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' });
    const ops = installRegistryOps(layout);
    const keys = new Set(ops.map((op) => op.key));
    assert.deepEqual([...keys].sort(), [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mona',
      'HKCU\\Software\\Mona\\Install',
    ]);
    for (const op of ops) {
      assert.equal(op.args[0], 'add');
      assert.equal(op.args.includes('/f'), true);
    }
    const removal = uninstallRegistryOps();
    assert.deepEqual(
      removal.map((op) => op.args.slice(0, 2).join(' ')),
      [
        'delete HKCU\\Software\\Mona\\Install',
        'delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mona',
      ],
    );
  });

  it('quotes the uninstall command instead of concatenating it', () => {
    const layout = resolveLayout({ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' });
    const command = installRegistryOps(layout).find((op) => op.args.includes('UninstallString'));
    assert.ok(command);
    const value = command.args[command.args.indexOf('/d') + 1];
    assert.match(value, /^".*\\uninstall\.cmd"$/);
  });
});

describe('native terminal payload', () => {
  it('requires the three Windows prebuilt binaries', () => {
    const root = temporary('mona-pty-');
    try {
      const ok = verifyPtyBinaries(root);
      assert.equal(ok.ok, false);
      assert.deepEqual(ok.missing.sort(), ['conpty.node', 'pty.node', 'winpty.dll'].sort());
      const directory = path.join(root, 'node-pty', 'prebuilds', `win32-${process.arch}`);
      mkdirSync(directory, { recursive: true });
      for (const file of ['pty.node', 'conpty.node', 'winpty.dll']) writeFileSync(path.join(directory, file), 'x');
      const verified = verifyPtyBinaries(root);
      assert.equal(verified.ok, true);
      assert.deepEqual(verified.files.sort(), ['conpty.node', 'pty.node']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
