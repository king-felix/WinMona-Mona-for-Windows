// Per-user installation, upgrade, uninstall and identity-package lifecycle.
//
// Ground rules this module enforces:
//  - per user, no elevation, no machine-wide keys;
//  - only Mona-owned files and keys are written, and only those are removed;
//  - the user's projects, Mona's local history, and any existing Codewhale
//    installation/configuration are never touched;
//  - an upgrade never interrupts an active run, and never silently force-quits;
//  - nothing is described as signed unless a signature really exists.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_NAME = 'MonaWorkbench';
export const PACKAGE_PUBLISHER = 'CN=Mona Development';
export const PACKAGE_CLSID = '{6D2F1C9A-4B7E-4E51-9A3C-1F8E5B0D7C42}';
export const PACKAGE_CLSID_BARE = '6D2F1C9A-4B7E-4E51-9A3C-1F8E5B0D7C42';
export const MENU_LABEL = 'Start new DS project with Mona';
export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mona';
export const INSTALL_KEY = 'HKCU\\Software\\Mona\\Install';
export const IDENTITY_NAME = 'MonaWorkbench';
export const SDK_VERSION = '10.0.28000.0';

/* ------------------------------------------------------------------------- */
/* Layout                                                                     */
/* ------------------------------------------------------------------------- */

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The installer also runs from its installed copy, where the repository does not
 * exist. Resolve the version from whatever real source is present, and never
 * invent one.
 */
export function detectVersion(repoRoot, dataRoot) {
  const candidates = [
    path.join(repoRoot, 'apps', 'desktop', 'package.json'),
    path.join(repoRoot, 'resources', 'app', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const version = readJson(candidate).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // Try the next real source.
    }
  }
  const state = path.join(dataRoot, 'install-state.json');
  if (existsSync(state)) {
    try {
      const version = readJson(state).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // Fall through to the explicit unknown marker.
    }
  }
  return '0.0.0-uninstalled';
}

export function resolveLayout(env = process.env, repoRoot = path.resolve(here, '..', '..')) {
  const localAppData = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? process.cwd(), 'AppData', 'Local');
  const appData = env.APPDATA ?? path.join(env.USERPROFILE ?? process.cwd(), 'AppData', 'Roaming');
  const dataRoot = env.MONA_DATA_ROOT ?? path.join(localAppData, 'Mona');
  const sdkBin =
    env.MONA_SDK_BIN ??
    path.join(repoRoot, 'node_modules', '.cache', 'mona-build-tools', 'sdk-buildtools', 'bin', SDK_VERSION, 'x64');
  return {
    repoRoot,
    // MONA_VERSION exists for upgrade verification: it labels a test build so a
    // replace-in-place can be observed, and is never a silent product version.
    version: env.MONA_VERSION ?? detectVersion(repoRoot, dataRoot),
    installRoot: env.MONA_INSTALL_ROOT ?? path.join(localAppData, 'Programs', 'Mona'),
    dataRoot: env.MONA_DATA_ROOT ?? path.join(localAppData, 'Mona'),
    // The packaged app keeps its existing application identity so the current
    // user's project database and history are the same data, not a new profile.
    userData: env.MONA_USER_DATA ?? path.join(appData, '@mona', 'desktop'),
    stage: env.MONA_STAGE ?? path.join(repoRoot, 'build', 'install-stage'),
    electronDist: path.join(repoRoot, 'node_modules', 'electron', 'dist'),
    makeappx: path.join(sdkBin, 'makeappx.exe'),
    signtool: path.join(sdkBin, 'signtool.exe'),
    sdks: { bin: sdkBin },
  };
}

export function artifactPaths(layout) {
  const version = layout.version;
  return {
    directory: path.join(layout.dataRoot, 'artifacts'),
    msix: path.join(layout.dataRoot, 'artifacts', `Mona-${version}-x64.msix`),
    certificate: path.join(layout.dataRoot, 'artifacts', `Mona-test-signing-${version}.cer`),
    checksums: path.join(layout.dataRoot, 'artifacts', `SHA256SUMS-${version}.txt`),
    signing: path.join(layout.dataRoot, 'signing', 'test-signing.json'),
    pfx: path.join(layout.dataRoot, 'signing', 'test-signing.pfx'),
    state: path.join(layout.dataRoot, 'install-state.json'),
    logs: path.join(layout.dataRoot, 'logs'),
  };
}

export function packageVersion(version) {
  const parts = String(version)
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

/* ------------------------------------------------------------------------- */
/* Checksums                                                                  */
/* ------------------------------------------------------------------------- */

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return files.sort();
}

export function buildChecksumManifest(root) {
  return {
    schema: 1,
    generatedUtc: new Date().toISOString(),
    files: listFiles(root).map((relative) => {
      const full = path.join(root, relative);
      return { path: relative, bytes: statSync(full).size, sha256: sha256File(full) };
    }),
  };
}

export function verifyChecksumManifest(root, manifest) {
  const problems = [];
  for (const entry of manifest.files) {
    const full = path.join(root, entry.path);
    if (!existsSync(full)) {
      problems.push(`${entry.path} is missing`);
      continue;
    }
    const observed = sha256File(full);
    if (observed !== entry.sha256) problems.push(`${entry.path} does not match its checksum`);
  }
  return { ok: problems.length === 0, files: manifest.files.length, problems };
}

/* ------------------------------------------------------------------------- */
/* Identity package                                                           */
/* ------------------------------------------------------------------------- */

export function renderManifest({ version }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop5="http://schemas.microsoft.com/appx/manifest/desktop/windows10/5"
  IgnorableNamespaces="uap uap10 rescap com desktop4 desktop5">
  <Identity Name="${IDENTITY_NAME}" Publisher="${PACKAGE_PUBLISHER}" Version="${packageVersion(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Mona</DisplayName>
    <PublisherDisplayName>Mona</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26200.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Mona" Executable="Mona.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <uap:VisualElements
        DisplayName="Mona"
        Description="Mona is a local desktop workbench for Codewhale."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="Mona Explorer commands">
              <com:Class Id="${PACKAGE_CLSID_BARE}" Path="MonaMenu.dll" ThreadingModel="STA" />
            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>
        <desktop4:Extension Category="windows.fileExplorerContextMenus">
          <desktop4:FileExplorerContextMenus>
            <desktop5:ItemType Type="Directory">
              <desktop5:Verb Id="MonaStartNewProject" Clsid="${PACKAGE_CLSID_BARE}" />
            </desktop5:ItemType>
            <desktop5:ItemType Type="Directory\\Background">
              <desktop5:Verb Id="MonaStartNewProjectBackground" Clsid="${PACKAGE_CLSID_BARE}" />
            </desktop5:ItemType>
          </desktop4:FileExplorerContextMenus>
        </desktop4:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
</Package>
`;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour RGBA PNG. Generated here so the build needs no image tool. */
export function pngSolid(width, height, [red, green, blue] = [99, 70, 223]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = red;
    row[2 + x * 4] = green;
    row[3 + x * 4] = blue;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------------- */
/* Staging                                                                    */
/* ------------------------------------------------------------------------- */

const RUNTIME_PACKAGES = ['@mona/adapter', '@mona/contracts', '@mona/project-state', 'zod'];
const PTY_PACKAGE = 'node-pty';

function copyPackage(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  // Workspace packages are symlinked into node_modules; dereference so the
  // installed copy is self-contained.
  cpSync(source, destination, { recursive: true, dereference: true });
}

/**
 * node-pty ships its Windows binaries under prebuilds/win32-x64. The installer
 * copies them as files, and can also unpack an archive, so a distribution that
 * delivers the module as a compressed payload still ends up with loadable
 * binaries (ISSUE-0022).
 */
export function unpackNativeArchive(archive, destination, run = spawnSync) {
  mkdirSync(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = run(tar, ['-xf', archive, '-C', destination], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Could not unpack ${archive}: ${(result.stderr ?? '').trim()}`);
  }
  return destination;
}

export function verifyPtyBinaries(nodeModulesRoot) {
  const prebuilds = path.join(nodeModulesRoot, PTY_PACKAGE, 'prebuilds', `win32-${process.arch}`);
  const required = ['pty.node', 'conpty.node', 'winpty.dll'];
  const missing = required.filter((name) => !existsSync(path.join(prebuilds, name)));
  return {
    ok: missing.length === 0,
    directory: prebuilds,
    missing,
    files: existsSync(prebuilds) ? readdirSync(prebuilds).filter((name) => name.endsWith('.node')) : [],
  };
}

export async function buildStage(layout, options = {}) {
  const dist = path.join(layout.repoRoot, 'apps', 'desktop', 'dist');
  if (!existsSync(path.join(dist, 'main', 'main.js'))) {
    throw new Error('apps/desktop/dist is missing. Run: npm run build');
  }
  if (!existsSync(path.join(layout.electronDist, 'electron.exe'))) {
    throw new Error(`Electron runtime is missing at ${layout.electronDist}.`);
  }
  const menuDll = path.join(layout.repoRoot, 'native', 'windows-shell', 'dist', 'MonaMenu.dll');
  if (!existsSync(menuDll)) {
    throw new Error('The menu helper is not built. Run: node native/windows-shell/build.mjs');
  }

  const stage = options.stage ?? layout.stage;
  rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(stage, { recursive: true });

  // 1. Electron runtime, renamed so the documented CLI contract is Mona.exe.
  cpSync(layout.electronDist, stage, { recursive: true });
  renameSync(path.join(stage, 'electron.exe'), path.join(stage, 'Mona.exe'));

  // 2. Application payload.
  const appRoot = path.join(stage, 'resources', 'app');
  mkdirSync(appRoot, { recursive: true });
  const desktopPackage = readJson(path.join(layout.repoRoot, 'apps', 'desktop', 'package.json'));
  writeFileSync(
    path.join(appRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: desktopPackage.name,
        productName: 'Mona',
        version: desktopPackage.version,
        private: true,
        type: 'module',
        main: 'dist/main/main.js',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  cpSync(path.join(dist, 'main'), path.join(appRoot, 'dist', 'main'), { recursive: true });
  cpSync(path.join(dist, 'shared'), path.join(appRoot, 'dist', 'shared'), { recursive: true });
  cpSync(path.join(dist, 'preload'), path.join(appRoot, 'dist', 'preload'), { recursive: true });
  cpSync(path.join(dist, 'renderer'), path.join(appRoot, 'dist', 'renderer'), { recursive: true });
  cpSync(path.join(dist, 'resources'), path.join(appRoot, 'dist', 'resources'), { recursive: true });

  // 3. Runtime dependencies: the compiled workspace packages plus node-pty.
  const modulesRoot = path.join(appRoot, 'node_modules');
  for (const name of RUNTIME_PACKAGES) {
    const source = path.join(layout.repoRoot, 'node_modules', ...name.split('/'));
    if (!existsSync(source)) throw new Error(`Runtime dependency is missing: ${name}. Run npm install.`);
    copyPackage(source, path.join(modulesRoot, ...name.split('/')));
  }
  const ptySource = path.join(layout.repoRoot, 'node_modules', PTY_PACKAGE);
  if (options.nativeArchive) {
    unpackNativeArchive(options.nativeArchive, path.join(modulesRoot, PTY_PACKAGE));
  } else {
    copyPackage(ptySource, path.join(modulesRoot, PTY_PACKAGE));
  }
  const pty = verifyPtyBinaries(modulesRoot);
  if (!pty.ok) throw new Error(`node-pty binaries are missing: ${pty.missing.join(', ')}`);

  // 4. Modern-menu helper and the installer that must survive the repo.
  cpSync(menuDll, path.join(stage, 'MonaMenu.dll'));
  const installerDir = path.join(stage, 'installer');
  mkdirSync(installerDir, { recursive: true });
  for (const file of ['installer.mjs', 'cli.mjs']) {
    cpSync(path.join(here, file), path.join(installerDir, file));
  }
  cpSync(
    path.join(layout.repoRoot, 'tools', 'launch', 'context-menu.mjs'),
    path.join(installerDir, 'context-menu.mjs'),
  );
  writeFileSync(path.join(installerDir, 'package.ps1'), PACKAGE_PS1, 'utf8');
  writeFileSync(path.join(stage, 'uninstall.cmd'), UNINSTALL_CMD, 'ascii');

  // 5. Identity package source (manifest + logos).
  const identity = path.join(stage, 'identity');
  mkdirSync(path.join(identity, 'Assets'), { recursive: true });
  writeFileSync(path.join(identity, 'AppxManifest.xml'), renderManifest({ version: layout.version }), 'utf8');
  writeFileSync(path.join(identity, 'Assets', 'StoreLogo.png'), pngSolid(50, 50));
  writeFileSync(path.join(identity, 'Assets', 'Square44x44Logo.png'), pngSolid(44, 44));
  writeFileSync(path.join(identity, 'Assets', 'Square150x150Logo.png'), pngSolid(150, 150));

  const manifest = buildChecksumManifest(stage);
  writeFileSync(path.join(stage, 'checksums.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    stage,
    version: layout.version,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
    pty,
    menuDll: { path: path.join(stage, 'MonaMenu.dll'), sha256: sha256File(path.join(stage, 'MonaMenu.dll')) },
  };
}

// cmd.exe requires CRLF; an LF-only batch file is misparsed.
export const UNINSTALL_CMD = [
  '@echo off',
  "rem Runs the installed copy of the uninstaller with Electron's bundled Node.",
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=1',
  '"%~dp0Mona.exe" "%~dp0installer\\cli.mjs" uninstall %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

/* ------------------------------------------------------------------------- */
/* Running-state gate                                                         */
/* ------------------------------------------------------------------------- */

export function pidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * An upgrade is allowed when nothing is running. A running app with a task in
 * flight is never interrupted; a running idle app is closed only when the caller
 * explicitly asked for that.
 */
export function decideUpgrade({ activity, alive, force = false, closeRunning = false, sameVersion = false }) {
  if (!alive) return { action: 'proceed', reason: 'Mona is not running.' };
  if (force) return { action: 'force', reason: 'Forced by the operator; running work may be interrupted.' };
  if (activity?.state === 'active') {
    return {
      action: 'defer-active',
      reason: `Mona is running task work in ${activity.projectId ?? 'a project'} (${activity.runState ?? 'active'}).`,
    };
  }
  if (closeRunning) {
    return { action: 'close-then-proceed', reason: 'Mona is running idle; closing it as requested.' };
  }
  return {
    action: 'defer-running',
    reason: sameVersion
      ? 'Mona is running. Close it, or pass --close-running, to reinstall in place.'
      : 'Mona is running. Close it, or pass --close-running, to upgrade.',
  };
}

export function readActivity(layout, read = readFileSync) {
  const file = path.join(layout.userData, 'runtime', 'activity.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(read(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function requestClose(pid, timeoutMs = 20000) {
  if (!pidAlive(pid)) return { closed: true, detail: 'Mona was already closed.' };
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  spawnSync(taskkill, ['/PID', String(pid)], { windowsHide: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return { closed: true, detail: 'Mona closed.' };
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { windowsHide: true });
  }
  return { closed: false, detail: 'Mona did not close within the grace period.' };
}

/* ------------------------------------------------------------------------- */
/* Registry and Windows helpers                                               */
/* ------------------------------------------------------------------------- */

export function runExe(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export function reg(args, run = runExe) {
  const regExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return run(regExe, args);
}

export function installRegistryOps(layout) {
  const exe = path.join(layout.installRoot, 'Mona.exe');
  const dll = path.join(layout.installRoot, 'MonaMenu.dll');
  const values = [
    ['MonaExe', exe],
    ['MonaMenuDll', dll],
    ['Version', layout.version],
    ['InstallRoot', layout.installRoot],
    ['UserData', layout.userData],
  ];
  const ops = values.map(([name, value]) => ({
    key: INSTALL_KEY,
    args: ['add', INSTALL_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
  }));
  ops.push({
    key: UNINSTALL_KEY,
    args: ['add', UNINSTALL_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Mona', '/f'],
  });
  for (const [name, value] of [
    ['DisplayVersion', layout.version],
    ['Publisher', 'Mona'],
    ['InstallLocation', layout.installRoot],
    ['DisplayIcon', exe],
    ['UninstallString', `"${path.join(layout.installRoot, 'uninstall.cmd')}"`],
  ]) {
    ops.push({
      key: UNINSTALL_KEY,
      args: ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    });
  }
  for (const name of ['NoModify', 'NoRepair']) {
    ops.push({ key: UNINSTALL_KEY, args: ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_DWORD', '/d', '1', '/f'] });
  }
  return ops;
}

export function uninstallRegistryOps() {
  return [
    { key: INSTALL_KEY, args: ['delete', INSTALL_KEY, '/f'] },
    { key: UNINSTALL_KEY, args: ['delete', UNINSTALL_KEY, '/f'] },
  ];
}

export function readRegistryValues(key, run = reg) {
  const result = run(['query', key]);
  if (result.status !== 0) return null;
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s{2,}(\S(?:.*?\S)?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line);
    if (match) values[match[1]] = match[3].trim();
  }
  return values;
}

function classicMenuScript(layout) {
  const local = path.join(here, 'context-menu.mjs');
  if (existsSync(local)) return local;
  return path.join(layout.repoRoot, 'tools', 'launch', 'context-menu.mjs');
}

export function registerClassicMenu(layout, run = runExe) {
  const script = classicMenuScript(layout);
  const exe = path.join(layout.installRoot, 'Mona.exe');
  mkdirSync(path.join(layout.dataRoot, 'logs'), { recursive: true });
  return run(process.execPath, [
    script,
    'register',
    '--exe',
    exe,
    '--json',
    path.join(layout.dataRoot, 'logs', 'classic-menu.json'),
  ]);
}

export function unregisterClassicMenu(layout, run = runExe) {
  const script = classicMenuScript(layout);
  return run(process.execPath, [script, 'unregister']);
}

/* ------------------------------------------------------------------------- */
/* Identity package lifecycle (PowerShell bridge)                             */
/* ------------------------------------------------------------------------- */

export const PACKAGE_PS1 = `param(
  [Parameter(Mandatory = $true)][ValidateSet('install','remove','status','trust-certificate')][string]$Action,
  [string]$Msix,
  [string]$ExternalLocation,
  [string]$Certificate
)
$ErrorActionPreference = 'Stop'
function Reply($object) { Write-Output ($object | ConvertTo-Json -Compress -Depth 6) }
try {
  switch ($Action) {
    'install' {
      Add-AppxPackage -Path $Msix -ExternalLocation $ExternalLocation -ErrorAction Stop
      $package = Get-AppxPackage -Name '${IDENTITY_NAME}' | Select-Object -First 1
      Reply @{ ok = $true; packageFullName = $package.PackageFullName; installLocation = $package.InstallLocation }
    }
    'remove' {
      $packages = @(Get-AppxPackage -Name '${IDENTITY_NAME}')
      foreach ($package in $packages) { Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop }
      Reply @{ ok = $true; removed = $packages.Count }
    }
    'status' {
      $packages = @(Get-AppxPackage -Name '${IDENTITY_NAME}')
      Reply @{ ok = $true; installed = $packages.Count; packages = @($packages | ForEach-Object { @{ fullName = $_.PackageFullName; status = "$($_.Status)"; location = $_.InstallLocation } }) }
    }
    'trust-certificate' {
      # Adding this certificate to the current user's Root store is what makes a
      # test-signed package installable. Windows shows a security warning that a
      # person must accept; that is the point, and it is never done silently.
      Import-Certificate -FilePath $Certificate -CertStoreLocation 'Cert:\\CurrentUser\\Root' -ErrorAction Stop | Out-Null
      Reply @{ ok = $true; store = 'Cert:\\CurrentUser\\Root'; certificate = $Certificate }
    }
  }
} catch {
  $exception = $_.Exception
  $code = $null
  if ($exception -is [System.Runtime.InteropServices.COMException]) { $code = '0x{0:X8}' -f $exception.HResult }
  Reply @{ ok = $false; error = $exception.Message; code = $code; action = $Action }
}
`;

function packageScript(layout) {
  const candidates = [path.join(here, 'package.ps1'), path.join(layout.installRoot, 'installer', 'package.ps1')];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const generated = path.join(layout.dataRoot, 'logs', 'package.ps1');
  mkdirSync(path.dirname(generated), { recursive: true });
  writeFileSync(generated, PACKAGE_PS1, 'utf8');
  return generated;
}

export function runPackageAction(layout, action, options = {}, run = runExe) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    packageScript(layout),
    '-Action',
    action,
  ];
  if (options.msix) args.push('-Msix', options.msix);
  if (options.externalLocation) args.push('-ExternalLocation', options.externalLocation);
  if (options.certificate) args.push('-Certificate', options.certificate);
  const result = run('powershell.exe', args, { timeout: 180000 });
  try {
    return { ...JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1)), exit: result.status };
  } catch {
    return { ok: false, exit: result.status, error: result.stderr || result.stdout || 'no output' };
  }
}

/* ------------------------------------------------------------------------- */
/* Signing                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A clearly labelled local test certificate. It is created in the current
 * user's store only; nothing is trusted until the operator runs the separate
 * `trust-test-certificate` command, and uninstall removes the certificate.
 */
export function createTestCertificate(layout, run = runExe) {
  const artifacts = artifactPaths(layout);
  mkdirSync(path.dirname(artifacts.pfx), { recursive: true });
  mkdirSync(artifacts.directory, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  const script = `$ErrorActionPreference='Stop'
$cert = New-SelfSignedCertificate -Type Custom -Subject '${PACKAGE_PUBLISHER}' -KeyUsage DigitalSignature -FriendlyName 'Mona local test signing (not for distribution)' -CertStoreLocation 'Cert:\\CurrentUser\\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}') -NotAfter (Get-Date).AddYears(1)
$secure = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${artifacts.pfx}' -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath '${artifacts.certificate}' | Out-Null
@{ ok = $true; thumbprint = $cert.Thumbprint; subject = $cert.Subject; notAfter = $cert.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120000 });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1));
  } catch {
    return { ok: false, error: result.stderr || result.stdout || 'certificate creation produced no output' };
  }
  if (!parsed?.ok) return { ok: false, error: parsed?.error ?? 'certificate creation failed' };
  writeFileSync(
    artifacts.signing,
    `${JSON.stringify({ ...parsed, password, pfx: artifacts.pfx, labeledTestCertificate: true, createdUtc: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return { ...parsed, ok: true, pfx: artifacts.pfx, certificate: artifacts.certificate };
}

export function packIdentityPackage(layout, options = {}, run = runExe) {
  const artifacts = artifactPaths(layout);
  mkdirSync(artifacts.directory, { recursive: true });
  if (!existsSync(layout.makeappx)) throw new Error(`makeappx.exe is missing at ${layout.makeappx}`);
  const identity = path.join(options.stage ?? layout.stage, 'identity');
  if (!existsSync(path.join(identity, 'AppxManifest.xml'))) throw new Error('The staged identity manifest is missing.');
  // /nv skips payload validation, which is required because Mona's binaries live
  // in the external location by design. The manifest is schema-checked
  // separately by a registration probe, which reports schema errors first.
  const result = run(layout.makeappx, ['pack', '/d', identity, '/p', artifacts.msix, '/o', '/nv'], { timeout: 180000 });
  return {
    ok: result.status === 0,
    msix: artifacts.msix,
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

export function signPackage(layout, options = {}, run = runExe) {
  const artifacts = artifactPaths(layout);
  if (!existsSync(layout.signtool)) return { ok: false, error: `signtool.exe is missing at ${layout.signtool}` };
  if (!existsSync(artifacts.msix)) return { ok: false, error: 'No identity package has been built.' };

  // A real certificate can be supplied without ever storing it in the repository.
  const externalPfx = process.env.MONA_SIGN_PFX;
  if (externalPfx) {
    const password = process.env.MONA_SIGN_PASSWORD ?? '';
    const timestamp = process.env.MONA_SIGN_TIMESTAMP;
    const args = ['sign', '/fd', 'SHA256', '/f', externalPfx, '/p', password];
    if (timestamp) args.push('/tr', timestamp, '/td', 'SHA256');
    args.push(artifacts.msix);
    const result = run(layout.signtool, args, { timeout: 180000 });
    return {
      ok: result.status === 0,
      status: result.status,
      labeledTestCertificate: false,
      timestamped: Boolean(timestamp),
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  }

  if (!existsSync(artifacts.signing)) {
    return { ok: false, error: 'No certificate was supplied and no test certificate has been created.' };
  }
  const signing = readJson(artifacts.signing);
  const result = run(
    layout.signtool,
    ['sign', '/fd', 'SHA256', '/f', signing.pfx, '/p', signing.password, artifacts.msix],
    { timeout: 180000 },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    thumbprint: signing.thumbprint,
    labeledTestCertificate: true,
    timestamped: false,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

export function verifyPackageSignature(layout, run = runExe) {
  const artifacts = artifactPaths(layout);
  const result = run(layout.signtool, ['verify', '/pa', artifacts.msix], { timeout: 120000 });
  return {
    // /pa requires a trusted chain. A local test certificate is not trusted
    // unless the operator imported it, so this reports what happened.
    trustedChain: result.status === 0,
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(0, 6).join('\n'),
    sha256: existsSync(artifacts.msix) ? sha256File(artifacts.msix) : null,
  };
}

/* ------------------------------------------------------------------------- */
/* Install / upgrade / uninstall                                              */
/* ------------------------------------------------------------------------- */

function seal(layout, stage) {
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const incoming = `${layout.installRoot}.new-${stamp}`;
  rmSync(incoming, { recursive: true, force: true });
  cpSync(stage, incoming, { recursive: true });
  const moved = { previous: null };
  if (existsSync(layout.installRoot)) {
    const old = `${layout.installRoot}.old-${stamp}`;
    renameSync(layout.installRoot, old);
    moved.previous = old;
    try {
      renameSync(incoming, layout.installRoot);
    } catch (error) {
      renameSync(old, layout.installRoot);
      throw error;
    }
    rmSync(old, { recursive: true, force: true, maxRetries: 5 });
  } else {
    renameSync(incoming, layout.installRoot);
  }
  return { installRoot: layout.installRoot, previous: moved.previous, stamp };
}

export async function install(layout, options = {}) {
  const stage = options.stage ?? layout.stage;
  const checksums = path.join(stage, 'checksums.json');
  if (!existsSync(checksums)) throw new Error(`No staged payload at ${stage}. Run: node tools/install/cli.mjs stage`);
  const verified = verifyChecksumManifest(stage, readJson(checksums));
  if (!verified.ok) return { ok: false, stage: 'checksums', problems: verified.problems };

  const activity = readActivity(layout);
  const alive = pidAlive(activity?.pid ?? 0);
  const sameVersion =
    existsSync(layout.installRoot) && readJsonOrNull(artifactPaths(layout).state)?.version === layout.version;
  const decision = decideUpgrade({
    activity,
    alive,
    force: options.force,
    closeRunning: options.closeRunning,
    sameVersion,
  });
  if (decision.action === 'defer-active' || decision.action === 'defer-running') {
    return { ok: false, deferred: true, action: decision.action, reason: decision.reason, activity };
  }
  let closed = null;
  if (decision.action === 'close-then-proceed') {
    closed = requestClose(activity.pid);
    if (!closed.closed) return { ok: false, deferred: true, action: 'defer-running', reason: closed.detail, activity };
  }

  const placement = seal(layout, stage);

  // Registry: only Mona's own keys.
  const registryResults = [];
  for (const op of installRegistryOps(layout)) registryResults.push({ ...reg(op.args), key: op.key });
  const registryFailures = registryResults.filter((entry) => entry.status !== 0);

  // Classic menu: optional, per-user, removable. It is a complement, never a
  // stand-in for the modern menu.
  const classic = options.classicMenu === false ? { skipped: true } : summarizeClassic(registerClassicMenu(layout));

  // Modern menu: the identity package.
  let identity = null;
  if (options.skipPackage) {
    identity = { ok: false, skipped: true, reason: 'Skipped by request.' };
  } else {
    const artifacts = artifactPaths(layout);
    if (!existsSync(artifacts.msix)) {
      identity = {
        ok: false,
        registered: false,
        reason: 'No identity package has been built. Run: node tools/install/cli.mjs package',
        prerequisite:
          'Build and sign the sparse package, then either enable Windows developer mode or trust the local test certificate once.',
      };
    } else {
      const attempt = runPackageAction(layout, 'install', {
        msix: artifacts.msix,
        externalLocation: layout.installRoot,
      });
      identity = {
        ok: attempt.ok === true,
        registered: attempt.ok === true,
        packageFullName: attempt.packageFullName ?? null,
        code: attempt.code ?? null,
        error: attempt.error ?? null,
        msix: artifacts.msix,
        prerequisite: attempt.ok
          ? null
          : 'Windows refused the unsigned/test-signed package. Enable developer mode, import the labelled test certificate into Trusted People, or sign with a trusted certificate.',
      };
    }
  }

  const installedExe = path.join(layout.installRoot, 'Mona.exe');
  const state = {
    schema: 1,
    version: layout.version,
    installedUtc: new Date().toISOString(),
    installRoot: layout.installRoot,
    exe: installedExe,
    menuDll: path.join(layout.installRoot, 'MonaMenu.dll'),
    userData: layout.userData,
    files: verified.files,
    classMenu: classic,
    identity,
    signing: existsSync(artifactPaths(layout).signing)
      ? { testCertificate: true, thumbprint: readJson(artifactPaths(layout).signing).thumbprint }
      : { testCertificate: false },
  };
  mkdirSync(layout.dataRoot, { recursive: true });
  writeFileSync(artifactPaths(layout).state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const checks = verifyInstall(layout);
  return {
    ok: checks.ok && registryFailures.length === 0,
    version: layout.version,
    installRoot: layout.installRoot,
    placement,
    closed,
    decision,
    registryFailures,
    classic,
    identity,
    checks,
  };
}

function readJsonOrNull(file) {
  if (!existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function summarizeClassic(result) {
  let report = null;
  const start = result.stdout.indexOf('{');
  if (start >= 0) {
    try {
      report = JSON.parse(result.stdout.slice(start));
    } catch {
      report = null;
    }
  }
  return {
    ok: result.status === 0 && (report?.verified ?? false),
    status: result.status,
    verified: report?.verified ?? false,
  };
}

export function verifyInstall(layout) {
  const checks = {};
  const exe = path.join(layout.installRoot, 'Mona.exe');
  checks.exe = { ok: existsSync(exe), path: exe };
  checks.menuDll = { ok: existsSync(path.join(layout.installRoot, 'MonaMenu.dll')) };
  checks.renderer = {
    ok: existsSync(path.join(layout.installRoot, 'resources', 'app', 'dist', 'renderer', 'index.html')),
  };
  checks.pty = verifyPtyBinaries(path.join(layout.installRoot, 'resources', 'app', 'node_modules'));
  const stagedChecksums = path.join(layout.installRoot, 'checksums.json');
  checks.checksums = existsSync(stagedChecksums)
    ? verifyChecksumManifest(layout.installRoot, readJson(stagedChecksums))
    : { ok: false, problems: ['checksums.json is missing'] };
  const installValues = readRegistryValues(INSTALL_KEY);
  checks.registry = {
    ok: installValues?.MonaExe === exe && installValues?.Version === layout.version,
    values: installValues,
  };
  const uninstallValues = readRegistryValues(UNINSTALL_KEY);
  checks.uninstallEntry = { ok: uninstallValues?.DisplayName === 'Mona', values: uninstallValues };
  checks.package = runPackageAction(layout, 'status');
  checks.ok = Object.entries(checks).every(([name, value]) => name === 'package' || value.ok !== false);
  return checks;
}

export async function uninstall(layout, options = {}) {
  const state = readJsonOrNull(artifactPaths(layout).state);
  const activity = readActivity(layout);
  const alive = pidAlive(activity?.pid ?? 0);
  if (alive && activity?.state === 'active' && !options.force) {
    return {
      ok: false,
      deferred: true,
      reason: `Mona is running task work in ${activity.projectId ?? 'a project'}. Interrupt it before uninstalling.`,
    };
  }
  if (alive && !options.force) {
    const closed = requestClose(activity.pid);
    if (!closed.closed) return { ok: false, deferred: true, reason: closed.detail };
  }

  // Preservation sentinels: these must exist before and after.
  const preserved = preserveSentinels(layout);

  const identity = runPackageAction(layout, 'remove');
  const classic = summarizeClassic(unregisterClassicMenu(layout));
  const registry = uninstallRegistryOps().map((op) => ({ key: op.key, ...reg(op.args) }));

  // A labelled test certificate created by this installer is Mona-owned; remove
  // exactly that thumbprint and nothing else.
  const certificates = removeOwnedTestCertificate(state, layout);

  // Release artifacts stay (they are the thing the checksums describe); signing
  // material, logs and the install record are removed with the program.
  const artifacts = artifactPaths(layout);
  const removed = [];
  for (const target of [path.dirname(artifacts.pfx), artifacts.logs, artifacts.state]) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true, maxRetries: 5 });
      removed.push(target);
    }
  }
  const program = removeInstallRoot(layout.installRoot);
  if (program.removed) removed.push(layout.installRoot);

  const after = preserved.map((entry) => ({
    ...entry,
    stillThere: existsSync(entry.path),
    sha256: entry.sha256 ? (existsSync(entry.path) ? sha256File(entry.path) : null) : null,
  }));

  return {
    ok: registry.every((entry) => entry.status === 0 || /not found|unable to find/i.test(entry.stderr)),
    identity,
    classic,
    registry,
    certificates,
    removed,
    program,
    preserved: after,
    artifactsKept: existsSync(artifacts.directory) ? artifacts.directory : null,
    state: state?.version ?? null,
    codewhaleUntouched: !removed.some((target) => /codewhale/i.test(target)),
  };
}

/**
 * Windows locks the executable that is running the uninstaller. Delete what can
 * be deleted now, then let a detached command finish the directory afterwards.
 * Nothing outside Mona's own install root is ever named here.
 */
export function removeInstallRoot(root) {
  if (!existsSync(root)) return { removed: false, deferred: false, detail: 'Already absent.' };
  const inside = path
    .resolve(process.execPath)
    .toLowerCase()
    .startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`);
  if (!inside) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      return { removed: true, deferred: false, detail: 'Removed.' };
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
    }
    for (const entry of readdirSync(root)) {
      try {
        rmSync(path.join(root, entry), { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // The running executable and its mapped files stay until the process exits.
      }
    }
  }
  const script = path.join(tmpdir(), `mona-remove-${Date.now()}.cmd`);
  // When the uninstaller runs from the installed copy, cmd.exe is still reading
  // its own batch file inside this directory. Nothing is deleted here; the
  // detached command removes the whole tree once the shell has certainly exited.
  writeFileSync(
    script,
    ['@echo off', 'timeout /t 12 /nobreak >nul', `rmdir /s /q "${root}"`, 'del /q "%~f0"', ''].join('\r\n'),
    'ascii',
  );
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return {
    removed: false,
    deferred: true,
    detail: inside
      ? 'The uninstaller runs from this directory; removal completes just after it exits.'
      : 'The running executable is still mapped; removal completes just after it exits.',
    cleanup: script,
  };
}

function removeOwnedTestCertificate(state, layout) {
  let thumbprint = state?.signing?.testCertificate ? state.signing.thumbprint : null;
  if (!thumbprint) {
    // The certificate can be created after installation (packaging step), so the
    // signing record is the second real source of Mona-owned identity material.
    const signingFile = artifactPaths(layout).signing;
    if (existsSync(signingFile)) {
      try {
        const signing = readJson(signingFile);
        if (signing.labeledTestCertificate === true && typeof signing.thumbprint === 'string') {
          thumbprint = signing.thumbprint;
        }
      } catch {
        // No usable record: nothing is removed.
      }
    }
  }
  if (!thumbprint) return { removed: null, detail: 'No installer-created certificate to remove.' };
  const script = `$ErrorActionPreference='Stop'
$thumb = '${thumbprint}'
$removed = @()
foreach ($store in @('My','TrustedPeople')) {
  $path = "Cert:\\CurrentUser\\$store\\$thumb"
  if (Test-Path $path) { Remove-Item $path -Force; $removed += $store }
}
@{ ok = $true; removed = $removed; thumbprint = $thumb } | ConvertTo-Json -Compress`;
  const result = runExe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60000 });
  try {
    return { ...JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).at(-1)), status: result.status };
  } catch {
    return { ok: false, error: result.stderr || result.stdout || 'certificate removal produced no output' };
  }
}

export function preserveSentinels(layout, env = process.env) {
  const candidates = [
    path.join(layout.userData, 'state'),
    path.join(layout.userData, 'projects'),
    env.USERPROFILE ? path.join(env.USERPROFILE, '.codewhale') : null,
  ].filter(Boolean);
  return candidates.map((candidate) => {
    if (!existsSync(candidate)) return { path: candidate, present: false, sha256: null };
    const stats = statSync(candidate);
    if (stats.isFile()) return { path: candidate, present: true, sha256: sha256File(candidate) };
    const files = listFiles(candidate);
    return {
      path: candidate,
      present: true,
      sha256: null,
      entries: files.length,
      sample: files.slice(0, 3),
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Status                                                                     */
/* ------------------------------------------------------------------------- */

export function status(layout) {
  const state = readJsonOrNull(artifactPaths(layout).state);
  const activity = readActivity(layout);
  const artifacts = artifactPaths(layout);
  return {
    version: layout.version,
    paths: {
      installRoot: layout.installRoot,
      dataRoot: layout.dataRoot,
      userData: layout.userData,
      stage: layout.stage,
    },
    installed: state,
    running: { alive: pidAlive(activity?.pid ?? 0), activity },
    registry: {
      install: readRegistryValues(INSTALL_KEY),
      uninstall: readRegistryValues(UNINSTALL_KEY),
    },
    package: runPackageAction(layout, 'status'),
    artifacts: {
      msix: existsSync(artifacts.msix) ? { path: artifacts.msix, sha256: sha256File(artifacts.msix) } : null,
      certificate: existsSync(artifacts.certificate) ? artifacts.certificate : null,
      // The signing record holds the test key password; only facts leave this module.
      signing: existsSync(artifacts.signing)
        ? (() => {
            const { password, pfx, ...rest } = readJson(artifacts.signing);
            void password;
            return { ...rest, pfxPresent: existsSync(pfx) };
          })()
        : null,
    },
  };
}

/** Build the menu-free release checksum list for the local artifacts. */
export function writeReleaseChecksums(layout) {
  const artifacts = artifactPaths(layout);
  const entries = [];
  for (const file of [artifacts.msix, artifacts.certificate]) {
    if (existsSync(file)) entries.push(`${sha256File(file)}  ${path.basename(file)}`);
  }
  mkdirSync(artifacts.directory, { recursive: true });
  writeFileSync(artifacts.checksums, `${entries.join('\n')}\n`, 'utf8');
  return { ok: entries.length > 0, file: artifacts.checksums, entries };
}

export function stageSummary(layout) {
  const manifestPath = path.join(layout.stage, 'checksums.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  return { stage: layout.stage, files: manifest.files.length, generatedUtc: manifest.generatedUtc };
}
