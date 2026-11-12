// P00 bootstrap tests: atomicity, revision conflicts, recovery, graph and hash validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLI = path.join(REPO, 'tools', 'build', 'cli.mjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-p00-'));
  const skip = /(^|[\\/])(node_modules|\.git|\.mona[\\/]build|dist|out)([\\/]|$)/;
  fs.cpSync(REPO, root, {
    recursive: true,
    filter: (src) => {
      const r = path.relative(REPO, src);
      return r === '' || !skip.test(r);
    },
  });
  // Build an independent baseline (revision 1, every prompt pending) so these
  // tests stay valid as the real build progresses through later prompts. Reset
  // the copied ledger's progress too; otherwise a requirement verified by a
  // later prompt changes what `evidence` derives here.
  const ledgerPath = path.join(root, 'docs', 'requirements.json');
  const baseline = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  baseline.revision = 1;
  for (const requirement of baseline.requirements) {
    requirement.status = 'pending';
    requirement.verified_commit = null;
    requirement.tested_environment = null;
    requirement.open_issue_ids = requirement.open_issue_ids ?? [];
    for (const criterion of requirement.criteria) {
      criterion.status = 'pending';
      criterion.evidence = [];
    }
  }
  fs.writeFileSync(ledgerPath, `${JSON.stringify(baseline, null, 2)}\n`);
  const seeded = cli(root, ['init']);
  assert.equal(seeded.code, 0, seeded.err);
  return root;
}

function cli(root, args, env = {}) {
  const clean = { ...process.env };
  delete clean.MONA_FAULT_AFTER_TEMP_WRITE;
  delete clean.MONA_FAULT_AFTER_RENAME;
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, '.mona', 'build', 'state.json'), 'utf8'));
const readLedger = (root) => JSON.parse(fs.readFileSync(path.join(root, 'docs', 'requirements.json'), 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

test('checkpoint advances revision atomically and journals the boundary', () => {
  const root = sandbox();
  const before = readState(root);
  assert.equal(before.revision, 1);

  const r = cli(root, [
    'checkpoint',
    '--prompt',
    'P00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--completed-step',
    'bootstrap test step',
    '--evidence',
    'docs/requirements.json',
    '--note',
    'unit test boundary',
  ]);
  assert.equal(r.code, 0, r.err);

  const after = readState(root);
  assert.equal(after.revision, 2);
  assert.equal(after.tasks.P00.status, 'completed');
  assert.equal(after.tasks.P00.evidence.length, 1);
  assert.match(after.tasks.P00.evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(after.current_prompt, 'P01');
  assert.deepEqual(after.next_eligible_prompts, ['P01']);
  assert.ok(fs.existsSync(path.join(root, '.mona', 'build', 'backup', 'state.r1.json')), 'prior revision kept');
  assert.ok(fs.existsSync(path.join(root, '.mona', 'build', 'history', 'state.r2.json')), 'history copy written');
  const journal = fs
    .readFileSync(path.join(root, '.mona', 'build', 'checkpoints.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(journal.length, 1);
  assert.equal(JSON.parse(journal[0]).revision, 2);
  assert.equal(cli(root, ['validate']).code, 0);
});

test('stale expected revision is refused and state is untouched', () => {
  const root = sandbox();
  assert.equal(
    cli(root, ['checkpoint', '--prompt', 'P00', '--status', 'completed', '--expected-revision', '1']).code,
    0,
  );
  const snapshot = readState(root);

  const r = cli(root, ['checkpoint', '--prompt', 'P00', '--status', 'completed', '--expected-revision', '1']);
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /revision conflict/);
  assert.deepEqual(readState(root), snapshot);
});

test('a write interrupted after the temp file is promoted by recover', () => {
  const root = sandbox();
  const r = cli(root, ['checkpoint', '--prompt', 'P00', '--status', 'completed', '--expected-revision', '1'], {
    MONA_FAULT_AFTER_TEMP_WRITE: '1',
  });
  assert.equal(r.code, 70, 'fault must abort before rename');
  assert.equal(readState(root).revision, 1, 'committed state stays at the last complete revision');
  const temps = fs.readdirSync(path.join(root, '.mona', 'build', 'tmp')).filter((f) => f.endsWith('.tmp'));
  assert.equal(temps.length, 1, 'the complete pending write is left on disk');

  const rec = cli(root, ['recover']);
  assert.equal(rec.code, 0, rec.err);
  const report = JSON.parse(rec.out);
  assert.ok(report.promoted, 'a complete pending write is promoted');
  const after = readState(root);
  assert.equal(after.revision, 2);
  assert.equal(after.tasks.P00.status, 'completed');
  assert.equal(cli(root, ['validate']).code, 0, 'state is valid after recovery');
});

test('a torn temp file is quarantined and the committed state survives', () => {
  const root = sandbox();
  const tmpDir = path.join(root, '.mona', 'build', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'state.json.999.1.tmp'), '{"schema_version":1,"revision":2,"tasks":');

  const rec = cli(root, ['recover']);
  assert.equal(rec.code, 0, rec.err);
  const report = JSON.parse(rec.out);
  assert.equal(report.promoted, null);
  assert.equal(report.quarantined.length, 1);
  assert.equal(report.quarantined[0].valid, false);
  assert.equal(readState(root).revision, 1);
});

test('a corrupt state file is restored from the newest verified backup', () => {
  const root = sandbox();
  assert.equal(
    cli(root, ['checkpoint', '--prompt', 'P00', '--status', 'completed', '--expected-revision', '1']).code,
    0,
  );
  fs.writeFileSync(path.join(root, '.mona', 'build', 'state.json'), '{"torn":');

  const rec = cli(root, ['recover']);
  assert.equal(rec.code, 0, rec.err);
  const report = JSON.parse(rec.out);
  assert.match(report.restored_backup, /state\.r1\.json$/);
  assert.equal(readState(root).revision, 1);
  assert.equal(cli(root, ['validate']).code, 0);
});

test('validation rejects a dependency cycle', () => {
  const root = sandbox();
  const ledger = readLedger(root);
  ledger.prompts.find((p) => p.id === 'P02').prerequisites = ['P07'];
  writeJson(path.join(root, 'docs', 'requirements.json'), ledger);

  const r = cli(root, ['validate']);
  assert.equal(r.code, 3);
  assert.match(r.err, /dependency cycle/);
});

test('validation rejects an unregistered requirement and an unknown owner', () => {
  const root = sandbox();
  const ledger = readLedger(root);
  ledger.requirements = ledger.requirements.filter((r) => r.id !== 'MONA-030');
  writeJson(path.join(root, 'docs', 'requirements.json'), ledger);

  const r = cli(root, ['validate']);
  assert.equal(r.code, 3);
  assert.match(r.err, /MONA-030/);
});

test('validation rejects a changed specification whose recorded hash is stale', () => {
  const root = sandbox();
  fs.appendFileSync(path.join(root, 'Mona_Project.md'), '\n<!-- edited after indexing -->\n');

  const r = cli(root, ['validate']);
  assert.equal(r.code, 3);
  assert.match(r.err, /spec\.sha256 does not match|stale/);
});

test('validation rejects a passed criterion with no evidence', () => {
  const root = sandbox();
  const ledger = readLedger(root);
  ledger.requirements[0].criteria[0].status = 'passed';
  ledger.requirements[0].criteria[0].evidence = [];
  writeJson(path.join(root, 'docs', 'requirements.json'), ledger);

  const r = cli(root, ['validate']);
  assert.equal(r.code, 3);
  assert.match(r.err, /without evidence/);
});

test('evidence command records a hash and derives requirement status', () => {
  const root = sandbox();
  const before = readLedger(root).revision;
  const r = cli(root, [
    'evidence',
    '--requirement',
    'MONA-001',
    '--criterion',
    'identity',
    '--path',
    'docs/requirements.json',
    '--status',
    'passed',
    '--expected-revision',
    String(before),
    '--note',
    'bootstrap test',
  ]);
  assert.equal(r.code, 0, r.err);
  const ledger = readLedger(root);
  assert.equal(ledger.revision, before + 1);
  const req = ledger.requirements.find((x) => x.id === 'MONA-001');
  assert.equal(req.criteria[0].status, 'passed');
  assert.match(req.criteria[0].evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(req.status, 'partial');
  assert.equal(cli(root, ['validate']).code, 0);
});

test('checkpoint refuses evidence paths that do not exist', () => {
  const root = sandbox();
  const r = cli(root, [
    'checkpoint',
    '--prompt',
    'P00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--evidence',
    'docs/evidence/does-not-exist.md',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.err, /does not exist/);
  assert.equal(readState(root).revision, 1);
});

test('a recorded remaining step can be explicitly cleared when it is finished', () => {
  const root = sandbox();
  const first = cli(root, [
    'checkpoint',
    '--prompt',
    'P00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--remaining-step',
    'run the runtime smoke test',
  ]);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(readState(root).tasks.P00.remaining_steps, ['run the runtime smoke test']);

  const second = cli(root, [
    'checkpoint',
    '--prompt',
    'P00',
    '--status',
    'completed',
    '--expected-revision',
    '2',
    '--clear-remaining-steps',
    '--completed-step',
    'runtime smoke test passed',
    '--current-prompt',
    'P01',
  ]);
  assert.equal(second.code, 0, second.err);
  const state = readState(root);
  assert.deepEqual(state.tasks.P00.remaining_steps, []);
  assert.equal(state.tasks.P00.completed_steps.at(-1), 'runtime smoke test passed');
  assert.equal(state.current_prompt, 'P01');
});

test('evidence can prune stale references left on sibling criteria', () => {
  const root = sandbox();
  const ledgerPath = path.join(root, 'docs', 'requirements.json');
  const ledger = readLedger(root);
  const req = ledger.requirements.find((x) => x.id === 'MONA-001');
  req.criteria[1].evidence = [
    {
      path: 'docs/requirements.json',
      sha256: 'f'.repeat(64),
      kind: 'document',
      recorded_utc: '2026-01-01T00:00:00Z',
      commit: null,
    },
  ];
  writeJson(ledgerPath, ledger);

  const r = cli(root, [
    'evidence',
    '--requirement',
    'MONA-001',
    '--criterion',
    'identity',
    '--path',
    'docs/requirements.json',
    '--status',
    'passed',
    '--prune-stale',
  ]);
  assert.equal(r.code, 0, r.err);
  const after = readLedger(root).requirements.find((x) => x.id === 'MONA-001');
  assert.deepEqual(after.criteria[1].evidence, []);
});
