#!/usr/bin/env node
// Mona bootstrap build utility (P00).
//
// Commands:
//   index       Hash both specification files, extract section/requirement/prompt indexes.
//   init        Create .mona/build/state.json from the traceability ledger.
//   validate    Schema + semantic validation of state, ledger, hashes, evidence and graph.
//   checkpoint  Conflict-checked atomic state checkpoint with backup and journal.
//   recover     Promote a complete interrupted write or fall back to a verified backup.
//   evidence    Attach hashed evidence to a requirement criterion.
//   status      Print a compact build status.
//
// This is deliberately small. It is the build's own state keeper, not the future
// Mona product framework (that begins at P02 in packages/ and apps/).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const STATE_SCHEMA = 'tools/build/schema/state.schema.json';
const LEDGER_SCHEMA = 'tools/build/schema/requirements.schema.json';
// The Windows improvement supplement is a second, independent id space. Keeping
// it in its own ledger lets the original P00-P23 gate stay exactly as strict.
const WINDOWS_LEDGER = 'docs/requirements-windows.json';
const WINDOWS_SCHEMA = 'tools/build/schema/requirements-windows.schema.json';
const WINDOWS_PROJECT_DOC = 'Mona_Windows_Improvements_Project.md';
const WINDOWS_PROMPTS_DOC = 'Mona_Windows_Improvements_PROMPTS.md';

const EXIT = { ok: 0, usage: 2, invalid: 3, conflict: 4, io: 5 };

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  const multi = new Set([
    'completed-step',
    'remaining-step',
    'evidence',
    'blocker',
    'next',
    'note',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).trim();
    let value;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = true;
    }
    if (multi.has(key)) {
      flags[key] = flags[key] ?? [];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  }
  const root = path.resolve(flags.root ?? DEFAULT_ROOT);
  return { command: positional[0] ?? 'help', flags, root };
}

// ------------------------------------------------------------------- helpers

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256(fs.readFileSync(p));
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const abs = (root, p) => path.resolve(root, p);

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

function atomicWriteJson(file, value, { tmpDir } = {}) {
  const dir = tmpDir ?? path.join(path.dirname(file), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

function readState(root) {
  const file = path.join(root, '.mona', 'build', 'state.json');
  return { file, state: readJson(file) };
}

function readLedger(root) {
  const file = path.join(root, 'docs', 'requirements.json');
  return { file, ledger: readJson(file) };
}

/** The supplement ledger, or null when the project does not carry one. */
function readWindowsLedger(root) {
  const file = path.join(root, WINDOWS_LEDGER);
  if (!fs.existsSync(file)) return { file, ledger: null };
  return { file, ledger: readJson(file) };
}

function lockOwnerAlive(lock) {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearDeadLock(root) {
  const lock = path.join(root, '.mona', 'build', '.lock');
  if (!fs.existsSync(lock)) return { cleared: false, holder: null };
  const raw = fs.readFileSync(lock, 'utf8').trim();
  if (!lockOwnerAlive(lock)) {
    fs.rmSync(lock, { force: true });
    return { cleared: true, holder: raw };
  }
  return { cleared: false, holder: raw };
}

function withLock(root, fn) {
  const lock = path.join(root, '.mona', 'build', '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const now = Date.now();
  let created = false;
  if (fs.existsSync(lock)) {
    const raw = fs.readFileSync(lock, 'utf8');
    const stamp = Number(raw.split(/\s+/)[1]);
    const stale = Number.isFinite(stamp) && now - stamp > 120_000;
    if (stale || !lockOwnerAlive(lock)) fs.rmSync(lock, { force: true });
  }
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, `${process.pid} ${now}\n`);
    fs.closeSync(fd);
    created = true;
  } catch {
    throw new Error(`another checkpoint holds ${rel(root, lock)} (stale locks expire after 120s)`);
  }
  try {
    return fn();
  } finally {
    if (created) fs.rmSync(lock, { force: true });
  }
}

// ------------------------------------------------------------- schema layer

function compiler(root) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return {
    state: ajv.compile(readJson(path.join(root, STATE_SCHEMA))),
    ledger: ajv.compile(readJson(path.join(root, LEDGER_SCHEMA))),
    windows: ajv.compile(readJson(path.join(root, WINDOWS_SCHEMA))),
    describe() {
      return Object.entries(ajv.errors ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');
    },
  };
}

const fmtAjv = (errors) =>
  (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`.trim()).join('; ');

// ---------------------------------------------------------------- the model

function specIds(text) {
  return [...new Set(text.match(/MONA-\d{3}/g) ?? [])].sort();
}

function headingSections(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) heads.push({ level: m[1].length, heading: m[2], line: i });
  });
  return heads.map((h, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j += 1) {
      if (heads[j].level <= h.level) {
        end = heads[j].line;
        break;
      }
    }
    const body = lines.slice(h.line, end).join('\n');
    return {
      level: h.level,
      heading: h.heading,
      start_line: h.line + 1,
      end_line: end,
      sha256: sha256(Buffer.from(body, 'utf8')),
    };
  });
}

function buildSpecIndex(root) {
  const indexOne = (name) => {
    const file = path.join(root, name);
    const text = fs.readFileSync(file, 'utf8');
    const sections = headingSections(text);
    return {
      path: name,
      sha256: sha256File(file),
      bytes: fs.statSync(file).size,
      lines: text.split(/\r?\n/).length,
      requirement_ids: specIds(text),
      prompt_ids: [...new Set(text.match(/\bP\d{2}\b/g) ?? [])].sort(),
      supplement_prompt_ids: [...new Set(text.match(/\bW\d{2}\b/g) ?? [])].sort(),
      // The W headings carry no `###` prefix requirement of their own; the same
      // heading parser covers both documents.
      prompt_sections: sections
        .filter((s) => /^P\d{2}\b/.test(s.heading))
        .map((s) => ({ id: s.heading.slice(0, 3), heading: s.heading, start_line: s.start_line })),
      supplement_prompt_sections: sections
        .filter((s) => /^W\d{2}\b/.test(s.heading))
        .map((s) => ({ id: s.heading.slice(0, 3), heading: s.heading, start_line: s.start_line })),
      sections,
    };
  };
  // The supplement documents are indexed only when the project carries them, so
  // an upgrade of the original sequence is not forced to adopt the supplement.
  const supplementDocs = [WINDOWS_PROJECT_DOC, WINDOWS_PROMPTS_DOC].filter((name) =>
    fs.existsSync(path.join(root, name)),
  );
  return {
    schema_version: 1,
    generated_utc: utcNow(),
    purpose:
      'Deterministic section/requirement/prompt index for Mona_Project.md and Mona_PROMPTS.md, plus the Windows improvement supplement when present. Regenerate with `node tools/build/cli.mjs index`.',
    files: ['Mona_Project.md', 'Mona_PROMPTS.md', ...supplementDocs].map(indexOne),
  };
}

function computeEligible(ledger, tasks) {
  return ledger.prompts
    .filter((p) => {
      const status = tasks[p.id]?.status;
      if (!status || status === 'completed' || status === 'skipped' || status === 'blocked') return false;
      return p.prerequisites.every((q) => tasks[q]?.status === 'completed');
    })
    .map((p) => p.id);
}

function findCycles(prompts) {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const state = new Map();
  const cycles = [];
  const visit = (id, stack) => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) {
      cycles.push([...stack.slice(stack.indexOf(id)), id].join(' -> '));
      return;
    }
    if (mark === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)?.prerequisites ?? []) {
      if (byId.has(dep)) visit(dep, [...stack, id]);
    }
    state.set(id, 2);
  };
  for (const p of prompts) visit(p.id, []);
  return cycles;
}

// -------------------------------------------------------------- validation

const SECRET_PATTERNS = [
  { name: 'provider-key-like', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'assigned-credential', re: /\b(api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|password)\b\s*[=:]\s*["'][A-Za-z0-9._-]{20,}["']/i },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

function scanTrackedForSecrets(root) {
  const listed = git(root, ['ls-files']);
  const files = listed
    ? listed.split(/\r?\n/).filter(Boolean)
    : [];
  const findings = [];
  for (const f of files) {
    if (/package-lock\.json$/.test(f)) continue;
    const p = path.join(root, f);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) findings.push({ file: f, pattern: name });
    }
  }
  if (files.some((f) => /(^|\/)secrets\.json$/.test(f) || /(^|\/)\.env(\.|$)/.test(f))) {
    findings.push({ file: '(index)', pattern: 'credential-file-tracked' });
  }
  return findings;
}

function validateAll(root, { verbose = false } = {}) {
  const problems = [];
  const warnings = [];
  const schemas = compiler(root);
  const add = (m) => problems.push(m);

  let ledger;
  let state;
  let index;
  try {
    ledger = readLedger(root).ledger;
  } catch (err) {
    add(`ledger unreadable: ${err.message}`);
  }
  try {
    state = readState(root).state;
  } catch (err) {
    add(`state unreadable: ${err.message}`);
  }
  try {
    index = readJson(path.join(root, 'docs', 'spec-index.json'));
  } catch {
    add('docs/spec-index.json missing or unreadable (run `index`)');
  }

  if (ledger && !schemas.ledger(ledger)) add(`ledger schema: ${fmtAjv(schemas.ledger.errors)}`);
  if (state && !schemas.state(state)) add(`state schema: ${fmtAjv(schemas.state.errors)}`);
  if (problems.length) return { problems, warnings, ledger, state, index, windows: null };

  // Specification hashes and indexing.
  const forFile = (name) => path.join(root, name);
  if (sha256File(forFile('Mona_Project.md')) !== ledger.spec.sha256) {
    add('ledger spec.sha256 does not match Mona_Project.md (run `index` then update the ledger spec hashes)');
  }
  if (sha256File(forFile('Mona_PROMPTS.md')) !== ledger.spec.companion_sha256) {
    add('ledger spec.companion_sha256 does not match Mona_PROMPTS.md');
  }
  if (state.spec_sha256 !== ledger.spec.sha256) add('state.spec_sha256 does not match the ledger');
  if (state.prompt_file_sha256 !== ledger.spec.companion_sha256) add('state.prompt_file_sha256 does not match the ledger');

  // Prompt and requirement completeness.
  const expectedPrompts = Array.from({ length: 24 }, (_, i) => `P${String(i).padStart(2, '0')}`);
  const promptIds = ledger.prompts.map((p) => p.id);
  const missingPrompts = expectedPrompts.filter((id) => !promptIds.includes(id));
  const extraPrompts = promptIds.filter((id) => !expectedPrompts.includes(id));
  if (missingPrompts.length) add(`missing prompt ids: ${missingPrompts.join(', ')}`);
  if (extraPrompts.length) add(`unknown prompt ids: ${extraPrompts.join(', ')}`);
  if (new Set(promptIds).size !== promptIds.length) add('duplicate prompt ids in ledger');

  const expectedReq = Array.from({ length: 30 }, (_, i) => `MONA-${String(i + 1).padStart(3, '0')}`);
  const reqIds = ledger.requirements.map((r) => r.id);
  const missingReq = expectedReq.filter((id) => !reqIds.includes(id));
  if (missingReq.length) add(`missing requirements: ${missingReq.join(', ')}`);
  if (new Set(reqIds).size !== reqIds.length) add('duplicate requirement ids in ledger');

  // Requirement ids in the specification must all be registered, and vice versa.
  const specText = fs.readFileSync(path.join(root, 'Mona_Project.md'), 'utf8');
  const promptText = fs.readFileSync(path.join(root, 'Mona_PROMPTS.md'), 'utf8');
  const inSpec = specIds(specText);
  const notInLedger = inSpec.filter((id) => !reqIds.includes(id));
  if (notInLedger.length) add(`proposal requirements missing from ledger: ${notInLedger.join(', ')}`);
  const notInSpec = reqIds.filter((id) => !inSpec.includes(id));
  if (notInSpec.length) add(`ledger requirements absent from Mona_Project.md: ${notInSpec.join(', ')}`);
  // ASCII-only on purpose: the heading separator is an em dash, and depending on
  // that byte sequence makes the check fragile across encodings.
  const promptSections = [...promptText.matchAll(/^### (P\d{2})(?=\s)/gm)].map((m) => m[1]);
  const missingSections = expectedPrompts.filter((id) => !promptSections.includes(id));
  if (missingSections.length) add(`prompt sections missing from Mona_PROMPTS.md: ${missingSections.join(', ')}`);

  // Graph and ownership consistency.
  const promptById = new Map(ledger.prompts.map((p) => [p.id, p]));
  for (const p of ledger.prompts) {
    for (const dep of p.prerequisites) {
      if (!promptById.has(dep)) add(`${p.id} has unknown prerequisite ${dep}`);
      else if (dep === p.id) add(`${p.id} depends on itself`);
    }
    for (const r of p.requirements) {
      if (!reqIds.includes(r)) add(`${p.id} references unknown requirement ${r}`);
    }
  }
  for (const cycle of findCycles(ledger.prompts)) add(`dependency cycle: ${cycle}`);
  for (const r of ledger.requirements) {
    for (const p of r.owning_prompts) {
      const owner = promptById.get(p);
      if (!owner) add(`${r.id} owned by unknown prompt ${p}`);
      else if (!owner.requirements.includes(r.id)) add(`${r.id} claims owner ${p} but ${p} does not list it`);
    }
    const criteriaIds = r.criteria.map((c) => c.id);
    if (new Set(criteriaIds).size !== criteriaIds.length) add(`${r.id} has duplicate criterion ids`);
    for (const c of r.criteria) {
      if (c.status === 'passed' && c.evidence.length === 0) {
        add(`${r.id}/${c.id} is marked passed without evidence`);
      }
    }
    if (r.status === 'verified') {
      const unproven = r.criteria.filter((c) => c.status !== 'passed' && c.status !== 'not_applicable');
      if (unproven.length) add(`${r.id} is verified but criteria are not passed: ${unproven.map((c) => c.id).join(', ')}`);
      if (!r.verified_commit) add(`${r.id} is verified without verified_commit`);
    }
    for (const id of r.open_issue_ids) {
      if (!/^ISSUE-\d{4}$/.test(id)) add(`${r.id} has malformed issue id ${id}`);
    }
  }

  // State <-> ledger agreement.
  const taskIds = Object.keys(state.tasks).sort();
  const ledgerPromptIds = [...promptIds].sort();
  if (taskIds.join(',') !== ledgerPromptIds.join(',')) {
    add('state tasks do not match ledger prompt ids');
  }
  for (const p of ledger.prompts) {
    const task = state.tasks[p.id];
    if (!task) continue;
    const a = [...task.requirements].sort().join(',');
    const b = [...p.requirements].sort().join(',');
    if (a !== b) add(`state ${p.id} requirements differ from ledger (${a} vs ${b})`);
    for (const e of task.evidence) {
      const p2 = path.join(root, e.path);
      if (!fs.existsSync(p2)) add(`state ${p.id} evidence path missing: ${e.path}`);
      else if (e.sha256 && e.sha256 !== sha256File(p2)) {
        warnings.push(`state ${p.id} evidence hash stale: ${e.path}`);
      }
    }
  }
  for (const r of ledger.requirements) {
    for (const c of r.criteria) {
      for (const e of c.evidence) {
        const p2 = path.join(root, e.path);
        if (!fs.existsSync(p2)) add(`${r.id}/${c.id} evidence path missing: ${e.path}`);
        else if (e.sha256 && e.sha256 !== sha256File(p2)) {
          warnings.push(`${r.id}/${c.id} evidence hash stale: ${e.path}`);
        }
      }
    }
  }
  const eligible = computeEligible(ledger, state.tasks);
  if ([...eligible].sort().join(',') !== [...state.next_eligible_prompts].sort().join(',')) {
    add(`state next_eligible_prompts [${state.next_eligible_prompts.join(', ')}] != computed [${eligible.join(', ')}]`);
  }
  if (!state.tasks[state.current_prompt]) add(`state current_prompt ${state.current_prompt} is not a known prompt`);
  if (state.last_verified_commit && git(root, ['rev-parse', 'HEAD'])) {
    const head = git(root, ['rev-parse', 'HEAD']);
    if (head && !state.last_verified_commit.startsWith(head) && !head.startsWith(state.last_verified_commit)) {
      warnings.push(`state last_verified_commit ${state.last_verified_commit} is not HEAD ${head}`);
    }
  }

  // Specification index agreement.
  if (index) {
    const specEntry = index.files?.find((f) => f.path === 'Mona_Project.md');
    const promptEntry = index.files?.find((f) => f.path === 'Mona_PROMPTS.md');
    if (!specEntry || !promptEntry) add('spec index lacks one of the two documents');
    else {
      if (specEntry.sha256 !== sha256File(path.join(root, 'Mona_Project.md'))) add('spec index is stale for Mona_Project.md');
      if (promptEntry.sha256 !== sha256File(path.join(root, 'Mona_PROMPTS.md'))) add('spec index is stale for Mona_PROMPTS.md');
      if (specEntry.requirement_ids.length !== 30) {
        add(`spec index found ${specEntry.requirement_ids.length} requirement ids, expected 30`);
      }
    }
  }

  // Windows improvement supplement (W00-W25, WX-01-WX-18). Separate id space,
  // same evidence discipline: a row may not claim more than its evidence shows.
  let windows = null;
  const windowsLedgerFile = path.join(root, WINDOWS_LEDGER);
  const windowsProjectDoc = path.join(root, WINDOWS_PROJECT_DOC);
  const windowsPromptsDoc = path.join(root, WINDOWS_PROMPTS_DOC);
  const supplementDocsPresent = fs.existsSync(windowsProjectDoc) && fs.existsSync(windowsPromptsDoc);
  if (fs.existsSync(windowsLedgerFile)) {
    try {
      windows = readJson(windowsLedgerFile);
    } catch (err) {
      add(`Windows supplement ledger unreadable: ${err.message}`);
    }
  } else if (supplementDocsPresent) {
    add(
      'Windows supplement documents are present but docs/requirements-windows.json is missing (run `node tools/build/seed-windows-ledger.mjs`)',
    );
  }
  if (windows && !supplementDocsPresent) {
    add('docs/requirements-windows.json exists but the supplement documents are missing');
  }
  if (windows && !schemas.windows(windows)) {
    add(`Windows supplement schema: ${fmtAjv(schemas.windows.errors)}`);
  } else if (windows && supplementDocsPresent) {
    if (sha256File(windowsProjectDoc) !== windows.spec.sha256) {
      add(
        `Windows supplement spec.sha256 does not match ${WINDOWS_PROJECT_DOC} (re-seed with \`node tools/build/seed-windows-ledger.mjs\`)`,
      );
    }
    if (sha256File(windowsPromptsDoc) !== windows.spec.companion_sha256) {
      add(`Windows supplement spec.companion_sha256 does not match ${WINDOWS_PROMPTS_DOC}`);
    }

    const expectedW = Array.from({ length: 26 }, (_, i) => `W${String(i).padStart(2, '0')}`);
    const wIds = windows.prompts.map((p) => p.id);
    const missingW = expectedW.filter((id) => !wIds.includes(id));
    const extraW = wIds.filter((id) => !expectedW.includes(id));
    if (missingW.length) add(`Windows supplement missing prompt ids: ${missingW.join(', ')}`);
    if (extraW.length) add(`Windows supplement unknown prompt ids: ${extraW.join(', ')}`);
    if (new Set(wIds).size !== wIds.length) add('Windows supplement has duplicate prompt ids');

    const expectedWx = Array.from({ length: 18 }, (_, i) => `WX-${String(i + 1).padStart(2, '0')}`);
    const wxIds = windows.requirements.map((r) => r.id);
    const missingWx = expectedWx.filter((id) => !wxIds.includes(id));
    if (missingWx.length) add(`Windows supplement missing requirements: ${missingWx.join(', ')}`);
    if (new Set(wxIds).size !== wxIds.length) add('Windows supplement has duplicate requirement ids');

    // Every recorded prompt must still match a real section in the prompts doc,
    // so the registry cannot drift away from the document it claims to track.
    const promptsText = fs.readFileSync(windowsPromptsDoc, 'utf8');
    const headings = [...promptsText.matchAll(/^### (W\d{2})\s*[—–-]\s*(.+)$/gm)].map((m) => ({
      id: m[1],
      title: m[2].trim(),
    }));
    const headingById = new Map(headings.map((h) => [h.id, h.title]));
    for (const prompt of windows.prompts) {
      if (!headingById.has(prompt.id)) {
        add(`Windows supplement prompt ${prompt.id} has no section in ${WINDOWS_PROMPTS_DOC}`);
      } else if (headingById.get(prompt.id) !== prompt.title) {
        add(`Windows supplement prompt ${prompt.id} title is stale: "${prompt.title}" != "${headingById.get(prompt.id)}"`);
      }
    }
    if (headings.length !== windows.prompts.length) {
      add(
        `Windows supplement records ${windows.prompts.length} prompts but the document has ${headings.length} sections`,
      );
    }

    const wById = new Map(windows.prompts.map((p) => [p.id, p]));
    for (const prompt of windows.prompts) {
      for (const dep of prompt.prerequisites) {
        if (!wById.has(dep)) add(`${prompt.id} has unknown prerequisite ${dep}`);
        else if (dep === prompt.id) add(`${prompt.id} depends on itself`);
      }
      for (const requirementId of prompt.requirements) {
        if (!wxIds.includes(requirementId)) {
          add(`${prompt.id} references unknown requirement ${requirementId}`);
        }
      }
      if (prompt.status === 'completed' && prompt.evidence.length === 0) {
        add(`${prompt.id} is completed without evidence`);
      }
      for (const evidence of prompt.evidence) {
        const evidencePath = path.join(root, evidence.path);
        if (!fs.existsSync(evidencePath)) add(`${prompt.id} evidence path missing: ${evidence.path}`);
        else if (evidence.sha256 && evidence.sha256 !== sha256File(evidencePath)) {
          warnings.push(`${prompt.id} evidence hash stale: ${evidence.path}`);
        }
      }
    }
    for (const cycle of findCycles(windows.prompts)) add(`Windows supplement dependency cycle: ${cycle}`);

    const claimed = new Set(windows.requirements.flatMap((r) => r.owning_prompts));
    for (const id of expectedW) {
      if (!claimed.has(id)) add(`${id} is not claimed by any WX requirement`);
    }
    for (const requirement of windows.requirements) {
      for (const ownerId of requirement.owning_prompts) {
        const owner = wById.get(ownerId);
        if (!owner) add(`${requirement.id} owned by unknown prompt ${ownerId}`);
        else if (!owner.requirements.includes(requirement.id)) {
          add(`${requirement.id} claims owner ${ownerId} but ${ownerId} does not list it`);
        }
      }
      if (requirement.status === 'verified') {
        const unproven = requirement.criteria.filter(
          (c) => c.status !== 'passed' && c.status !== 'not_applicable',
        );
        if (unproven.length) {
          add(
            `${requirement.id} is verified but criteria are not passed: ${unproven.map((c) => c.id).join(', ')}`,
          );
        }
        if (!requirement.verified_commit) add(`${requirement.id} is verified without verified_commit`);
        if (requirement.original_requirements.length === 0) {
          add(`${requirement.id} is verified without an original-ledger mapping (S10 requires one)`);
        }
      }
      for (const criterion of requirement.criteria) {
        if (criterion.status === 'passed' && criterion.evidence.length === 0) {
          add(`${requirement.id}/${criterion.id} is marked passed without evidence`);
        }
      }
    }
  }

  // No committed secrets.
  for (const hit of scanTrackedForSecrets(root)) add(`possible secret in ${hit.file} (${hit.pattern})`);

  if (verbose) {
    warnings.push(
      `counts: prompts=${ledger.prompts.length} requirements=${ledger.requirements.length} criteria=${ledger.requirements.reduce((n, r) => n + r.criteria.length, 0)} tasks=${taskIds.length}`,
    );
  }
  return { problems, warnings, ledger, state, index, windows };
}

// ---------------------------------------------------------------- commands

function cmdIndex(root, flags) {
  const index = buildSpecIndex(root);
  const out = path.join(root, 'docs', 'spec-index.json');
  const tmp = atomicWriteJson(out, index, { tmpDir: path.join(root, '.mona', 'build', 'tmp') });
  fs.renameSync(tmp, out);
  const ledgerFile = path.join(root, 'docs', 'requirements.json');
  let hashNote = '';
  if (fs.existsSync(ledgerFile)) {
    const ledger = readJson(ledgerFile);
    const actual = {
      sha256: index.files[0].sha256,
      companion_sha256: index.files[1].sha256,
    };
    const drift =
      ledger.spec.sha256 !== actual.sha256 || ledger.spec.companion_sha256 !== actual.companion_sha256;
    hashNote = drift ? 'ledger spec hashes DIFFER from current files' : 'ledger spec hashes match';
  }
  console.log(`indexed ${index.files.map((f) => `${f.path} (${f.sections.length} sections, ${f.bytes}B)`).join('; ')}`);
  console.log(`wrote ${rel(root, out)}; ${hashNote}`);
  console.log(`requirement ids planted in spec: ${index.files[0].requirement_ids.length}`);
  return EXIT.ok;
}

function cmdInit(root, flags) {
  const { ledger } = readLedger(root);
  const statePath = path.join(root, '.mona', 'build', 'state.json');
  if (fs.existsSync(statePath) && !flags.force) {
    console.error(`state already exists: ${rel(root, statePath)} (use --force to reinitialize; a backup is written)`);
    return EXIT.conflict;
  }
  const tasks = Object.fromEntries(
    ledger.prompts.map((p) => [
      p.id,
      {
        status: 'pending',
        requirements: p.requirements,
        completed_steps: [],
        remaining_steps: [],
        evidence: [],
        blocker_ids: [],
      },
    ]),
  );
  const state = {
    schema_version: 1,
    revision: 1,
    project: 'Mona',
    spec_version: ledger.spec.version,
    spec_sha256: ledger.spec.sha256,
    prompt_file_sha256: ledger.spec.companion_sha256,
    current_prompt: 'P00',
    last_verified_commit: null,
    tasks,
    next_eligible_prompts: computeEligible(ledger, tasks),
    last_checkpoint_utc: null,
  };
  const schemas = compiler(root);
  if (!schemas.state(state)) {
    console.error(`generated state fails schema: ${fmtAjv(schemas.state.errors)}`);
    return EXIT.invalid;
  }
  if (fs.existsSync(statePath)) {
    const backup = path.join(root, '.mona', 'build', 'backup', `state.pre-init.${Date.now()}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(statePath, backup);
  }
  const tmp = atomicWriteJson(statePath, state, { tmpDir: path.join(root, '.mona', 'build', 'tmp') });
  fs.renameSync(tmp, statePath);
  console.log(`initialized ${rel(root, statePath)} at revision 1 with ${Object.keys(tasks).length} tasks; eligible: ${state.next_eligible_prompts.join(', ')}`);
  return EXIT.ok;
}

function cmdValidate(root, flags) {
  const { problems, warnings, ledger, state } = validateAll(root, { verbose: flags.verbose });
  for (const w of warnings) console.log(`warn: ${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    console.error(`validation failed with ${problems.length} problem(s)`);
    return EXIT.invalid;
  }
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, warnings, prompts: ledger.prompts.length, requirements: ledger.requirements.length, revision: state.revision }, null, 2));
  } else {
    console.log(`OK: state revision ${state.revision}; ${Object.keys(state.tasks).length} tasks; ${ledger.requirements.length} requirements; ${warnings.length} warning(s)`);
  }
  return EXIT.ok;
}

function applyFault(stage) {
  if (process.env.MONA_FAULT_AFTER_TEMP_WRITE === '1' && stage === 'after-temp-write') {
    console.error('fault injected: exiting after temp write, before rename');
    process.exit(70);
  }
  if (process.env.MONA_FAULT_AFTER_RENAME === '1' && stage === 'after-rename') {
    console.error('fault injected: exiting after rename, before journal');
    process.exit(71);
  }
}

function scanInterruptedTemps(root) {
  const tmpDir = path.join(root, '.mona', 'build', 'tmp');
  if (!fs.existsSync(tmpDir)) return [];
  return fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith('state.json.') && f.endsWith('.tmp'))
    .map((f) => path.join(tmpDir, f));
}

function cmdCheckpoint(root, flags) {
  const prompt = flags.prompt;
  const status = flags.status;
  const expected = Number(flags['expected-revision']);
  if (!prompt || !status || !Number.isInteger(expected)) {
    console.error('usage: checkpoint --prompt P00 --status completed --expected-revision N [--note ...] [--completed-step ...] [--evidence path]');
    return EXIT.usage;
  }
  const schemas = compiler(root);
  const { ledger } = readLedger(root);
  const statePath = path.join(root, '.mona', 'build', 'state.json');
  const tmpDir = path.join(root, '.mona', 'build', 'tmp');

  return withLock(root, () => {
    // A checkpoint must never proceed over an unread or half-written state.
    for (const leftover of scanInterruptedTemps(root)) {
      fs.rmSync(leftover, { force: true });
      console.log(`discarded interrupted temp before checkpoint: ${rel(root, leftover)}`);
    }
    const current = readJson(statePath);
    if (!schemas.state(current)) {
      console.error(`existing state invalid, refusing to write: ${fmtAjv(schemas.state.errors)}`);
      return EXIT.invalid;
    }
    if (current.revision !== expected) {
      console.error(`revision conflict: state is at ${current.revision}, caller expected ${expected}; re-read and retry`);
      return EXIT.conflict;
    }
    if (!current.tasks[prompt]) {
      console.error(`unknown prompt ${prompt}`);
      return EXIT.usage;
    }
    const next = JSON.parse(JSON.stringify(current));
    const task = next.tasks[prompt];
    task.status = status;
    for (const step of flags['completed-step'] ?? []) task.completed_steps.push(step);
    // A step recorded as remaining can later be finished. Clearing is explicit so
    // the ledger never silently loses an open item.
    if (flags['clear-remaining-steps'] === true) task.remaining_steps = [];
    for (const step of flags['remaining-step'] ?? []) task.remaining_steps.push(step);
    for (const id of flags.blocker ?? []) if (!task.blocker_ids.includes(id)) task.blocker_ids.push(id);
    for (const p of flags.evidence ?? []) {
      const file = abs(root, p);
      if (!fs.existsSync(file)) {
        console.error(`evidence path does not exist: ${p}`);
        return EXIT.usage;
      }
      const ref = {
        path: rel(root, file),
        sha256: sha256File(file),
        kind: 'document',
        recorded_utc: utcNow(),
        commit: flags.commit ?? git(root, ['rev-parse', 'HEAD']),
      };
      if (flags['evidence-note']) ref.note = String(flags['evidence-note']);
      task.evidence = task.evidence.filter((e) => e.path !== ref.path);
      task.evidence.push(ref);
    }
    next.next_eligible_prompts = computeEligible(ledger, next.tasks);
    if (flags['current-prompt']) {
      next.current_prompt = String(flags['current-prompt']);
    } else if (status === 'completed' && current.current_prompt === prompt) {
      next.current_prompt = next.next_eligible_prompts[0] ?? prompt;
    } else {
      next.current_prompt = prompt;
    }
    if (flags['verified-commit']) next.last_verified_commit = String(flags['verified-commit']);
    // An empty eligible list is a real state: every prompt is completed, skipped or
    // blocked. Back-filling the current prompt here made `validate` disagree with
    // `computeEligible` on the last prompt of the project.
    next.revision = current.revision + 1;
    next.last_checkpoint_utc = utcNow();

    if (!schemas.state(next)) {
      console.error(`refusing to write invalid state: ${fmtAjv(schemas.state.errors)}`);
      return EXIT.invalid;
    }

    const backupDir = path.join(root, '.mona', 'build', 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(statePath, path.join(backupDir, `state.r${current.revision}.json`));

    const tmp = atomicWriteJson(statePath, next, { tmpDir });
    applyFault('after-temp-write');
    fs.renameSync(tmp, statePath);
    applyFault('after-rename');

    const historyDir = path.join(root, '.mona', 'build', 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.copyFileSync(statePath, path.join(historyDir, `state.r${next.revision}.json`));
    fs.appendFileSync(
      path.join(root, '.mona', 'build', 'checkpoints.jsonl'),
      `${JSON.stringify({ utc: next.last_checkpoint_utc, revision: next.revision, prompt, status, note: flags['note']?.join(' | ') ?? null, commit: flags.commit ?? git(root, ['rev-parse', 'HEAD']) })}\n`,
    );
    console.log(`checkpoint r${next.revision}: ${prompt} -> ${status}; current=${next.current_prompt}; eligible=${next.next_eligible_prompts.join(', ') || 'none'}`);
    return EXIT.ok;
  });
}

function cmdRecover(root, flags = {}) {
  const statePath = path.join(root, '.mona', 'build', 'state.json');
  const tmpDir = path.join(root, '.mona', 'build', 'tmp');
  const quarantine = path.join(tmpDir, 'quarantine');
  const schemas = compiler(root);
  const report = { cleared_lock: null, promoted: null, quarantined: [], restored_backup: null, state_revision: null, ok: false };

  const lock = clearDeadLock(root);
  if (lock.cleared) report.cleared_lock = lock.holder;
  else if (lock.holder && !flags.force) {
    console.error(`refusing recovery: a live process holds the checkpoint lock (${lock.holder}); pass --force only after confirming it is gone`);
    return EXIT.io;
  }

  const readValid = (file) => {
    try {
      const value = readJson(file);
      return schemas.state(value) ? value : null;
    } catch {
      return null;
    }
  };

  let current = fs.existsSync(statePath) ? readValid(statePath) : null;
  const pending = scanInterruptedTemps(root)
    .map((f) => ({ file: f, state: readValid(f) }))
    .sort((a, b) => (b.state?.revision ?? -1) - (a.state?.revision ?? -1));

  const promote = pending.find((p) => p.state && (!current || p.state.revision > current.revision));
  if (promote) {
    fs.renameSync(promote.file, statePath);
    current = promote.state;
    report.promoted = rel(root, promote.file);
  }
  for (const p of pending) {
    if (p === promote || !fs.existsSync(p.file)) continue;
    fs.mkdirSync(quarantine, { recursive: true });
    const dest = path.join(quarantine, `${path.basename(p.file)}.${Date.now()}`);
    fs.renameSync(p.file, dest);
    report.quarantined.push({ file: rel(root, p.file), valid: Boolean(p.state), kept_as: rel(root, dest) });
  }

  if (!current) {
    const backupDir = path.join(root, '.mona', 'build', 'backup');
    const backups = fs.existsSync(backupDir)
      ? fs
          .readdirSync(backupDir)
          .filter((f) => /^state\.r\d+\.json$/.test(f))
          .map((f) => ({ file: path.join(backupDir, f), rev: Number(/r(\d+)\.json$/.exec(f)[1]) }))
          .sort((a, b) => b.rev - a.rev)
      : [];
    for (const b of backups) {
      const value = readValid(b.file);
      if (value) {
        fs.copyFileSync(b.file, statePath);
        current = value;
        report.restored_backup = rel(root, b.file);
        break;
      }
    }
  }

  report.state_revision = current?.revision ?? null;
  report.ok = Boolean(current);
  console.log(JSON.stringify(report, null, 2));
  if (!current) {
    console.error('recovery failed: no valid state, temp or backup found');
    return EXIT.invalid;
  }
  return EXIT.ok;
}

function cmdEvidence(root, flags) {
  const reqId = flags.requirement;
  const critId = flags.criterion;
  const file = flags.path;
  if (!reqId || !critId || !file) {
    console.error('usage: evidence --requirement MONA-001 --criterion identity --path docs/evidence/x.md [--status passed] [--note ...]');
    return EXIT.usage;
  }
  const ledgerPath = path.join(root, 'docs', 'requirements.json');
  const schemas = compiler(root);
  return withLock(root, () => {
    const ledger = readJson(ledgerPath);
    if (flags['expected-revision'] && Number(flags['expected-revision']) !== ledger.revision) {
      console.error(`ledger revision conflict: at ${ledger.revision}, caller expected ${flags['expected-revision']}`);
      return EXIT.conflict;
    }
    const req = ledger.requirements.find((r) => r.id === reqId);
    const crit = req?.criteria.find((c) => c.id === critId);
    if (!req || !crit) {
      console.error(`unknown requirement/criterion ${reqId}/${critId}`);
      return EXIT.usage;
    }
    const target = abs(root, file);
    if (!fs.existsSync(target)) {
      console.error(`evidence path does not exist: ${file}`);
      return EXIT.usage;
    }
    const ref = {
      path: rel(root, target),
      sha256: sha256File(target),
      kind: flags.kind ?? 'document',
      recorded_utc: utcNow(),
      commit: flags.commit ?? git(root, ['rev-parse', 'HEAD']),
    };
    if (flags.note) ref.note = String(flags.note);
    // An artifact that was edited after being recorded leaves a stale reference
    // behind on every criterion that cited it. Pruning is explicit and only
    // drops references whose file is missing or whose digest no longer matches.
    if (flags['prune-stale'] === true) {
      for (const criterion of req.criteria) {
        criterion.evidence = criterion.evidence.filter((entry) => {
          const candidate = abs(root, entry.path);
          return fs.existsSync(candidate) && entry.sha256 === sha256File(candidate);
        });
      }
    }
    crit.evidence = crit.evidence.filter((e) => e.path !== ref.path);
    crit.evidence.push(ref);
    if (flags.status) crit.status = String(flags.status);

    const statuses = req.criteria.map((c) => c.status);
    if (statuses.some((s) => s === 'failed' || s === 'blocked')) req.status = 'blocked';
    else if (statuses.every((s) => s === 'passed' || s === 'not_applicable')) req.status = 'verified';
    else if (statuses.some((s) => s === 'passed' || s === 'partial')) req.status = 'partial';
    if (flags['requirement-status']) req.status = String(flags['requirement-status']);
    if (req.status === 'verified') {
      req.verified_commit = flags.commit ?? git(root, ['rev-parse', 'HEAD']);
      req.tested_environment = flags.environment ?? `${process.platform}-${process.arch} node ${process.version}`;
    }
    ledger.revision += 1;
    if (!schemas.ledger(ledger)) {
      console.error(`refusing to write invalid ledger: ${fmtAjv(schemas.ledger.errors)}`);
      return EXIT.invalid;
    }
    const tmp = atomicWriteJson(ledgerPath, ledger, { tmpDir: path.join(root, '.mona', 'build', 'tmp') });
    fs.renameSync(tmp, ledgerPath);
    console.log(`evidence -> ${reqId}/${critId}: ${ref.path} (${ref.sha256.slice(0, 12)}); criterion=${crit.status}; requirement=${req.status}; ledger r${ledger.revision}`);
    return EXIT.ok;
  });
}

function cmdStatus(root) {
  const { state } = readState(root);
  const { ledger } = readLedger(root);
  const byStatus = {};
  for (const t of Object.values(state.tasks)) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const reqByStatus = {};
  for (const r of ledger.requirements) reqByStatus[r.status] = (reqByStatus[r.status] ?? 0) + 1;

  // The Windows supplement reports its own pending queue. Eligibility mirrors
  // the original rule: an unfinished prompt whose prerequisites are completed.
  const { ledger: windows } = readWindowsLedger(root);
  let windowsSummary = null;
  if (windows) {
    const windowsStatus = {};
    for (const prompt of windows.prompts) {
      windowsStatus[prompt.status] = (windowsStatus[prompt.status] ?? 0) + 1;
    }
    const windowsReqStatus = {};
    for (const requirement of windows.requirements) {
      windowsReqStatus[requirement.status] = (windowsReqStatus[requirement.status] ?? 0) + 1;
    }
    const statusById = new Map(windows.prompts.map((p) => [p.id, p.status]));
    const eligible = windows.prompts
      .filter(
        (prompt) =>
          prompt.status !== 'completed' &&
          prompt.status !== 'skipped' &&
          prompt.status !== 'blocked' &&
          prompt.prerequisites.every((dep) => statusById.get(dep) === 'completed'),
      )
      .map((prompt) => prompt.id);
    windowsSummary = {
      revision: windows.revision,
      prompts: windowsStatus,
      eligible,
      requirements: windowsReqStatus,
    };
  }
  console.log(
    JSON.stringify(
      {
        revision: state.revision,
        current_prompt: state.current_prompt,
        prompts: byStatus,
        eligible: state.next_eligible_prompts,
        requirements: reqByStatus,
        last_checkpoint_utc: state.last_checkpoint_utc,
        windows_supplement: windowsSummary,
      },
      null,
      2,
    ),
  );
  return EXIT.ok;
}

function usage() {
  console.log(`mona build utility (P00)
usage: node tools/build/cli.mjs <command> [--root DIR]

  index        hash + index the spec documents -> docs/spec-index.json
  init         create .mona/build/state.json from docs/requirements.json [--force]
  validate     schema/semantic validation [--verbose] [--json]
  checkpoint   --prompt P00 --status completed --expected-revision N
               [--completed-step s]... [--remaining-step s]... [--clear-remaining-steps] [--evidence path]...
               [--blocker ISSUE-0001]... [--current-prompt P01] [--verified-commit SHA]
  recover      promote a complete interrupted write or restore a verified backup
  evidence     --requirement MONA-001 --criterion identity --path docs/evidence/x.md
               [--status passed] [--note text] [--expected-revision N] [--prune-stale]
  status       compact state summary`);
  return EXIT.usage;
}

// --------------------------------------------------------------------- main

const { command, flags, root } = parseArgs(process.argv.slice(2));
let code = EXIT.ok;
try {
  switch (command) {
    case 'index':
      code = cmdIndex(root, flags);
      break;
    case 'init':
      code = cmdInit(root, flags);
      break;
    case 'validate':
      code = cmdValidate(root, flags);
      break;
    case 'checkpoint':
      code = cmdCheckpoint(root, flags);
      break;
    case 'recover':
      code = cmdRecover(root, flags);
      break;
    case 'evidence':
      code = cmdEvidence(root, flags);
      break;
    case 'status':
      code = cmdStatus(root, flags);
      break;
    case 'help':
    case '--help':
      code = usage();
      break;
    default:
      console.error(`unknown command: ${command}`);
      code = usage();
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  code = EXIT.io;
}
process.exitCode = code;

