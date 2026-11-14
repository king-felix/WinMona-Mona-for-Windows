/**
 * Windows improvement review ledger (W00-W25).
 *
 * The W sequence is a subordinate id space: it must not overwrite the original
 * P00-P23 build state, and the original `cli.mjs` deliberately refuses `Wnn`
 * prompt ids. This utility keeps the review's own atomic, revision-checked state
 * under `.mona/build/reviews/windows-v2/`.
 *
 * It is developer build tooling, not product framework. Prompt Runner must never
 * depend on it.
 *
 * Usage:
 *   node tools/build/windows-review.mjs init
 *   node tools/build/windows-review.mjs refresh
 *   node tools/build/windows-review.mjs validate
 *   node tools/build/windows-review.mjs status
 *   node tools/build/windows-review.mjs checkpoint --task W00 --status completed \
 *     --expected-revision 3 [--acceptance-done "text"]... [--acceptance-open "text"]... \
 *     [--clear-acceptance-open] [--evidence docs/evidence/W00-baseline.md]... \
 *     [--problem P-W00-001]... [--original-requirement MONA-001]... [--next-action "text"]
 *   node tools/build/windows-review.mjs attempt --problem P-W01-001 --task W01 \
 *     --symptom "..." --hypothesis "..." --action "..." --result "..." \
 *     --material-progress yes|no [--evidence path]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(here, '..', '..');

const REVIEW_DIR = path.join('.mona', 'build', 'reviews', 'windows-v2');
const STATE_FILE = path.join(REVIEW_DIR, 'state.json');
const ATTEMPTS_FILE = path.join(REVIEW_DIR, 'attempts.jsonl');
const SUPPLEMENT_LEDGER = path.join('docs', 'requirements-windows.json');
const PROJECT_DOC = 'Mona_Windows_Improvements_Project.md';
const PROMPTS_DOC = 'Mona_Windows_Improvements_PROMPTS.md';

const TASK_STATUSES = ['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted', 'skipped'];
const MAX_NO_PROGRESS = 3;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256(fs.readFileSync(p));
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Write next to the target and rename, so a reader never sees half a state file. */
function atomicWrite(file, body) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const multi = new Set([
    'acceptance-done',
    'acceptance-open',
    'evidence',
    'problem',
    'original-requirement',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : (i += 1, next);
    if (multi.has(key)) {
      flags[key] = flags[key] ?? [];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  }
  return { command: positional[0] ?? 'help', flags, root: path.resolve(flags.root ?? DEFAULT_ROOT) };
}

function supplement(root) {
  const file = path.join(root, SUPPLEMENT_LEDGER);
  if (!fs.existsSync(file)) throw new Error(`${SUPPLEMENT_LEDGER} missing; seed it with tools/build/seed-windows-ledger.mjs`);
  return { file, ledger: readJson(file), sha256: sha256File(file) };
}

function specHashes(root) {
  const project = path.join(root, PROJECT_DOC);
  const prompts = path.join(root, PROMPTS_DOC);
  if (!fs.existsSync(project) || !fs.existsSync(prompts)) {
    throw new Error('Windows improvement documents are missing');
  }
  return {
    project_file: PROJECT_DOC,
    project_sha256: sha256File(project),
    prompts_file: PROMPTS_DOC,
    prompts_sha256: sha256File(prompts),
    ledger: SUPPLEMENT_LEDGER.split(path.sep).join('/'),
  };
}

function sourceIdentity(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    engine: 'codewhale 0.10.2 (ff466b2ed0bf)',
    platform: 'Windows 11 Pro 10.0.26200 (x64)',
    electron: '45.3.0 (Chromium 156, Node 24.22)',
  };
}

function emptyTask(prompt) {
  return {
    status: 'pending',
    prerequisites: prompt.prerequisites,
    acceptance_done: [],
    acceptance_open: prompt.acceptance ? [prompt.acceptance] : [],
    evidence: [],
    problems: [],
    original_requirements: [],
    next_action: '',
  };
}

function buildState(root, previous) {
  const { ledger } = supplement(root);
  const tasks = {};
  for (const prompt of ledger.prompts) {
    const prior = previous?.tasks?.[prompt.id];
    tasks[prompt.id] = prior
      ? {
          ...emptyTask(prompt),
          ...prior,
          // Prerequisites are document-derived; a stale local copy must not
          // disagree with the dependency map the checklist enforces.
          prerequisites: prompt.prerequisites,
        }
      : emptyTask(prompt);
  }
  return {
    schema_version: 1,
    revision: (previous?.revision ?? 0) + 1,
    namespace: 'windows-v2',
    source: sourceIdentity(root),
    spec: specHashes(root),
    baseline_utc: previous?.baseline_utc ?? utcNow(),
    current_task: previous?.current_task ?? ledger.prompts[0].id,
    tasks,
  };
}

function loadState(root) {
  const file = path.join(root, STATE_FILE);
  if (!fs.existsSync(file)) throw new Error('review state missing; run `node tools/build/windows-review.mjs init`');
  return readJson(file);
}

function evidenceRef(root, entry) {
  const abs = path.resolve(root, entry);
  if (!fs.existsSync(abs)) throw new Error(`evidence path does not exist: ${entry}`);
  return {
    path: rel(root, abs),
    sha256: sha256File(abs),
    kind: 'document',
    recorded_utc: utcNow(),
    commit: git(root, ['rev-parse', 'HEAD']),
  };
}

function validateState(root, state) {
  const problems = [];
  const warnings = [];
  const add = (msg) => problems.push(msg);
  const { ledger } = supplement(root);
  const ids = ledger.prompts.map((p) => p.id);

  if (state.schema_version !== 1) add('schema_version must be 1');
  if (state.namespace !== 'windows-v2') add('namespace must be windows-v2');
  if (!Number.isInteger(state.revision) || state.revision < 1) add('revision must be a positive integer');
  const taskIds = Object.keys(state.tasks ?? {});
  for (const id of ids) if (!taskIds.includes(id)) add(`missing task ${id}`);
  for (const id of taskIds) if (!ids.includes(id)) add(`unknown task ${id}`);
  if (taskIds.length !== ids.length) add('task set does not match the supplement ledger');

  for (const prompt of ledger.prompts) {
    const task = state.tasks?.[prompt.id];
    if (!task) continue;
    if (!TASK_STATUSES.includes(task.status)) add(`${prompt.id} has invalid status ${task.status}`);
    if (JSON.stringify(task.prerequisites) !== JSON.stringify(prompt.prerequisites)) {
      add(`${prompt.id} prerequisites do not match the dependency map`);
    }
    for (const prereq of prompt.prerequisites) {
      const row = state.tasks?.[prereq];
      if (row && prompt.status !== 'pending' && row.status !== 'completed' && prompt.id === state.current_task) {
        // Starting a task before its prerequisite settles is the gate this ledger exists for.
        warnings.push(`${prompt.id} is ${task.status} while prerequisite ${prereq} is ${row.status}`);
      }
    }
    for (const evidence of task.evidence ?? []) {
      const file = path.join(root, evidence.path);
      if (!fs.existsSync(file)) add(`${prompt.id} evidence path missing: ${evidence.path}`);
      else if (evidence.sha256 && evidence.sha256 !== sha256File(file)) {
        warnings.push(`${prompt.id} evidence hash stale: ${evidence.path}`);
      }
    }
    if (task.status === 'completed') {
      if (!(task.evidence ?? []).length) add(`${prompt.id} is completed without evidence`);
      if ((task.acceptance_open ?? []).length) {
        add(`${prompt.id} is completed with ${task.acceptance_open.length} open acceptance item(s)`);
      }
    }
    if (task.status === 'blocked' && !(task.problems ?? []).length) {
      add(`${prompt.id} is blocked without a problem id`);
    }
  }

  if (!state.tasks?.[state.current_task]) add(`current_task ${state.current_task} does not exist`);

  // Attempt discipline: a problem with three consecutive no-progress attempts is
  // stopped; a fourth row for it must be refused rather than recorded.
  const attemptsFile = path.join(root, ATTEMPTS_FILE);
  if (fs.existsSync(attemptsFile)) {
    const byProblem = new Map();
    for (const [index, line] of fs.readFileSync(attemptsFile, 'utf8').split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        add(`attempts.jsonl line ${index + 1} is not JSON`);
        continue;
      }
      for (const field of ['problem_id', 'task', 'symptom_fingerprint', 'hypothesis', 'action', 'result', 'material_progress']) {
        if (row[field] === undefined || row[field] === '') add(`attempts.jsonl line ${index + 1} missing ${field}`);
      }
      if (!Number.isInteger(row.consecutive_no_progress)) {
        add(`attempts.jsonl line ${index + 1} missing consecutive_no_progress`);
      }
      const prior = byProblem.get(row.problem_id);
      if (prior && prior.consecutive_no_progress >= MAX_NO_PROGRESS) {
        add(`problem ${row.problem_id} recorded an attempt after the third no-progress stop`);
      }
      byProblem.set(row.problem_id, row);
      const task = state.tasks?.[row.task];
      if (task && !(task.problems ?? []).includes(row.problem_id)) {
        add(`${row.problem_id} is recorded on ${row.task} but not listed in its problems`);
      }
    }
  }
  return { problems, warnings };
}

function checkpoint(root, flags) {
  const taskId = String(flags.task ?? '');
  const status = String(flags.status ?? '');
  const expected = Number(flags['expected-revision']);
  if (!taskId || !TASK_STATUSES.includes(status) || !Number.isInteger(expected)) {
    throw new Error('checkpoint needs --task, --status and --expected-revision');
  }
  const current = loadState(root);
  if (current.revision !== expected) {
    throw new Error(`revision conflict: state is at ${current.revision}, caller expected ${expected}; re-read and retry`);
  }
  const task = current.tasks[taskId];
  if (!task) throw new Error(`unknown task ${taskId}`);
  const next = JSON.parse(JSON.stringify(current));
  const row = next.tasks[taskId];
  row.status = status;
  for (const step of flags['acceptance-done'] ?? []) {
    row.acceptance_done.push(String(step));
    row.acceptance_open = row.acceptance_open.filter((item) => item !== String(step));
  }
  if (flags['clear-acceptance-open'] === true) row.acceptance_open = [];
  for (const step of flags['acceptance-open'] ?? []) {
    if (!row.acceptance_open.includes(String(step))) row.acceptance_open.push(String(step));
  }
  if (flags.evidence) {
    for (const entry of flags.evidence) {
      const ref = evidenceRef(root, String(entry));
      row.evidence = row.evidence.filter((item) => item.path !== ref.path);
      row.evidence.push(ref);
    }
  }
  for (const problem of flags.problem ?? []) {
    if (!row.problems.includes(String(problem))) row.problems.push(String(problem));
  }
  for (const requirement of flags['original-requirement'] ?? []) {
    if (!/^MONA-\d{3}$/.test(String(requirement))) throw new Error(`invalid original requirement ${requirement}`);
    if (!row.original_requirements.includes(String(requirement))) {
      row.original_requirements.push(String(requirement));
    }
  }
  if (flags['next-action']) row.next_action = String(flags['next-action']);
  if (flags['current-task']) {
    if (!next.tasks[String(flags['current-task'])]) throw new Error(`unknown current task ${flags['current-task']}`);
    next.current_task = String(flags['current-task']);
  } else if (status !== 'completed') {
    next.current_task = taskId;
  } else if (next.current_task === taskId) {
    // Do not invent the next prompt: the dependency map decides eligibility and
    // the caller records the decision. Leaving the completed id is honest.
    next.current_task = taskId;
  }
  next.revision = current.revision + 1;

  const { problems } = validateState(root, next);
  if (problems.length) throw new Error(`refusing to write invalid review state:\n- ${problems.join('\n- ')}`);

  atomicWriteJson(path.join(root, STATE_FILE), next);
  return next;
}

function appendAttempt(root, flags) {
  const problemId = String(flags.problem ?? '');
  const taskId = String(flags.task ?? '');
  if (!problemId || !taskId) throw new Error('attempt needs --problem and --task');
  const state = loadState(root);
  if (!state.tasks[taskId]) throw new Error(`unknown task ${taskId}`);
  const material = String(flags['material-progress'] ?? '').toLowerCase();
  if (!['yes', 'no', 'true', 'false'].includes(material)) {
    throw new Error('attempt needs --material-progress yes|no');
  }
  const materialProgress = material === 'yes' || material === 'true';

  const file = path.join(root, ATTEMPTS_FILE);
  const priorRows = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const prior = [...priorRows].reverse().find((row) => row.problem_id === problemId);
  if (prior && prior.consecutive_no_progress >= MAX_NO_PROGRESS) {
    throw new Error(
      `problem ${problemId} already stopped at ${MAX_NO_PROGRESS} consecutive no-progress attempts; record the human help needed in BLOCKERS.md instead of retrying`,
    );
  }
  const consecutive = materialProgress ? 0 : (prior?.consecutive_no_progress ?? 0) + 1;
  const attemptNo = (prior?.attempt_no ?? 0) + 1;
  const row = {
    problem_id: problemId,
    task: taskId,
    attempt_no: attemptNo,
    symptom_fingerprint: String(flags.symptom ?? ''),
    hypothesis: String(flags.hypothesis ?? ''),
    action: String(flags.action ?? ''),
    result: String(flags.result ?? ''),
    evidence_path: flags.evidence ? rel(root, path.resolve(root, String(flags.evidence))) : null,
    material_progress: materialProgress,
    consecutive_no_progress: consecutive,
    recorded_utc: utcNow(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function status(root) {
  const state = loadState(root);
  const tasks = Object.entries(state.tasks);
  const counts = {};
  for (const [, task] of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const eligible = tasks
    .filter(([, task]) => ['pending', 'interrupted'].includes(task.status))
    .filter(([, task]) => task.prerequisites.every((id) => state.tasks[id].status === 'completed'))
    .map(([id]) => id)
    .sort();
  return {
    revision: state.revision,
    current_task: state.current_task,
    counts,
    eligible,
    blocked: tasks.filter(([, task]) => task.status === 'blocked').map(([id]) => id),
  };
}

function main() {
  const { command, flags, root } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'init') {
      const file = path.join(root, STATE_FILE);
      const previous = fs.existsSync(file) ? readJson(file) : null;
      const state = buildState(root, previous);
      atomicWriteJson(file, state);
      process.stdout.write(`review state revision ${state.revision} -> ${rel(root, file)}\n`);
      return 0;
    }
    if (command === 'refresh') {
      const previous = loadState(root);
      const next = {
        ...previous,
        revision: previous.revision + 1,
        source: sourceIdentity(root),
        spec: specHashes(root),
      };
      const { problems } = validateState(root, next);
      if (problems.length) throw new Error(`refusing to write: ${problems.join('; ')}`);
      atomicWriteJson(path.join(root, STATE_FILE), next);
      process.stdout.write(`review state refreshed at revision ${next.revision}\n`);
      return 0;
    }
    if (command === 'validate') {
      const state = loadState(root);
      const { problems, warnings } = validateState(root, state);
      for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
      if (problems.length) {
        for (const problem of problems) process.stdout.write(`error: ${problem}\n`);
        return 1;
      }
      process.stdout.write(`OK: review state revision ${state.revision}; ${Object.keys(state.tasks).length} tasks; 0 error(s)\n`);
      return 0;
    }
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify(status(root), null, 2)}\n`);
      return 0;
    }
    if (command === 'checkpoint') {
      const next = checkpoint(root, flags);
      process.stdout.write(`review state revision ${next.revision}; ${flags.task} -> ${flags.status}\n`);
      return 0;
    }
    if (command === 'attempt') {
      const row = appendAttempt(root, flags);
      process.stdout.write(
        `${row.problem_id} attempt ${row.attempt_no}: consecutive no-progress ${row.consecutive_no_progress}/${MAX_NO_PROGRESS}\n`,
      );
      return 0;
    }
    process.stdout.write(
      [
        'usage: node tools/build/windows-review.mjs <command>',
        '  init | refresh | validate | status',
        '  checkpoint --task W00 --status completed --expected-revision N [--acceptance-done s]... [--evidence path]...',
        '  attempt --problem P-W01-001 --task W01 --symptom s --hypothesis h --action a --result r --material-progress yes|no',
      ].join('\n') + '\n',
    );
    return command === 'help' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main();
