import { errorResult } from '@mona/contracts';
import type { ProjectStore } from '@mona/project-state';
import type { TerminalRefresh, TerminalSessionView } from '../shared/terminal.js';
import type { TerminalHost } from './terminal-host.js';

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

/**
 * Binds terminal sessions to a catalog project. The renderer names a project,
 * never a working directory; Mona resolves the folder itself so a terminal can
 * only start inside a project the user already opened.
 */
export class TerminalService {
  private readonly store: ProjectStore;
  private readonly host: TerminalHost;

  constructor(deps: { store: ProjectStore; host: TerminalHost }) {
    this.store = deps.store;
    this.host = deps.host;
  }

  availability(): { available: boolean; detail: string } {
    return this.host.availability();
  }

  closeAll(): void {
    this.host.closeAll();
  }

  async create(input: { projectId: string; cols: number; rows: number }): Promise<ServiceResult<TerminalSessionView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    return this.host.create({
      projectId: project.id,
      cwd: project.canonicalPath,
      cols: input.cols,
      rows: input.rows,
    });
  }

  async input(input: {
    projectId: string;
    sessionId: string;
    data: string;
  }): Promise<ServiceResult<{ accepted: number }>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    return this.host.input(input);
  }

  async resize(input: {
    projectId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): Promise<ServiceResult<TerminalSessionView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    return this.host.resize(input);
  }

  async kill(input: { projectId: string; sessionId: string }): Promise<ServiceResult<TerminalSessionView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    return this.host.kill(input);
  }

  async refresh(input: { projectId: string; sessionId: string }): Promise<ServiceResult<TerminalRefresh>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    return this.host.refresh(input);
  }
}
