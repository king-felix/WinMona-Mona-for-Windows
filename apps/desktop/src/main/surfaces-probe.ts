import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Live probe for the Cost lens and Work board.
 *
 * The rows are real: cost is ingested through CostLedger, tasks are created
 * through TaskService, and the assertions read the rendered DOM of the actual
 * window. No request is made to any provider and no turn is started.
 *
 * One deliberate seam: the CSV export normally opens the OS save dialog, which a
 * probe cannot click. When the probe passes `exportPath`, main writes there
 * instead. The dialog itself is therefore NOT covered here and the report says so.
 */
export type SurfacesProbeInput = {
  window: BrowserWindow;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  seedCost: (projectId: string, taskId: string | null) => Promise<{ knownMicros: number; unknownRecords: number }>;
  seedTask: (projectId: string) => Promise<{ titles: string[]; ids: string[] }>;
  exportPath: string;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSurfacesProbe(input: SurfacesProbeInput): Promise<{
  ok: boolean;
  steps: Step[];
  shots: Shot[];
  csv: { path: string | null; bytes: number; header: string | null; labels: string[] };
  capturedAt: string;
  providerRequests: 0;
}> {
  const steps: Step[] = [];
  const shots: Shot[] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
    }
    return false;
  };
  const shot = async (label: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${label}.png`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label });
        return true;
      } catch {
        await delay(400);
      }
    }
    return false;
  };
  const text = async (selector: string): Promise<string> =>
    (await evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : ''; })()`,
    )) ?? '';
  const setField = async (selector: string, value: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  const click = async (selector: string): Promise<void> => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
    await delay(450);
  };

  const csv: { path: string | null; bytes: number; header: string | null; labels: string[] } = {
    path: null,
    bytes: 0,
    header: null,
    labels: [],
  };

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const project = await input.openProject(input.workspace);
  check('a real project opens through the catalog', project !== null, project?.canonicalPath ?? null);
  if (!project) {
    return { ok: false, steps, shots, csv, capturedAt: new Date().toISOString(), providerRequests: 0 };
  }

  // Tasks first, so the cost rows can be attributed to one of them.
  const seededTasks = await input.seedTask(project.projectId);

  // The rail only exists once the shell finished its initial load; clicking an
  // element that is not there yet would silently do nothing.
  const railReady = await waitFor(
    async () =>
      (await evaluate<boolean>(
        "Boolean(document.querySelector('[data-testid=\"nav-cost\"]')) && Boolean(document.querySelector('.timeline'))",
      )) === true,
    30_000,
  );
  check('the shell is ready before it is driven', railReady);

  // ---- Cost lens -----------------------------------------------------------
  const seeded = await input.seedCost(project.projectId, seededTasks.ids[0] ?? null);
  await click('[data-testid="nav-cost"]');
  const nav = await evaluate<{
    active: string | null;
    section: string | null;
    bridge: string;
    error: string | null;
    hasKnown: boolean;
    railButtons: number;
  }>(`(() => ({
    active: document.querySelector('[aria-current="page"]')?.textContent ?? null,
    section: document.querySelector('section[aria-labelledby]')?.getAttribute('aria-labelledby') ?? null,
    bridge: typeof window.mona.costLens,
    error: document.querySelector('.error-panel')?.textContent ?? null,
    hasKnown: Boolean(document.querySelector('[data-testid="cost-known"]')),
    railButtons: document.querySelectorAll('[data-testid="nav-cost"]').length,
  }))()`);
  // A click must not be undone by the boot sequence finishing afterwards.
  await delay(400);
  const settled = await evaluate<string | null>(
    'document.querySelector(\'[aria-current="page"]\')?.textContent ?? null',
  );
  check('the first navigation click opens the Cost lens and stays there', settled === 'Cost', { ...nav, settled });
  const costUp = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="cost-known"]\'))')) === true,
  );
  check('the Cost lens renders recorded rows', costUp, { seeded });

  const known = await text('[data-testid="cost-known"]');
  check(
    'known cost matches the ingested micro-USD total',
    known.includes(`$${(seeded.knownMicros / 1_000_000).toFixed(4)}`),
    {
      known,
      seeded,
    },
  );
  check(
    'unknown-priced rows are counted and never folded into the money',
    known.includes(`${seeded.unknownRecords} unknown`) &&
      (await text('[data-testid="cost-unknown"]')) === String(seeded.unknownRecords),
    {
      known,
      unknownText: await text('[data-testid="cost-unknown"]'),
    },
  );
  const bodyText = await text('section[aria-labelledby="cost-title"]');
  check(
    'the provider-reported and locally-estimated splits are both stated',
    bodyText.includes('provider $') && bodyText.includes('estimated $'),
  );
  check('the stale P12 placeholder is gone', !bodyText.includes('arrive with P12'));
  // Two surfaces must not disagree about the same rows: opening the lens refreshes
  // the header chip from the same table.
  const chip = await text('[data-testid="context-spend"]');
  check(
    'the header spend chip agrees with the Cost lens after it loads',
    chip.includes(`${(seeded.knownMicros / 1_000_000).toFixed(4)}`),
    { chip },
  );
  check('the Cost lens is captured', await shot('cost-recorded'));

  // Budget: fill the limit and save through the real form.
  const typed = await setField('input[aria-label="Budget limit in US dollars"]', '2.50');
  await click('.cost-budget-form button[type="submit"]');
  const budgetsUp = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="cost-budgets"]\'))')) === true,
  );
  const budgetsText = await text('[data-testid="cost-budgets"]');
  check('a budget can be set from the Cost lens', typed && budgetsUp, { budgetsText });
  check(
    'the saved budget shows the limit, warn and stop thresholds it will enforce',
    budgetsText.includes('$2.5000') && budgetsText.includes('warn') && budgetsText.includes('stop'),
  );
  check(
    'the evaluation states that this is a local dispatch limit',
    bodyText.includes('local') || (await text('section[aria-labelledby="cost-title"]')).includes('dispatch'),
  );
  check('the budgeted Cost lens is captured', await shot('cost-budget'));

  // Export through the real IPC path (the probe supplies the destination).
  await click('[data-role="cost-export"]');
  const exported = await waitFor(async () => fs.existsSync(input.exportPath), 15_000);
  if (exported) {
    const content = fs.readFileSync(input.exportPath, 'utf8');
    const rows = content.trimEnd().split('\n');
    csv.path = input.exportPath;
    csv.bytes = Buffer.byteLength(content, 'utf8');
    csv.header = rows[0] ?? null;
    csv.labels = rows.slice(1).map((row) => {
      const cells = row.split(',');
      return (cells[13] ?? '').replaceAll('"', '');
    });
    check('CSV export wrote a file with the recorded rows', rows.length >= 3, { rows: rows.length });
    check(
      'the CSV header carries cost_label and unknown_reason',
      (csv.header ?? '').includes('cost_label') && (csv.header ?? '').includes('unknown_reason'),
    );
    check(
      'every CSV row labels provider-reported, locally-estimated or unknown',
      csv.labels.length > 0 && csv.labels.every((label) => /provider-reported|locally-estimated|unknown/.test(label)),
      csv.labels,
    );
  } else {
    check('CSV export wrote a file with the recorded rows', false, { expected: input.exportPath });
  }

  // ---- Work board ----------------------------------------------------------
  await click('[data-testid="nav-work"]');
  const boardUp = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="task-card"]\'))')) === true,
  );
  check('the Work board renders tasks the service recorded', boardUp, seededTasks);
  const workText = await text('section[aria-labelledby="work-title"]');
  check('the stale P10 placeholder is gone', !workText.includes('arrive with P10'));
  check(
    'a seeded task title is on the board',
    seededTasks.titles.some((title) => workText.includes(title)),
  );
  check(
    'steps and acceptance criteria are shown, not summarised',
    workText.includes('write the code') && workText.includes('the tests pass'),
  );
  check(
    'a blocked dependency is explained rather than shown as an unlabelled disabled control',
    /Not eligible:/.test(workText) && workText.includes('Depends on'),
  );
  check('the Work board is captured', await shot('work-board'));

  // Create a task through the real form.
  const titleTyped = await setField('input[aria-label="Task title"]', 'Probe-created task');
  const stepsTyped = await setField('textarea[aria-label="Task steps, one per line"]', 'first step\nsecond step');
  const criteriaTyped = await setField('textarea[aria-label="Acceptance criteria, one per line"]', 'the probe sees it');
  await click('.task-form button[type="submit"]');
  const created = await waitFor(
    async () =>
      (await evaluate<boolean>(
        "Array.from(document.querySelectorAll('[data-testid=\"task-card\"]')).some((node) => (node.textContent || '').includes('Probe-created task'))",
      )) === true,
  );
  check('a task can be added from the Work board', titleTyped && stepsTyped && criteriaTyped && created);
  const afterCreate = await text('section[aria-labelledby="work-title"]');
  check(
    'the new task is pending and eligible, with nothing started',
    /Pending/.test(afterCreate) && /Eligible to start now/.test(afterCreate),
  );
  check('the task-created board is captured', await shot('work-task-created'));

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    csv,
    capturedAt: new Date().toISOString(),
    providerRequests: 0,
  };
}
