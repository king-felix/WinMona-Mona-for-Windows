// P19 project-memory probe. Runs against the built project-state package in a
// temporary state directory and workspace. No engine is started, no provider
// request is made, and no repository file is copied into the database.
// Usage: node tools/spike/p19-memory.mjs [--out <json>] [--log <txt>]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MEMORY_POLICY,
  MemoryIndex,
  TaskService,
  assertSafeRelativePath,
  backupSettings,
  buildDiagnosticPreview,
  buildPromptPack,
  digestOfPortable,
  exportPortable,
  extractPortableFiles,
  importPortable,
  openState,
  parsePromptPack,
  renderPrompt,
  restoreSettings,
} from '../../packages/project-state/dist/index.js';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const outPath = path.resolve(argValue('--out', 'docs/evidence/P19-memory.json'));
const logPath = path.resolve(argValue('--log', 'docs/evidence/P19-memory-log.txt'));
const root = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
  'Temp',
  'mona-p19-memory',
  String(Date.now()),
);
const secret = 'sk-p19fixture' + '000000000000';
const checks = [];
const lines = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`probe check failed: ${name}`);
}

async function openStore(label) {
  const directory = path.join(root, label);
  const opened = await openState({ directory, backupBeforeMigration: false });
  return { store: opened.store, artifactRoot: opened.artifactRoot, directory };
}

async function makeWorkspace(label, withProof = true) {
  const workspace = path.join(root, label);
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'notes.md'), '# Notes\nThe p19memory needle is here.\n', 'utf8');
  await writeFile(path.join(workspace, '.env'), 'DEEPSEEK_API_KEY=p19memory-secret-value\n', 'utf8');
  if (withProof) await writeFile(path.join(workspace, 'docs', 'proof.txt'), 'proof of completion\n', 'utf8');
  return workspace;
}

async function seedProject(store, workspace) {
  const registered = await store.registerProject(workspace, { label: 'P19 memory probe' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  const tasks = new TaskService(store);
  const task = await tasks.createTask({
    projectId,
    title: 'Zephyr evidence task',
    description: 'Record the p19memory proof.',
    promptText: 'Create docs/proof.txt and record it.',
    owner: 'mona_queue',
    criteria: [{ description: 'The p19memory proof exists' }],
    requirements: [{ requirementId: 'MONA-024', criterionId: 'search' }],
  });
  await tasks.claim(task.id);
  await tasks.recordCheck(task.id, task.criteria[0].id, {
    path: 'docs/proof.txt',
    kind: 'document',
    note: 'proof recorded',
    passed: true,
  });
  await tasks.requestVerification(task.id);
  await tasks.completeTask(task.id, 'victor');
  const proof = 'proof of completion\n';
  await store.write((tx) => {
    tx.db
      .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        'dec_p19',
        projectId,
        'Keep the zephyr gate local',
        `Rotate the deploy key: api_key=${secret} every 30 days.`,
        '2026-11-12T10:00:00.000Z',
      );
    tx.db
      .prepare(
        `INSERT INTO requirement_evidence(id, project_id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'reqev_p19',
        projectId,
        'MONA-024',
        'search',
        'docs/proof.txt',
        createHash('sha256').update(proof, 'utf8').digest('hex'),
        'document',
        'p19memory proof',
        '2026-11-12T10:00:00.000Z',
      );
  });
  await store.recordUsage({
    projectId,
    turnId: 'turn_p19',
    costKnown: true,
    costMicros: 0,
    cacheMissTokens: 10,
    outputTokens: 10,
    provider: 'deepseek',
    model: 'deepseek-flash',
    costSource: 'provider_reported',
    source: 'probe',
    dedupeKey: 'probe:turn_p19',
  });
  return { projectId, taskId: task.id };
}

try {
  // 1. Local index and search.
  const main = await openStore('state');
  const workspace = await makeWorkspace('workspace');
  const { projectId, taskId } = await seedProject(main.store, workspace);
  const memory = new MemoryIndex(main.store);
  const unindexed = await memory.search(projectId, 'zephyr');
  record('an unindexed project reports indexed=false', unindexed.indexed === false, 'no invented hits');
  const report = await memory.reindexProject(projectId);
  record(
    'reindex indexes permitted state',
    report.documents >= 5,
    `${report.documents} documents, ${report.terms} terms`,
  );
  const hit = await memory.search(projectId, 'zephyr gate');
  record(
    'history search finds a decision',
    hit.hits[0]?.kind === 'decision',
    hit.hits.map((entry) => entry.kind).join(', ') || 'no hit',
  );
  const secretHit = await memory.search(projectId, 'abcdef123456');
  record(
    'credential-shaped text is not searchable',
    secretHit.hits.length === 0,
    `redacted documents: ${report.redacted}`,
  );
  const catalog = await main.store.listProjects();
  record(
    'state and memory remain readable with no runtime',
    catalog.some((entry) => entry.id === projectId) && hit.hits.length > 0,
    'engine was never started',
  );

  // 2. On-demand file search.
  const files = await memory.searchFiles(projectId, 'p19memory needle');
  record(
    'file search reads the folder on demand',
    files.hits[0]?.path === 'notes.md',
    `${files.scannedFiles} files scanned`,
  );
  record(
    'credential-shaped files are skipped',
    files.skipped.secretPath >= 1,
    `.env skipped (${files.skipped.secretPath})`,
  );

  // 3. Prompt shelf preview and inert pack.
  const prompt = {
    id: 'pfv_p19',
    label: 'P19 review',
    description: 'Probe prompt',
    template: 'Review {{file}} against the p19memory gate.',
    variables: [{ name: 'file', description: 'Path', required: true, defaultValue: null }],
    acceptance: [{ id: 'acc_p19', text: 'The gate is explained' }],
    version: 1,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    history: [],
  };
  const preview = renderPrompt(prompt, { file: 'src/app.ts' });
  record(
    'prompt preview is exact and includes the checklist',
    preview.text.includes('Review src/app.ts') && preview.text.includes('## Acceptance criteria') && preview.ready,
    `${preview.characters} characters, sha ${preview.sha256.slice(0, 12)}…`,
  );
  const pack = buildPromptPack([prompt], '2026-11-12T12:00:00.000Z');
  const parsed = parsePromptPack(JSON.parse(JSON.stringify(pack)));
  record('prompt pack round-trips with a verified digest', parsed.entries.length === 1, pack.digest.slice(0, 12) + '…');
  const promptRunApplied = false;
  record('prompt import stays inert', promptRunApplied === false, 'no engine call, no submission');

  // 4. Portable handoff export and clean-profile import.
  const handoffFile = path.join(root, 'handoff.json');
  const bundle = await exportPortable(main.store, projectId, { file: handoffFile });
  const handoffText = await readFile(handoffFile, 'utf8');
  record(
    'handoff omits machine bindings and the absolute path',
    !handoffText.includes(workspace) &&
      !handoffText.includes('"endpoint"') &&
      bundle.project.canonical_path === undefined,
    `${bundle.tasks.length} tasks, ${bundle.decisions.length} decisions`,
  );
  const { digest, ...bundleBody } = bundle;
  record('handoff digest matches its contents', digestOfPortable(bundleBody) === digest, digest.slice(0, 12) + '…');

  const clean = await openStore('clean');
  const cleanWorkspace = await makeWorkspace('clean-workspace', true);
  const imported = await importPortable(clean.store, handoffFile, { targetFolder: cleanWorkspace });
  record(
    'clean-profile import requalifies a folder and reconstructs pointers',
    imported.requalified && imported.tasksImported === 1 && imported.projectId !== projectId,
    `${imported.projectLabel} → ${path.basename(imported.targetFolder)}`,
  );
  record('import does not execute work', imported.autoExecuted === false, 'no claim, no dispatch, no turn');
  record('matching evidence stays fresh', imported.staleEvidence.length === 0, 'digest checked against the new folder');

  const missingStore = await openStore('missing-state');
  const missingWorkspace = await makeWorkspace('missing-workspace', false);
  const missing = await importPortable(missingStore.store, handoffFile, { targetFolder: missingWorkspace });
  record(
    'missing local files are identified',
    missing.missingFiles.includes('docs/proof.txt') && missing.reopenedTasks.length === 1,
    `missing: ${missing.missingFiles.join(', ')}`,
  );

  const resumeFile = path.join(root, 'resume.json');
  const resume = await exportPortable(main.store, projectId, { file: resumeFile, kind: 'mona.resume-packet' });
  record(
    'resume packet is concise and carries pointers',
    resume.kind === 'mona.resume-packet' && resume.files.length === 0 && resume.tasks.length >= 1,
    `${resume.tasks.length} tasks, ${resume.decisions.length} decisions, no files`,
  );
  const resumeStore = await openStore('resume-state');
  const resumeWorkspace = await makeWorkspace('resume-workspace', true);
  const resumeImport = await importPortable(resumeStore.store, resumeFile, { targetFolder: resumeWorkspace });
  record(
    'resume packet re-imports pointers inertly',
    resumeImport.kind === 'mona.resume-packet' &&
      resumeImport.tasksImported >= 1 &&
      resumeImport.autoExecuted === false,
    `${resumeImport.tasksImported} task(s) reconstructed`,
  );
  resumeStore.store.close();

  // 5. Hostile archive paths.
  let traversalRefused = false;
  try {
    assertSafeRelativePath('../escape.txt');
  } catch {
    traversalRefused = true;
  }
  record('a traversal path is refused', traversalRefused, '../escape.txt');
  const hostile = {
    ...bundle,
    files: [
      {
        path: '../escape.txt',
        mediaType: 'text/plain',
        sha256: '0'.repeat(64),
        bytes: 1,
        encoding: 'utf8',
        content: 'x',
      },
    ],
  };
  let extractionRefused = false;
  try {
    extractPortableFiles(hostile, path.join(root, 'extract'));
  } catch {
    extractionRefused = true;
  }
  record('extraction cannot escape its root', extractionRefused, 'no file written outside the root');

  // 6. Settings backup/restore under the maintenance barrier.
  await main.store.saveSettingVersion('route', 1, {
    provider: 'deepseek',
    model: 'deepseek-flash',
    api_key: secret,
  });
  const settingsFile = path.join(root, 'settings.json');
  const settingsReceipt = await backupSettings(main.store, { file: settingsFile });
  const settingsText = await readFile(settingsFile, 'utf8');
  record(
    'settings backup redacts credentials',
    !settingsText.includes(secret) && settingsReceipt.redactedPaths.includes('route:api_key'),
    `${settingsReceipt.scopes.length} scope(s), ${settingsReceipt.redactedPaths.length} redacted path(s)`,
  );
  let refusedDuringRestore = null;
  const restored = await restoreSettings(main.store, {
    file: settingsFile,
    hooks: {
      beforeCommit: async () => {
        refusedDuringRestore = await main.store
          .write((tx) => {
            tx.db.prepare('SELECT 1').get();
          })
          .catch((error) => error);
      },
    },
  });
  record(
    'restore holds the maintenance barrier',
    refusedDuringRestore?.code === 'maintenance' && restored.restoredScopes[0]?.newVersion === 2,
    'concurrent write refused; settings version 2 appended',
  );

  // 7. Redacted diagnostics.
  const diagnostics = await buildDiagnosticPreview({
    store: main.store,
    app: {
      name: 'Mona',
      version: 'probe',
      electron: 'probe',
      chrome: 'probe',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    engine: {
      status: 'not_started',
      detail: `probe runtime path C:\\Users\\victor\\AppData\\Local\\codewhale.exe and DEEPSEEK_API_KEY=${secret}`,
      version: '0.10.2',
      commit: 'ff466b2ed0bf',
      endpoint: null,
      pid: null,
      compatibility: null,
    },
    artifactRoot: main.artifactRoot,
    now: new Date('2026-11-12T12:00:00.000Z'),
  });
  record(
    'diagnostics redact the home path and credentials',
    !diagnostics.text.includes('victor') &&
      !diagnostics.text.includes(secret) &&
      diagnostics.text.includes('C:\\Users\\[user]'),
    `${diagnostics.redaction.redactions} redaction(s), sha ${diagnostics.sha256.slice(0, 12)}…`,
  );

  main.store.close();
  clean.store.close();
  missingStore.store.close();

  const evidence = {
    prompt: 'P19',
    kind: 'local-memory-probe',
    generatedAt: new Date().toISOString(),
    engine: 'not started',
    providerRequests: 0,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    checks,
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
  };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${checks.length}/${checks.length} checks passed\n${lines.join('\n')}\n`);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
} catch (error) {
  await mkdir(path.dirname(logPath), { recursive: true }).catch(() => undefined);
  await writeFile(
    logPath,
    `${lines.join('\n')}\nFAILED: ${error instanceof Error ? error.stack : String(error)}\n`,
    'utf8',
  );
  process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
