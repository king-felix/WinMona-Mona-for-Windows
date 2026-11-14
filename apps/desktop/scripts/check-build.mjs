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
  // The shipped slash catalog carries its provenance label ("GET /v1/commands"),
  // which is data, not a callable route. Every other engine path is refused.
  const withoutProvenance = text.split('GET /v1/commands').join('');
  if (/\/v1\//.test(withoutProvenance)) failures.push(`${rel}: renderer contains an engine API route`);
}

const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
if (!/Content-Security-Policy/.test(html)) failures.push('index.html: missing CSP meta');
if (!/connect-src 'none'/.test(html)) failures.push('index.html: production CSP does not deny network');

const preload = await readFile(path.join(repoRoot, 'apps', 'desktop', 'dist', 'preload', 'preload.cjs'), 'utf8');
const channels = [...new Set([...preload.matchAll(/mona:[a-z-]+/g)].map((match) => match[0]))].sort();
const expectedChannels = [
  'mona:agents-cancel-agent-run',
  'mona:agents-cancel-task',
  'mona:agents-complete-goal',
  'mona:agents-create-fleet-run',
  'mona:agents-create-goal',
  'mona:agents-get',
  'mona:agents-interrupt-worker',
  'mona:agents-start-fleet-run',
  'mona:agents-stop-fleet-run',
  'mona:app-info',
  'mona:appearance-event',
  'mona:appearance-get',
  'mona:appearance-zoom',
  'mona:attention-focus',
  'mona:attention-get',
  'mona:attention-quit-stop',
  'mona:attention-set',
  'mona:briefing-get',
  'mona:capabilities-check-terminal',
  'mona:capabilities-get',
  'mona:capabilities-read-log',
  'mona:catalog-create',
  'mona:catalog-list',
  'mona:catalog-open',
  'mona:catalog-pick-folder',
  'mona:catalog-relocate',
  'mona:catalog-remove',
  'mona:catalog-reveal',
  'mona:catalog-select',
  'mona:catalog-update',
  'mona:changes-capture',
  'mona:changes-diff',
  'mona:changes-view',
  'mona:command-dispatch',
  'mona:cost-budget-set',
  'mona:cost-export',
  'mona:cost-lens',
  'mona:engine-start',
  'mona:engine-state',
  'mona:engine-stop',
  'mona:extensions-check-mcp',
  'mona:extensions-get',
  'mona:extensions-set-mcp',
  'mona:launch-event',
  'mona:launch-state',
  'mona:memory-diagnostics-preview',
  'mona:memory-portable-export',
  'mona:memory-portable-import',
  'mona:memory-prompt-export',
  'mona:memory-prompt-import',
  'mona:memory-prompt-preview',
  'mona:memory-prompt-remove',
  'mona:memory-prompt-save',
  'mona:memory-reindex',
  'mona:memory-search',
  'mona:project-spend',
  'mona:provider-apply-mode',
  'mona:provider-apply-permission',
  'mona:provider-apply-route',
  'mona:provider-get',
  'mona:studio-event',
  'mona:studio-export',
  'mona:studio-get',
  'mona:studio-history',
  'mona:studio-interrupt',
  'mona:studio-pause',
  'mona:studio-pick-references',
  'mona:studio-respond',
  'mona:studio-resume',
  'mona:studio-search',
  'mona:studio-submit',
  'mona:task-board',
  'mona:task-create',
  'mona:terminal-copy',
  'mona:terminal-create',
  'mona:terminal-event',
  'mona:terminal-input',
  'mona:terminal-kill',
  'mona:terminal-refresh',
  'mona:terminal-resize',
  'mona:ui-get',
  'mona:ui-new-session',
  'mona:ui-remove-favorite',
  'mona:ui-save-draft',
  'mona:ui-save-favorite',
  'mona:ui-set-layout',
  'mona:ui-set-view',
  'mona:window-event',
  'mona:window-set-fullscreen',
  'mona:window-state',
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
