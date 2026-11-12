import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  MENU_KEYS,
  MENU_LABEL,
  buildLaunchCommand,
  executePlan,
  expectedValues,
  parseRegExport,
  planRegistration,
  planRemoval,
  sectionFor,
  unregister,
  verifyRegistration,
} from '../../tools/launch/context-menu.mjs';

const EXE = 'C:\\Program Files\\Mona\\Mona.exe';
const APP = 'C:\\repo\\apps\\desktop';

test('the registered command quotes the executable, the app directory and %V', () => {
  const command = buildLaunchCommand({ executable: EXE, appPath: APP });
  assert.equal(
    command,
    `"C:\\Program Files\\Mona\\Mona.exe" "C:\\repo\\apps\\desktop" project open --path "%V" --profile ds-full-access`,
  );
  // No selected folder is ever interpolated: only Explorer's quoted placeholder.
  assert.equal(command.match(/%V/g).length, 1);
  assert.match(command, /--path "%V"/);
});

test('a hostile folder name cannot appear in the registration at all', () => {
  const command = buildLaunchCommand({ executable: EXE });
  for (const hostile of ['& calc.exe', 'a"b', 'x|y', '%PATH%', '$(calc)']) {
    assert.equal(command.includes(hostile), false);
  }
});

test('relative or quote-bearing executable paths are refused', () => {
  assert.throws(() => buildLaunchCommand({ executable: 'Mona.exe' }), /absolute path/);
  assert.throws(() => buildLaunchCommand({ executable: 'C:\\Mona" .exe' }), /quote or control/);
  assert.throws(() => buildLaunchCommand({ executable: EXE, appPath: 'apps' }), /absolute path/);
});

test('registration names both keys with the exact label and command', () => {
  const plan = planRegistration({ executable: EXE, appPath: APP });
  assert.equal(plan.ops.length, 12);
  const keys = new Set(plan.ops.map((op) => op.key));
  assert.deepEqual(
    [...keys].sort(),
    [MENU_KEYS.background, `${MENU_KEYS.background}\\command`, MENU_KEYS.folder, `${MENU_KEYS.folder}\\command`].sort(),
  );
  for (const key of [MENU_KEYS.folder, MENU_KEYS.background]) {
    const label = plan.ops.find((op) => op.key === key && op.name === null);
    assert.equal(label.value, MENU_LABEL);
    const command = plan.ops.find((op) => op.key === `${key}\\command`);
    assert.equal(command.value, plan.command);
    assert.equal(command.args[0], 'add');
    assert.equal(command.args[1], `${key}\\command`);
    assert.equal(command.args.at(-1), '/f');
  }
});

test('removal names only Mona keys and never their parents', () => {
  const removal = planRemoval();
  assert.deepEqual(removal.map((op) => op.key).sort(), [MENU_KEYS.background, MENU_KEYS.folder].sort());
  for (const op of removal) {
    assert.deepEqual(op.args, ['delete', op.key, '/f']);
    assert.match(op.key, /\\Mona\.StartNewProject$/);
  }
});

test('the executor passes argument arrays and stops at the first refusal by default', () => {
  const calls = [];
  const runReg = (args) => {
    calls.push(args);
    return { status: calls.length === 2 ? 5 : 0, stdout: '', stderr: 'denied' };
  };
  const results = executePlan(planRegistration({ executable: EXE, appPath: APP }).ops, runReg);
  assert.equal(calls.length, 2);
  assert.equal(results[1].status, 5);
  // Every call is an argv-shaped array; no call is a shell string.
  for (const args of calls) assert.ok(Array.isArray(args) && args.every((value) => typeof value === 'string'));

  const continued = [];
  executePlan(
    planRemoval(),
    (args) => {
      continued.push(args);
      return { status: 1, stdout: '', stderr: 'missing' };
    },
    { stopOnFailure: false },
  );
  assert.equal(continued.length, 2);
});

test('reg export parsing reads escaped quotes, backslashes and empty values', () => {
  const text = [
    'Windows Registry Editor Version 5.00',
    '',
    `[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Mona.StartNewProject]`,
    '@="Start new DS project with Mona"',
    '"Icon"="C:\\\\Program Files\\\\Mona\\\\Mona.exe"',
    '"NeverDefault"=""',
    '"MultiSelectModel"="Single"',
    '',
    `[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Mona.StartNewProject\\command]`,
    '@="\\"C:\\\\Program Files\\\\Mona\\\\Mona.exe\\" project open --path \\"%V\\" --profile ds-full-access"',
    '',
  ].join('\r\n');
  const sections = parseRegExport(text);
  const main = sectionFor(sections, MENU_KEYS.folder);
  assert.equal(main['@'], MENU_LABEL);
  assert.equal(main.Icon, EXE);
  assert.equal(main.NeverDefault, '');
  const command = sectionFor(sections, `${MENU_KEYS.folder}\\command`);
  assert.equal(command['@'], buildLaunchCommand({ executable: EXE }));
});

async function fakeExportRun(valuesByKey) {
  return async (args) => {
    if (args[0] !== 'export') return { status: 1, stdout: '', stderr: 'unsupported' };
    const key = args[1];
    const values = valuesByKey[key];
    if (!values) return { status: 1, stdout: '', stderr: 'not found' };
    const lines = ['Windows Registry Editor Version 5.00', '', `[${key.replace(/^HKCU/i, 'HKEY_CURRENT_USER')}]`];
    for (const [name, value] of Object.entries(values)) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(name === '@' ? `@="${escaped}"` : `"${name}"="${escaped}"`);
    }
    const file = args[2];
    await writeFile(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf16le');
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('verification compares every value Mona owns on both keys', async () => {
  const expected = expectedValues({ executable: EXE, appPath: APP });
  const values = {
    [MENU_KEYS.folder]: {
      '@': expected['@'],
      Icon: expected.Icon,
      MonaOwned: '1',
      NeverDefault: '',
      MultiSelectModel: 'Single',
    },
    [`${MENU_KEYS.folder}\\command`]: { '@': expected.command['@'] },
    [MENU_KEYS.background]: {
      '@': expected['@'],
      Icon: expected.Icon,
      MonaOwned: '1',
      NeverDefault: '',
      MultiSelectModel: 'Single',
    },
    [`${MENU_KEYS.background}\\command`]: { '@': expected.command['@'] },
  };
  const good = await verifyRegistration({ executable: EXE, appPath: APP }, await fakeExportRun(values));
  assert.equal(good.verified, true);
  assert.deepEqual(good.problems, []);

  values[`${MENU_KEYS.background}\\command`]['@'] = '"C:\\Other\\Mona.exe" project open --path "%V"';
  const bad = await verifyRegistration({ executable: EXE, appPath: APP }, await fakeExportRun(values));
  assert.equal(bad.verified, false);
  assert.ok(bad.problems.some((problem) => problem.includes('command does not match')));
});

test('uninstall removes Mona keys only and leaves a foreign menu entry alone', async () => {
  const registry = new Map([
    [MENU_KEYS.folder, { '@': MENU_LABEL }],
    [`${MENU_KEYS.folder}\\command`, { '@': 'x' }],
    [MENU_KEYS.background, { '@': MENU_LABEL }],
    [`${MENU_KEYS.background}\\command`, { '@': 'x' }],
    ['HKCU\\Software\\Classes\\Directory\\shell\\SomeOtherTool', { '@': 'Some other tool' }],
  ]);
  const deleted = [];
  const runReg = (args) => {
    if (args[0] === 'query') return { status: registry.has(args[1]) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'delete') {
      deleted.push(args[1]);
      for (const key of [...registry.keys()]) {
        if (key === args[1] || key.startsWith(`${args[1]}\\`)) registry.delete(key);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unsupported' };
  };
  const result = await unregister(runReg);
  assert.deepEqual(result.removed.sort(), ['background', 'folder']);
  assert.equal(result.verified, true);
  assert.equal(deleted.length, 2);
  assert.ok(registry.has('HKCU\\Software\\Classes\\Directory\\shell\\SomeOtherTool'));
});

test('uninstalling when nothing is registered is a verified no-op', async () => {
  const runReg = (args) => {
    if (args[0] === 'query') return { status: 1, stdout: '', stderr: 'not found' };
    if (args[0] === 'delete') return { status: 1, stdout: '', stderr: 'not found' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const result = await unregister(runReg);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.absent.sort(), ['background', 'folder']);
  assert.equal(result.verified, true);
});

test('registration is expressed identically on a repeat run', () => {
  const first = planRegistration({ executable: EXE, appPath: APP });
  const second = planRegistration({ executable: EXE, appPath: APP });
  assert.deepEqual(
    second.ops.map((op) => op.args),
    first.ops.map((op) => op.args),
  );
  // Every write overwrites its value with /f; no key is created twice.
  for (const op of first.ops) assert.equal(op.args.at(-1), '/f');
});

test('the module never builds a shell command string', async () => {
  const source = await readFile(new URL('../../tools/launch/context-menu.mjs', import.meta.url), 'utf8');
  assert.equal(/spawnSync\([^)]*shell\s*:\s*true/.test(source), false);
  assert.equal(/['"]\/c['"]/.test(source), false);
});
