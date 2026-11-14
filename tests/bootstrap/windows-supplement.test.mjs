// The Windows improvement supplement is a second id space. These tests prove the
// gate is real: the registry must match its documents, cover every prompt, and
// refuse a completion claim that has no evidence behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLI = path.join(REPO, 'tools', 'build', 'cli.mjs');
const LEDGER = path.join('docs', 'requirements-windows.json');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-wx-'));
  for (const entry of [
    'docs',
    'tools',
    'assets',
    'package.json',
    'Mona_Project.md',
    'Mona_PROMPTS.md',
    'Mona_Windows_Improvements_Project.md',
    'Mona_Windows_Improvements_PROMPTS.md',
  ]) {
    fs.cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(root, '.mona', 'build'), { recursive: true });
  // Evidence outside docs/ is cited by both ledgers; copy only those files rather
  // than the whole source tree.
  for (const file of ['apps/desktop/src/main/provider-workbench.test.ts', 'tools/assets/build-icons.mjs']) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  }
  fs.copyFileSync(path.join(REPO, '.mona', 'build', 'state.json'), path.join(root, '.mona', 'build', 'state.json'));
  return root;
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const root = sandbox();
const ledgerFile = path.join(root, LEDGER);
const originalLedger = fs.readFileSync(ledgerFile, 'utf8');

function withLedger(mutate, fn) {
  const ledger = JSON.parse(originalLedger);
  mutate(ledger);
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    fn();
  } finally {
    fs.writeFileSync(ledgerFile, originalLedger);
  }
}

test('the committed supplement validates and its eligibility stays consistent', () => {
  const validated = cli(root, ['validate']);
  assert.equal(validated.code, 0, validated.err);

  const status = JSON.parse(cli(root, ['status']).out);
  const supplement = status.windows_supplement;
  // The aggregate is a property, not a snapshot: work is completed over time, so
  // asserting the seeded all-pending counts turned a green ledger into a red test
  // the moment W01 was finished. What must hold is that every prompt is accounted
  // for exactly once and that eligibility only names work that can actually start.
  const counted = Object.values(supplement.prompts).reduce((sum, value) => sum + value, 0);
  assert.equal(counted, 26, 'all 26 W prompts are counted once');
  const requirementCount = Object.values(supplement.requirements).reduce((sum, value) => sum + value, 0);
  assert.equal(requirementCount, 18, 'all 18 WX requirements are counted once');

  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const byId = new Map(ledger.prompts.map((prompt) => [prompt.id, prompt]));
  for (const id of supplement.eligible) {
    const prompt = byId.get(id);
    assert.ok(prompt, `${id} exists in the ledger`);
    assert.equal(prompt.status, 'pending', `${id} is eligible only while pending`);
    for (const prerequisite of prompt.prerequisites) {
      assert.equal(
        byId.get(prerequisite)?.status,
        'completed',
        `${id} is eligible, so ${prerequisite} must be completed`,
      );
    }
  }
});

test('a supplement without its ledger is refused', () => {
  fs.rmSync(ledgerFile);
  try {
    const r = cli(root, ['validate']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /requirements-windows\.json is missing/);
  } finally {
    fs.writeFileSync(ledgerFile, originalLedger);
  }
});

test('a prompt title that drifts from the document is refused', () => {
  withLedger(
    (ledger) => {
      ledger.prompts[0].title = 'An invented baseline prompt';
    },
    () => {
      const r = cli(root, ['validate']);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /W00 title is stale/i);
    },
  );
});

test('a prompt claimed by no requirement is refused', () => {
  withLedger(
    (ledger) => {
      const requirement = ledger.requirements.find((row) => row.id === 'WX-02');
      requirement.owning_prompts = [];
      ledger.prompts.find((prompt) => prompt.id === 'W01').requirements = [];
    },
    () => {
      const r = cli(root, ['validate']);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /W01 is not claimed by any WX requirement/);
    },
  );
});

test('a completed prompt without evidence is refused', () => {
  withLedger(
    (ledger) => {
      ledger.prompts[0].status = 'completed';
    },
    () => {
      const r = cli(root, ['validate']);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /W00 is completed without evidence/);
    },
  );
});

test('a verified requirement without an original-ledger mapping is refused', () => {
  withLedger(
    (ledger) => {
      const requirement = ledger.requirements[0];
      requirement.status = 'verified';
      requirement.verified_commit = 'a'.repeat(40);
      requirement.criteria[0].status = 'passed';
      requirement.criteria[0].evidence = [{ path: 'package.json' }];
    },
    () => {
      const r = cli(root, ['validate']);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /without an original-ledger mapping/);
    },
  );
});

test('the generated registry matches its documents', () => {
  const r = spawnSync(process.execPath, ['tools/build/seed-windows-ledger.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(
    fs.readFileSync(ledgerFile, 'utf8'),
    originalLedger,
    're-seeding an unchanged document must not rewrite the ledger',
  );
});
