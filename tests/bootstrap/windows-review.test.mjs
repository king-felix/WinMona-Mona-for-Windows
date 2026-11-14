// The Windows review ledger is a separate state file with its own gate. These
// tests prove the gate is real: no completion without evidence, no stale writer,
// and no fourth attempt after a three-no-progress stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLI = path.join(REPO, 'tools', 'build', 'windows-review.mjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-wr-'));
  for (const entry of [
    'docs',
    'tools',
    'Mona_Windows_Improvements_Project.md',
    'Mona_Windows_Improvements_PROMPTS.md',
  ]) {
    fs.cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], { cwd: root, encoding: 'utf8' });
}

function state(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.mona', 'build', 'reviews', 'windows-v2', 'state.json'), 'utf8'));
}

test('init seeds every W task and validate is clean', () => {
  const root = sandbox();
  const init = run(root, 'init');
  assert.equal(init.status, 0, init.stderr);
  const seeded = state(root);
  assert.equal(Object.keys(seeded.tasks).length, 26);
  assert.deepEqual(seeded.tasks.W01.prerequisites, ['W00']);
  assert.equal(seeded.current_task, 'W00');
  const valid = run(root, 'validate');
  assert.equal(valid.status, 0, valid.stderr);
});

test('checkpoint refuses a stale revision and a completion without evidence', () => {
  const root = sandbox();
  assert.equal(run(root, 'init').status, 0);

  const stale = run(root, 'checkpoint', '--task', 'W00', '--status', 'completed', '--expected-revision', '9');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /revision conflict/);

  const unevidenced = run(root, 'checkpoint', '--task', 'W00', '--status', 'completed', '--expected-revision', '1');
  assert.equal(unevidenced.status, 1);
  assert.match(unevidenced.stderr, /completed without evidence/);

  const evidence = path.join(root, 'docs', 'evidence', 'W00-baseline.md');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, '# W00 baseline\n', 'utf8');
  const done = run(
    root,
    'checkpoint',
    '--task',
    'W00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--acceptance-done',
    'baseline recorded',
    '--clear-acceptance-open',
    '--evidence',
    evidence,
  );
  assert.equal(done.status, 0, done.stderr);
  const next = state(root);
  assert.equal(next.tasks.W00.status, 'completed');
  assert.equal(next.tasks.W00.acceptance_open.length, 0);
  assert.equal(next.revision, 2);
});

test('a completed task with an open acceptance item is refused', () => {
  const root = sandbox();
  assert.equal(run(root, 'init').status, 0);
  const evidence = path.join(root, 'docs', 'evidence', 'W00.md');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, 'x', 'utf8');
  const refused = run(
    root,
    'checkpoint',
    '--task',
    'W00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--evidence',
    evidence,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /open acceptance item/);
});

test('a wrong completion can be corrected by clearing the recorded acceptance', () => {
  const root = sandbox();
  assert.equal(run(root, 'init').status, 0);
  const evidence = path.join(root, 'docs', 'evidence', 'W00.md');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, 'x', 'utf8');

  const overclaimed = run(
    root,
    'checkpoint',
    '--task',
    'W00',
    '--status',
    'completed',
    '--expected-revision',
    '1',
    '--acceptance-done',
    'everything including the unobserved item',
    '--clear-acceptance-open',
    '--evidence',
    evidence,
  );
  assert.equal(overclaimed.status, 0, overclaimed.stderr);
  assert.deepEqual(state(root).tasks.W00.acceptance_done, ['everything including the unobserved item']);

  // Rewinding to verifying with the claim removed is accepted, and the row keeps
  // only the acceptance the evidence actually supports.
  const corrected = run(
    root,
    'checkpoint',
    '--task',
    'W00',
    '--status',
    'verifying',
    '--expected-revision',
    '2',
    '--clear-acceptance-done',
    '--acceptance-done',
    'the observed part',
    '--acceptance-open',
    'the unobserved part',
  );
  assert.equal(corrected.status, 0, corrected.stderr);
  const row = state(root).tasks.W00;
  assert.equal(row.status, 'verifying');
  assert.deepEqual(row.acceptance_done, ['the observed part']);
  assert.deepEqual(row.acceptance_open, ['the unobserved part']);
});
test('the third no-progress attempt stops the problem and a fourth is refused', () => {
  const root = sandbox();
  assert.equal(run(root, 'init').status, 0);
  const args = (n) => [
    'attempt',
    '--problem',
    'P-W01-001',
    '--task',
    'W01',
    '--symptom',
    'draft lost',
    '--hypothesis',
    `h${n}`,
    '--action',
    `a${n}`,
    '--result',
    `r${n}`,
    '--material-progress',
    'no',
  ];
  for (let n = 1; n <= 3; n += 1) {
    const row = run(root, ...args(n));
    assert.equal(row.status, 0, row.stderr);
    assert.match(row.stdout, new RegExp(`${n}/3`));
  }
  const fourth = run(root, ...args(4));
  assert.equal(fourth.status, 1);
  assert.match(fourth.stderr, /already stopped/);
});

test('material progress resets the no-progress counter', () => {
  const root = sandbox();
  assert.equal(run(root, 'init').status, 0);
  const attempt = (material) =>
    run(
      root,
      'attempt',
      '--problem',
      'P-W02-001',
      '--task',
      'W02',
      '--symptom',
      'orphan rows',
      '--hypothesis',
      'h',
      '--action',
      'a',
      '--result',
      'r',
      '--material-progress',
      material,
    );
  assert.match(attempt('no').stdout, /1\/3/);
  assert.match(attempt('no').stdout, /2\/3/);
  assert.match(attempt('yes').stdout, /0\/3/);
  assert.match(attempt('no').stdout, /1\/3/);
});
