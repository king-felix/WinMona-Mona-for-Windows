import { errorResult } from '@mona/contracts';
import type { CostLedger } from '@mona/project-state';
import { z } from 'zod';
import type { IpcResult } from '../shared/catalog.js';
import { COST_CHANNELS, type CostLensView } from '../shared/cost.js';
import type { IpcHandle } from './ipc.js';
import { toCostLensView } from './cost-view.js';

const ProjectRequest = z.object({ projectId: z.string().min(1).max(80) }).strict();
const LensRequest = z
  .object({ projectId: z.string().min(1).max(80), sessionId: z.string().min(1).max(80).nullish() })
  .strict();
const BudgetRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    scope: z.enum(['session', 'project', 'day']),
    sessionId: z.string().min(1).max(80).nullish(),
    /** Whole micro-USD. The renderer formats dollars; it never sends a float. */
    limitMicros: z.number().int().min(1).max(1_000_000_000_000),
    warnMicros: z.number().int().min(0).max(1_000_000_000_000).nullish(),
    stopMicros: z.number().int().min(0).max(1_000_000_000_000).nullish(),
  })
  .strict();

export type CostSaveResult = { saved: boolean; path: string | null; note: string };

/** A validation failure from the ledger is the user's to fix, so say what it was. */
function describe(error: unknown): { code: 'invalid_request' | 'not_found' | 'internal'; message: string } {
  const candidate = error as { name?: string; code?: string; message?: string } | null;
  if (candidate?.name === 'StateError' && typeof candidate.message === 'string') {
    const code =
      candidate.code === 'not_found' ? 'not_found' : candidate.code === 'internal' ? 'internal' : 'invalid_request';
    return { code, message: candidate.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'The cost request failed.' };
}

/**
 * Cost lens, budgets and export. Reading is free and local; setting a budget
 * writes one row; exporting writes a file the person chooses. None of it starts
 * an engine or a turn, so idle cost observation makes no provider request.
 */
export function registerCostIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  ledger: () => CostLedger | null;
  /** Presents a save dialog and writes the CSV; return what really happened. */
  saveCsv: (input: { projectId: string; content: string }) => Promise<CostSaveResult>;
}): string[] {
  const channels: string[] = [];
  const guard = (event: unknown): IpcResult<never> | null =>
    deps.isTrustedSender(event)
      ? null
      : { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };

  const lensFor = async (ledger: CostLedger, projectId: string, sessionId: string | null): Promise<CostLensView> => {
    const [lens, budgets, evaluation] = await Promise.all([
      ledger.lens(projectId),
      ledger.listBudgets(projectId),
      ledger.evaluateBudget({ projectId, sessionId }),
    ]);
    return toCostLensView({ lens, budgets, evaluation });
  };

  deps.handle(COST_CHANNELS.lens, async (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = LensRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'cost-lens received an invalid request.') };
    }
    const ledger = deps.ledger();
    if (!ledger) {
      return {
        ok: false,
        error: errorResult('internal', 'Local project state is unavailable. See Diagnostics.', true),
      };
    }
    try {
      return { ok: true, data: await lensFor(ledger, parsed.data.projectId, parsed.data.sessionId ?? null) };
    } catch (error) {
      const problem = describe(error);
      return { ok: false, error: errorResult(problem.code, problem.message) };
    }
  });
  channels.push(COST_CHANNELS.lens);

  deps.handle(COST_CHANNELS.setBudget, async (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = BudgetRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'cost-budget-set received an invalid request.') };
    }
    const ledger = deps.ledger();
    if (!ledger) {
      return {
        ok: false,
        error: errorResult('internal', 'Local project state is unavailable. See Diagnostics.', true),
      };
    }
    try {
      const input = parsed.data;
      await ledger.setBudget({
        projectId: input.projectId,
        scope: input.scope,
        sessionId: input.sessionId ?? null,
        limitMicros: input.limitMicros,
        warnMicros: input.warnMicros ?? null,
        stopMicros: input.stopMicros ?? null,
      });
      return { ok: true, data: await lensFor(ledger, input.projectId, input.sessionId ?? null) };
    } catch (error) {
      const problem = describe(error);
      return { ok: false, error: errorResult(problem.code, problem.message) };
    }
  });
  channels.push(COST_CHANNELS.setBudget);

  deps.handle(COST_CHANNELS.exportCsv, async (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = ProjectRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'cost-export received an invalid request.') };
    }
    const ledger = deps.ledger();
    if (!ledger) {
      return {
        ok: false,
        error: errorResult('internal', 'Local project state is unavailable. See Diagnostics.', true),
      };
    }
    try {
      const content = await ledger.exportCsv(parsed.data.projectId);
      const rows = Math.max(0, content.trimEnd().split('\n').length - 1);
      const receipt = await deps.saveCsv({ projectId: parsed.data.projectId, content });
      return {
        ok: true,
        data: {
          saved: receipt.saved,
          path: receipt.path,
          bytes: receipt.saved ? Buffer.byteLength(content, 'utf8') : 0,
          rows: receipt.saved ? rows : 0,
          note: receipt.note,
        },
      };
    } catch (error) {
      const problem = describe(error);
      return { ok: false, error: errorResult(problem.code, problem.message) };
    }
  });
  channels.push(COST_CHANNELS.exportCsv);

  return channels;
}
