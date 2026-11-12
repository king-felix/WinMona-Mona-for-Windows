// Static checks on the built renderer. These do not prove Electron runtime
// compatibility; they prove that test fixtures, secrets, remote origins, and an
// un-replaced CSP placeholder cannot ship in the bundle.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const rendererDir = path.join(repoRoot, 'apps', 'desktop', 'dist', 'renderer');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

const files = await walk(rendererDir);
const failures = [];
for (const file of files) {
  if (!/\.(html|js|css|json)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  const rel = path.relative(repoRoot, file);
  if (/__MONA_CSP__/.test(text)) failures.push(`${rel}: CSP placeholder was not replaced`);
  if (/mona\.fixture\.test-only/.test(text)) failures.push(`${rel}: test fixture marker leaked into the build`);
  // A PowerShell round-trip can silently double-encode UTF-8. Make that
  // corruption impossible to ship rather than something a reviewer must spot.
  if (/\u00C3[\u0080-\u00BF]|\u00E2\u20AC|\u00C2\u00B7/.test(text)) {
    failures.push(`${rel}: mojibake (double-encoded UTF-8) in the renderer bundle`);
  }
  if (
    /CODEWHALE_RUNTIME_TOKEN|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|BEGIN (RSA |EC )?PRIVATE KEY|sk-[A-Za-z0-9]{16,}/.test(
      text,
    )
  ) {
    failures.push(`${rel}: possible credential material in the renderer bundle`);
  }
  const remoteOrigins = [...text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)]
    .map((match) => match[0])
    .filter((origin) => !/^https?:\/\/www\.w3\.org$/i.test(origin) && !/^https?:\/\/react\.dev$/i.test(origin));
  if (remoteOrigins.length) {
    failures.push(`${rel}: remote origin present in the renderer bundle: ${[...new Set(remoteOrigins)].join(', ')}`);
  }
  if (/fetch\s*\(\s*[`'"]https?:/i.test(text)) failures.push(`${rel}: renderer fetches an absolute remote URL`);
  if (/new WebSocket|new EventSource|XMLHttpRequest/.test(text))
    failures.push(`${rel}: renderer opens a network transport`);
  if (/\/v1\//.test(text)) failures.push(`${rel}: renderer contains an engine API route`);
}

const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
if (!/Content-Security-Policy/.test(html)) failures.push('index.html: missing CSP meta');
if (!/connect-src 'none'/.test(html)) failures.push('index.html: production CSP does not deny network');

const preload = await readFile(path.join(repoRoot, 'apps', 'desktop', 'dist', 'preload', 'preload.cjs'), 'utf8');
const channels = [...new Set([...preload.matchAll(/mona:[a-z-]+/g)].map((match) => match[0]))].sort();
const expectedChannels = [
  'mona:app-info',
  'mona:attention-focus',
  'mona:attention-get',
  'mona:attention-quit-stop',
  'mona:attention-set',
  'mona:briefing-get',
  'mona:catalog-create',
  'mona:catalog-list',
  'mona:catalog-open',
  'mona:catalog-pick-folder',
  'mona:catalog-relocate',
  'mona:catalog-remove',
  'mona:catalog-reveal',
  'mona:catalog-select',
  'mona:catalog-update',
  'mona:engine-start',
  'mona:engine-state',
  'mona:engine-stop',
  'mona:launch-event',
  'mona:launch-state',
  'mona:project-spend',
  'mona:studio-event',
  'mona:studio-get',
  'mona:studio-interrupt',
  'mona:studio-pause',
  'mona:studio-pick-references',
  'mona:studio-resume',
  'mona:studio-submit',
  'mona:ui-get',
  'mona:ui-new-session',
  'mona:ui-remove-favorite',
  'mona:ui-save-draft',
  'mona:ui-save-favorite',
  'mona:ui-set-layout',
  'mona:ui-set-view',
].sort();
if (JSON.stringify(channels) !== JSON.stringify(expectedChannels)) {
  failures.push(`preload exposes unexpected channels: ${channels.join(', ')}`);
}
if (/ipcRenderer\.invoke\([^,]+,\s*payload\)/.test(preload))
  failures.push('preload forwards an arbitrary payload channel');
if (/\brequire\(["'](?:node:)?(?:fs|child_process|net|http|https)["']\)/.test(preload))
  failures.push('preload requires a privileged Node module');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `build checks passed: ${files.length} renderer files, CSP replaced, no fixtures, no credentials, ${channels.length} named preload channels`,
);
