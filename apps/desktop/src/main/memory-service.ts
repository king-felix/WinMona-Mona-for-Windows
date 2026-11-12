import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { errorResult, type ErrorResult } from '@mona/contracts';
import {
  MemoryIndex,
  StateError,
  backupSettings,
  buildDiagnosticPreview,
  buildPromptPack,
  exportDiagnosticBundle,
  exportPortable,
  importPortable,
  parsePromptPack,
  renderPrompt,
  restoreSettings,
  type DiagnosticPreview,
  type DiagnosticsEngineInfo,
  type ProjectStore,
} from '@mona/project-state';
import type { PromptFavorite, UiStateView } from '../shared/catalog.js';
import type {
  DiagnosticPreviewView,
  MemoryReindexView,
  MemorySearchMode,
  MemorySearchView,
  PortableExportKind,
  PortableExportView,
  PortableImportKind,
  PortableImportView,
  PromptDraftInput,
  PromptExportView,
  PromptImportView,
  PromptPreviewView,
} from '../shared/memory.js';
import type { UiStateStore } from './ui-state.js';

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ErrorResult };
type ServiceResult<T> = Success<T> | Failure;

export type MemoryAppFacts = {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
};

export type MemoryDialogs = {
  saveFile(input: { title: string; defaultName: string; extensions: string[] }): Promise<string | null>;
  openFile(input: { title: string; extensions: string[] }): Promise<string | null>;
  chooseFolder(input: { title: string }): Promise<string | null>;
};

export type MemoryServiceDeps = {
  store: ProjectStore;
  ui: UiStateStore;
  artifactRoot: string;
  app: () => MemoryAppFacts;
  engine: () => DiagnosticsEngineInfo;
  dialogs: MemoryDialogs;
  now?: () => Date;
};

const JSON_FILTER = ['json'];
const TEXT_FILTER = ['txt', 'log'];

/**
 * Orchestrates project memory for the desktop: local search, the prompt shelf,
 * portable handoff/resume bundles, settings backup/restore and the diagnostic
 * preview. File paths always come from a native dialog chosen by the human, not
 * from renderer-provided strings.
 */
export class MemoryService {
  private readonly store: ProjectStore;
  private readonly ui: UiStateStore;
  private readonly artifactRoot: string;
  private readonly app: () => MemoryAppFacts;
  private readonly engine: () => DiagnosticsEngineInfo;
  private readonly dialogs: MemoryDialogs;
  private readonly now: () => Date;
  private readonly index: MemoryIndex;

  constructor(deps: MemoryServiceDeps) {
    this.store = deps.store;
    this.ui = deps.ui;
    this.artifactRoot = deps.artifactRoot;
    this.app = deps.app;
    this.engine = deps.engine;
    this.dialogs = deps.dialogs;
    this.now = deps.now ?? (() => new Date());
    this.index = new MemoryIndex(deps.store);
  }

  async search(input: {
    projectId: string;
    query: string;
    mode: MemorySearchMode;
    limit?: number;
  }): Promise<ServiceResult<MemorySearchView>> {
    return await this.attempt(async () => {
      await this.requireProject(input.projectId);
      if (input.mode === 'files') {
        const result = await this.index.searchFiles(input.projectId, input.query, {
          ...(input.limit ? { maxResults: input.limit } : {}),
        });
        return {
          mode: 'files' as const,
          query: result.query,
          indexed: true,
          terms: [],
          documents: 0,
          hits: result.hits.map((hit) => ({
            docId: `${hit.path}:${hit.line}`,
            kind: 'file' as const,
            refId: `${hit.path}:${hit.line}`,
            title: hit.path,
            snippet: hit.snippet,
            score: 1,
            retention: 'ephemeral' as const,
            redacted: false,
            indexedAt: this.now().toISOString(),
          })),
          truncated: result.truncated,
          scannedFiles: result.scannedFiles,
          scannedBytes: result.scannedBytes,
          skipped: result.skipped,
        };
      }
      const result = await this.index.search(input.projectId, input.query, {
        ...(input.limit ? { limit: input.limit } : {}),
      });
      return {
        mode: 'history' as const,
        query: result.query,
        indexed: result.indexed,
        terms: result.terms,
        documents: result.documents,
        hits: result.hits,
        truncated: result.truncated,
        scannedFiles: 0,
        scannedBytes: 0,
        skipped: { secretPath: 0, binary: 0, oversize: 0 },
      };
    });
  }

  async reindex(projectId: string): Promise<ServiceResult<MemoryReindexView>> {
    return await this.attempt(async () => {
      await this.requireProject(projectId);
      const report = await this.index.reindexProject(projectId);
      return {
        documents: report.documents,
        terms: report.terms,
        redacted: report.redacted,
        timelineIncluded: report.timelineIncluded,
        byKind: report.byKind,
        indexedAt: report.indexedAt,
      };
    });
  }

  promptSave(input: PromptDraftInput): ServiceResult<UiStateView> {
    try {
      const view = this.ui.savePrompt(input.projectId, {
        ...(input.id ? { id: input.id } : {}),
        label: input.label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        template: input.template,
        ...(input.variables ? { variables: input.variables } : {}),
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
      });
      return { ok: true, data: view };
    } catch (error) {
      return { ok: false, error: mapFailure(error) };
    }
  }

  promptRemove(input: { projectId: string; promptId: string }): ServiceResult<UiStateView> {
    return { ok: true, data: this.ui.removePrompt(input.projectId, input.promptId) };
  }

  promptPreview(input: {
    projectId: string;
    promptId: string;
    values: Record<string, string>;
  }): ServiceResult<PromptPreviewView> {
    const prompt = this.findPrompt(input.projectId, input.promptId);
    if (!prompt) return { ok: false, error: errorResult('not_found', 'That prompt is not on this project’s shelf.') };
    const preview = renderPrompt(prompt, input.values);
    return {
      ok: true,
      data: {
        promptId: prompt.id,
        label: prompt.label,
        version: prompt.version,
        text: preview.text,
        sha256: preview.sha256,
        characters: preview.characters,
        missing: preview.missing,
        undeclared: preview.undeclared,
        unused: preview.unused,
        unknownValues: preview.unknownValues,
        malformed: preview.malformed,
        acceptance: preview.acceptance,
        ready: preview.ready,
        notes: preview.notes,
      },
    };
  }

  async promptImport(projectId: string): Promise<ServiceResult<PromptImportView>> {
    return await this.attempt(async () => {
      await this.requireProject(projectId);
      const file = await this.dialogs.openFile({ title: 'Import a Mona prompt pack', extensions: JSON_FILTER });
      if (!file) throw new Reply('Prompt import cancelled.');
      if (!existsSync(file)) throw new Reply('The selected prompt pack no longer exists.');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const { pack, entries } = parsePromptPack(raw);
      const result = this.ui.importPrompts(projectId, entries);
      return {
        imported: result.imported,
        labels: result.labels,
        digest: pack.digest,
        exportedAt: pack.exported_at,
        executed: false as const,
      };
    });
  }

  async promptExport(projectId: string): Promise<ServiceResult<PromptExportView>> {
    return await this.attempt(async () => {
      const project = await this.requireProject(projectId);
      const prompts = this.ui.view().projects[projectId]?.favorites ?? [];
      if (prompts.length === 0) throw new Reply('This project has no prompts to export.');
      const file = await this.dialogs.saveFile({
        title: 'Export the prompt shelf',
        defaultName: `${slug(project.label)}-prompts.json`,
        extensions: JSON_FILTER,
      });
      if (!file) throw new Reply('Prompt export cancelled.');
      const pack = buildPromptPack(prompts, this.now().toISOString());
      const serialized = `${JSON.stringify(pack, null, 2)}\n`;
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(temporary, serialized, 'utf8');
      renameSync(temporary, file);
      return {
        file,
        count: prompts.length,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        digest: pack.digest,
      };
    });
  }

  async portableExport(input: {
    projectId: string;
    kind: PortableExportKind;
    includeFiles?: string[];
  }): Promise<ServiceResult<PortableExportView>> {
    return await this.attempt(async () => {
      if (input.kind !== 'diagnostics' && input.kind !== 'settings') {
        const project = await this.requireProject(input.projectId);
        const file = await this.dialogs.saveFile({
          title: input.kind === 'handoff' ? 'Export a portable handoff' : 'Export a resume packet',
          defaultName: `${slug(project.label)}-${input.kind === 'handoff' ? 'handoff' : 'resume'}.json`,
          extensions: JSON_FILTER,
        });
        if (!file) throw new Reply('Export cancelled.');
        const document = await exportPortable(this.store, input.projectId, {
          file,
          kind: input.kind === 'handoff' ? 'mona.handoff' : 'mona.resume-packet',
          ...(input.includeFiles ? { includeFiles: input.includeFiles } : {}),
          now: this.now(),
        });
        return {
          kind: input.kind,
          file,
          bytes: statSync(file).size,
          digest: document.digest,
          detail: `${document.tasks.length} tasks, ${document.decisions.length} decisions, ${document.files.length} selected files.`,
          includedFiles: document.files.map((entry) => entry.path),
          notTransferred: document.notTransferred,
        };
      }
      if (input.kind === 'settings') {
        const file = await this.dialogs.saveFile({
          title: 'Back up Mona settings',
          defaultName: `mona-settings-${stamp(this.now())}.json`,
          extensions: JSON_FILTER,
        });
        if (!file) throw new Reply('Settings backup cancelled.');
        const receipt = await backupSettings(this.store, { file, now: this.now });
        return {
          kind: 'settings' as const,
          file,
          bytes: receipt.bytes,
          digest: receipt.sha256,
          detail: `${receipt.scopes.length} settings scope(s); ${receipt.redactedPaths.length} redacted value(s).`,
          includedFiles: [],
          notTransferred: ['Provider credentials are never included; credential-shaped values are redacted.'],
        };
      }
      const preview = await this.buildPreview(false);
      const file = await this.dialogs.saveFile({
        title: 'Export a diagnostic bundle',
        defaultName: `mona-diagnostics-${stamp(this.now())}.txt`,
        extensions: TEXT_FILTER,
      });
      if (!file) throw new Reply('Diagnostic export cancelled.');
      const receipt = exportDiagnosticBundle(preview, file);
      return {
        kind: 'diagnostics' as const,
        file,
        bytes: receipt.bytes,
        digest: receipt.sha256,
        detail: `${preview.artifacts.records} artifact record(s), ${preview.artifacts.missing.length} missing, ${preview.redaction.redactions} redaction(s).`,
        includedFiles: [],
        notTransferred: ['No environment dump, full source, provider key or runtime token is included.'],
      };
    });
  }

  async portableImport(input: {
    kind: PortableImportKind;
    replaceExisting?: boolean;
  }): Promise<ServiceResult<PortableImportView>> {
    return await this.attempt(async () => {
      const file = await this.dialogs.openFile({
        title: input.kind === 'settings' ? 'Restore Mona settings from a backup' : 'Import a Mona portable bundle',
        extensions: JSON_FILTER,
      });
      if (!file) throw new Reply('Import cancelled.');
      if (input.kind === 'settings') {
        const receipt = await restoreSettings(this.store, { file, now: this.now });
        return {
          kind: 'settings' as const,
          file,
          projectId: null,
          projectLabel: null,
          targetFolder: null,
          tasksImported: 0,
          decisionsImported: 0,
          evidenceChecked: 0,
          missingFiles: [],
          staleEvidence: [],
          reopenedTasks: [],
          restoredScopes: receipt.restoredScopes,
          requalified: false,
          autoExecuted: false as const,
          notTransferred: [],
        };
      }
      const folder = await this.dialogs.chooseFolder({
        title: 'Choose the folder this project lives in on this machine',
      });
      if (!folder) throw new Reply('Import cancelled before choosing a folder.');
      const report = await importPortable(this.store, file, {
        targetFolder: folder,
        ...(input.replaceExisting === true ? { replaceExisting: true } : {}),
      });
      return {
        kind: report.kind,
        file,
        projectId: report.projectId,
        projectLabel: report.projectLabel,
        targetFolder: report.targetFolder,
        tasksImported: report.tasksImported,
        decisionsImported: report.decisionsImported,
        evidenceChecked: report.evidenceChecked,
        missingFiles: report.missingFiles,
        staleEvidence: report.staleEvidence,
        reopenedTasks: report.reopenedTasks,
        restoredScopes: [],
        requalified: report.requalified,
        autoExecuted: false as const,
        notTransferred: report.notTransferred,
      };
    });
  }

  async diagnosticsPreview(input: { verifyArtifacts?: boolean } = {}): Promise<ServiceResult<DiagnosticPreviewView>> {
    return await this.attempt(async () => {
      const preview = await this.buildPreview(input.verifyArtifacts === true);
      return toPreviewView(preview);
    });
  }

  private async buildPreview(verifyArtifacts: boolean): Promise<DiagnosticPreview> {
    return await buildDiagnosticPreview({
      store: this.store,
      app: this.app(),
      engine: this.engine(),
      artifactRoot: this.artifactRoot,
      verifyArtifacts,
      now: this.now(),
    });
  }

  private findPrompt(projectId: string, promptId: string): PromptFavorite | null {
    return this.ui.view().projects[projectId]?.favorites.find((prompt) => prompt.id === promptId) ?? null;
  }

  private async requireProject(projectId: string) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new StateError('not_found', 'That project is not in the local catalog.');
    return project;
  }

  private async attempt<T>(fn: () => Promise<T> | T): Promise<ServiceResult<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (error) {
      return { ok: false, error: mapFailure(error) };
    }
  }
}

/** A user-actionable refusal that is not a crash, for example a cancelled dialog. */
class Reply extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Reply';
  }
}

function toPreviewView(preview: DiagnosticPreview): DiagnosticPreviewView {
  return {
    generatedAt: preview.generatedAt,
    redacted: true,
    text: preview.text,
    bytes: preview.bytes,
    sha256: preview.sha256,
    sections: preview.sections,
    redaction: preview.redaction,
    artifacts: preview.artifacts,
  };
}

function mapFailure(error: unknown): ErrorResult {
  if (error instanceof Reply) return errorResult('invalid_request', error.message);
  if (error instanceof StateError) {
    switch (error.code) {
      case 'not_found':
        return errorResult('not_found', bound(error.message));
      case 'invalid_request':
      case 'relocation_required':
      case 'alias_conflict':
        return errorResult('invalid_request', bound(error.message));
      case 'digest_mismatch':
        return errorResult(
          'invalid_request',
          bound(error.message),
          false,
          'The file may have been edited after export.',
        );
      case 'conflict':
        return errorResult('conflict', bound(error.message));
      case 'maintenance':
        return errorResult('conflict', bound(error.message), true);
      case 'criteria_unsatisfied':
        return errorResult('invalid_request', bound(error.message));
      case 'oversize':
        return errorResult('invalid_request', bound(error.message));
      case 'disk_full':
        return errorResult('internal', 'The local disk is full; nothing partial was kept.', true);
      case 'corrupt_state':
        return errorResult('internal', bound(error.message));
      default:
        return errorResult('internal', bound(error.message), true);
    }
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM')
    return errorResult('permission_denied', 'Windows denied access to that file.');
  if (code === 'ENOENT') return errorResult('not_found', 'That file no longer exists.');
  return errorResult('internal', 'The memory action failed unexpectedly.', true, String(error).slice(0, 500));
}

function bound(message: string): string {
  return message.length > 500 ? `${message.slice(0, 497)}…` : message;
}

function slug(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'project';
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}
