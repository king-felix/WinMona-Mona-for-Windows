import type { errorResult } from '@mona/contracts';
import type { ProjectStore } from '@mona/project-state';
import type { UiStateView } from '../shared/catalog.js';
import type {
  CommandDispatchInput,
  CommandReceipt,
  CommandRefusalCode,
  MonaCommandOperation,
} from '../shared/commands.js';
import { interpretCommandInput } from '../shared/slash.js';
import { SLASH_CATALOG } from '../shared/slash-catalog.js';

/**
 * The one place a slash command becomes an action.
 *
 * The renderer sends the command text and an operation key; the main process
 * re-parses the text against the shipped catalog, checks that the catalog says
 * Mona owns the route, validates the arguments for that specific operation, and
 * only then touches local state. There is no shell in this path, no model call,
 * and no way to make a terminal-only command appear to have run.
 *
 * A refused command is a completed validation, not an IPC failure: it returns a
 * receipt with `status: 'refused'` and the reason, so the renderer can show it.
 */
export type CommandServiceDeps = {
  store: ProjectStore;
  /** Registers a session id minted by the durable rotation and makes it current. */
  ensureSession: (projectId: string, sessionId: string) => UiStateView;
  /** A turn in flight for exactly this project session, if any. */
  sessionBusy: (projectId: string, sessionId: string) => { turnId: string | null; state: string } | null;
  now?: () => Date;
};

/**
 * The operations Mona implements. A row may only claim `route: 'mona'` in the
 * catalog when its name appears here; a mismatch is refused rather than guessed.
 */
const OPERATIONS: Record<string, MonaCommandOperation> = {
  new: 'new-conversation',
  help: 'show-catalog',
};

const MAX_TEXT = 1_000;
const MAX_OPERATION_KEY = 120;

type Result = { ok: true; data: CommandReceipt } | { ok: false; error: ReturnType<typeof errorResult> };

export class CommandService {
  private readonly store: ProjectStore;
  private readonly ensureSession: CommandServiceDeps['ensureSession'];
  private readonly sessionBusy: CommandServiceDeps['sessionBusy'];
  private readonly now: () => Date;

  constructor(deps: CommandServiceDeps) {
    this.store = deps.store;
    this.ensureSession = deps.ensureSession;
    this.sessionBusy = deps.sessionBusy;
    this.now = deps.now ?? (() => new Date());
  }

  async dispatch(input: CommandDispatchInput): Promise<Result> {
    const text = typeof input.text === 'string' ? input.text : '';
    const operationKey = typeof input.operationKey === 'string' ? input.operationKey.trim() : '';
    if (!text.trim()) return this.refused(input, 'invalid_request', 'There is no command to dispatch.', {});
    if (text.length > MAX_TEXT) {
      return this.refused(input, 'invalid_request', 'A command line is at most 1 000 characters.', {});
    }
    if (
      operationKey.length < 8 ||
      operationKey.length > MAX_OPERATION_KEY ||
      !/^[A-Za-z0-9_.:-]+$/.test(operationKey)
    ) {
      return this.refused(input, 'invalid_request', 'The dispatch needs a plain operation key.', {});
    }

    const project = await this.store.getProject(input.projectId);
    if (!project) return this.refused(input, 'not_found', 'That project is not in the catalog.', {});

    const intent = interpretCommandInput(text, SLASH_CATALOG);
    if (intent.kind === 'ambiguous') {
      return this.refused(
        input,
        'unknown_command',
        `“/${intent.token}” is not a command. It could be: ${intent.candidates.map((name) => `/${name}`).join(', ')}.`,
        { command: intent.token },
      );
    }
    if (intent.kind === 'literal') {
      return this.refused(
        input,
        'unknown_command',
        'This line is not a command; ordinary text goes through Submit.',
        {},
      );
    }

    const row = intent.row;
    if (row.route !== 'mona') {
      return this.refused(input, 'not_routed', `/${row.name} is not something Mona runs. ${row.routeNote}`, {
        command: row.name,
        via: intent.via,
        operation: null,
      });
    }
    const operation = OPERATIONS[row.name];
    if (!operation) {
      // The catalog claims a Mona route that this build cannot perform. Refuse
      // loudly instead of pretending the command ran.
      return this.refused(
        input,
        'not_routed',
        `Mona's catalog marks /${row.name} as a Mona route, but this build has no operation for it. Nothing was run.`,
        { command: row.name, via: intent.via, operation: null },
      );
    }
    const argument = intent.argument.trim();
    if (argument) {
      return this.refused(input, 'unexpected_argument', `/${row.name} takes no arguments in Mona. Nothing was run.`, {
        command: row.name,
        via: intent.via,
        operation,
      });
    }
    if (intent.argumentMissing) {
      return this.refused(input, 'missing_argument', `/${row.name} needs an argument: ${row.usage}`, {
        command: row.name,
        via: intent.via,
        operation,
      });
    }

    if (operation === 'show-catalog') {
      return this.done(input, {
        command: row.name,
        via: intent.via,
        operation,
        detail: `Opened Mona's command catalog: ${SLASH_CATALOG.length} commands captured from the installed engine.`,
      });
    }

    const busy = this.sessionBusy(input.projectId, input.sessionId);
    if (busy) {
      return this.refused(
        input,
        'busy',
        `A turn is ${busy.state.replaceAll('_', ' ')} in this session${
          busy.turnId ? ` (${busy.turnId})` : ''
        }. Interrupt it or wait for it to finish, then start a new conversation. Nothing was changed.`,
        { command: row.name, via: intent.via, operation },
      );
    }
    const rotation = await this.store.rotateSession({
      projectId: input.projectId,
      oldSessionId: input.sessionId,
      operationKey,
      source: `command:/${row.name}`,
    });
    if (!rotation) return this.refused(input, 'not_found', 'That project is not in the catalog.', {});

    let ui: UiStateView | null;
    try {
      ui = this.ensureSession(input.projectId, rotation.newSessionId);
    } catch {
      // The rotation is durable; the UI state picks the session up next time.
      ui = null;
    }
    return this.done(input, {
      command: row.name,
      via: intent.via,
      operation,
      detail: rotation.replayed
        ? 'This new conversation was already created for this dispatch; the same session is reused.'
        : 'Started a new conversation. The previous session keeps its history, draft and usage; no engine thread exists until the new conversation sends work.',
      oldSessionId: rotation.oldSessionId,
      newSessionId: rotation.newSessionId,
      threadCreated: false,
      replayed: rotation.replayed === true,
      ui,
    });
  }

  private done(
    input: CommandDispatchInput,
    values: {
      command: string;
      via: 'name' | 'alias';
      operation: MonaCommandOperation;
      detail: string;
      oldSessionId?: string | null;
      newSessionId?: string | null;
      threadCreated?: boolean;
      replayed?: boolean;
      ui?: UiStateView | null;
    },
  ): Result {
    return {
      ok: true,
      data: {
        projectId: input.projectId,
        command: values.command,
        via: values.via,
        status: 'done',
        code: 'ok',
        detail: values.detail,
        at: this.now().toISOString(),
        operation: values.operation,
        oldSessionId: values.oldSessionId ?? null,
        newSessionId: values.newSessionId ?? null,
        threadCreated: values.threadCreated ?? false,
        providerRequest: false,
        replayed: values.replayed ?? false,
        ui: values.ui ?? null,
      },
    };
  }

  private refused(
    input: CommandDispatchInput,
    code: CommandRefusalCode,
    detail: string,
    extra: { command?: string; via?: 'name' | 'alias' | null; operation?: MonaCommandOperation | null },
  ): Result {
    return {
      ok: true,
      data: {
        projectId: input.projectId,
        command: extra.command ?? '',
        via: extra.via ?? 'name',
        status: 'refused',
        code,
        detail,
        at: this.now().toISOString(),
        operation: extra.operation ?? null,
        oldSessionId: null,
        newSessionId: null,
        threadCreated: false,
        providerRequest: false,
        replayed: false,
        ui: null,
      },
    };
  }
}
