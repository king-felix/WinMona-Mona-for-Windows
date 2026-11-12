#!/usr/bin/env node
// Command surface for Mona's per-user Windows lifecycle.
//
//   node tools/install/cli.mjs stage                 build the install payload
//   node tools/install/cli.mjs package [--test-sign] build (and optionally sign) the identity package
//   node tools/install/cli.mjs trust-test-certificate  import the labelled test certificate (explicit)
//   node tools/install/cli.mjs install [--close-running] [--force] [--no-classic]
//   node tools/install/cli.mjs upgrade [--close-running] [--force]
//   node tools/install/cli.mjs uninstall [--force]
//   node tools/install/cli.mjs status
//   node tools/install/cli.mjs verify [--smoke]
//
// Exit codes: 0 success, 1 failure, 3 deferred because Mona is running, 4 a
// prerequisite (toolchain, payload, trust) is missing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  artifactPaths,
  buildStage,
  createTestCertificate,
  install,
  packIdentityPackage,
  readJson,
  resolveLayout,
  sha256File,
  signPackage,
  stageSummary,
  status,
  uninstall,
  verifyInstall,
  verifyPackageSignature,
  verifyPtyBinaries,
  writeReleaseChecksums,
} from './installer.mjs';

function parse(argv) {
  const options = {
    command: argv[0] ?? 'status',
    json: null,
    stage: null,
    nativeArchive: null,
    force: false,
    closeRunning: false,
    classicMenu: true,
    skipPackage: false,
    testSign: false,
    smoke: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === '--json') options.json = value();
    else if (arg === '--stage') options.stage = value();
    else if (arg === '--native-archive') options.nativeArchive = value();
    else if (arg === '--force') options.force = true;
    else if (arg === '--close-running') options.closeRunning = true;
    else if (arg === '--no-classic') options.classicMenu = false;
    else if (arg === '--skip-package') options.skipPackage = true;
    else if (arg === '--test-sign') options.testSign = true;
    else if (arg === '--smoke') options.smoke = true;
    else throw new Error(`Unsupported option: ${arg}`);
  }
  return options;
}

function runInstalledSmoke(layout) {
  const exe = path.join(layout.installRoot, 'Mona.exe');
  if (!existsSync(exe)) return { ok: false, error: 'The installed executable is missing.' };
  const userData = mkdtempSync(path.join(tmpdir(), 'mona-installed-smoke-'));
  const output = path.join(userData, 'smoke.json');
  const result = spawnSync(exe, ['--smoke-test'], {
    cwd: layout.installRoot,
    env: { ...process.env, MONA_USER_DATA: userData, MONA_SMOKE_OUT: output },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  let report = null;
  if (existsSync(output)) {
    try {
      report = JSON.parse(readFileSync(output, 'utf8'));
    } catch {
      report = null;
    }
  }
  rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
  return {
    ok: result.status === 0 && report?.ok === true,
    exit: result.status,
    version: report?.appVersion ?? null,
    renderer: report?.dom ? 'rendered' : 'unknown',
    stderr: (result.stderr ?? '').trim().slice(-600),
  };
}

function readSigning(layout) {
  return readJson(artifactPaths(layout).signing);
}

async function main() {
  const options = parse(process.argv.slice(2));
  const layout = resolveLayout();
  const stage = options.stage ?? layout.stage;
  let output;
  let exitCode = 0;

  if (options.command === 'stage') {
    output = await buildStage(layout, { stage, nativeArchive: options.nativeArchive });
  } else if (options.command === 'package') {
    const packed = packIdentityPackage(layout, { stage });
    let certificate = null;
    let signed = null;
    if (packed.ok && (options.testSign || process.env.MONA_SIGN_PFX)) {
      if (process.env.MONA_SIGN_PFX) {
        certificate = { ok: true, thumbprint: null, labeledTestCertificate: false, external: true };
      } else {
        certificate = existsSync(artifactPaths(layout).signing)
          ? { reused: true, ...readSigning(layout) }
          : createTestCertificate(layout);
      }
      if (certificate.ok) signed = signPackage(layout);
    }
    const verification = packed.ok ? verifyPackageSignature(layout) : null;
    const checksums = packed.ok ? writeReleaseChecksums(layout) : null;
    output = {
      packed,
      certificate: certificate
        ? { ok: certificate.ok, thumbprint: certificate.thumbprint ?? null, labeledTestCertificate: true }
        : null,
      signed,
      verification,
      checksums,
      signingStatus: signed?.ok
        ? 'test-signed with a self-created certificate; not a production signature'
        : 'unsigned — no signature exists and none is claimed',
    };
    if (!packed.ok) exitCode = 4;
  } else if (options.command === 'trust-test-certificate') {
    const artifacts = artifactPaths(layout);
    if (!existsSync(artifacts.certificate)) {
      output = { ok: false, error: 'No test certificate exists. Run: node tools/install/cli.mjs package --test-sign' };
      exitCode = 4;
    } else {
      const { runPackageAction } = await import('./installer.mjs');
      output = {
        ...runPackageAction(layout, 'trust-certificate', { certificate: artifacts.certificate }),
        certificate: artifacts.certificate,
      };
      if (!output.ok) exitCode = 1;
    }
  } else if (options.command === 'install' || options.command === 'upgrade') {
    output = await install(layout, {
      stage,
      nativeArchive: options.nativeArchive,
      force: options.force,
      closeRunning: options.closeRunning,
      classicMenu: options.classicMenu,
      skipPackage: options.skipPackage,
    });
    if (output.ok) exitCode = 0;
    else if (output.deferred) exitCode = 3;
    else exitCode = 1;
    if (options.smoke && output.ok) output.smoke = runInstalledSmoke(layout);
  } else if (options.command === 'uninstall') {
    output = await uninstall(layout, { force: options.force });
    if (output.ok) exitCode = 0;
    else if (output.deferred) exitCode = 3;
    else exitCode = 1;
  } else if (options.command === 'status') {
    output = { ...status(layout), stage: stageSummary(layout) };
  } else if (options.command === 'verify') {
    const checks = verifyInstall(layout);
    output = {
      checks,
      pty: verifyPtyBinaries(path.join(layout.installRoot, 'resources', 'app', 'node_modules')),
      menuDll: existsSync(path.join(layout.installRoot, 'MonaMenu.dll'))
        ? sha256File(path.join(layout.installRoot, 'MonaMenu.dll'))
        : null,
      smoke: options.smoke ? runInstalledSmoke(layout) : null,
    };
    exitCode = checks.ok ? 0 : 1;
  } else {
    throw new Error(`Unknown command "${options.command}".`);
  }

  const text = JSON.stringify(output, null, 2);
  if (options.json) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
    writeFileSync(options.json, `${text}\n`, 'utf8');
  }
  process.stdout.write(`${text}\n`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
