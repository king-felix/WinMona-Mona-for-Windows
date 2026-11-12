#!/usr/bin/env node
// Bootstrap-only seeder for docs/requirements.json.
//
// The ledger is the durable, hand-maintained traceability artifact. This script
// exists to create it once (P00) from the prompt map in Mona_PROMPTS.md section 3
// and the requirement catalog in Mona_Project.md section 7, without transcription
// errors. Re-running requires --force and preserves the previous file as a backup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2);
const optValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = path.resolve(optValue('--root') ?? DEFAULT_ROOT);
const force = args.includes('--force');

const prompts = [
  ['P00', 'Bootstrap the project and establish ground truth', 'Bootstrap, inventory, durable build ledger', [], ['MONA-001', 'MONA-010']],
  ['P01', 'Prove headless integration and preserve the economics', 'Integration, cost, and coverage gates', ['P00'], ['MONA-001', 'MONA-002', 'MONA-003', 'MONA-030']],
  ['P02', 'Create the desktop foundation and strict contracts', 'Desktop repository and contracts', ['P01'], ['MONA-006', 'MONA-026']],
  ['P03', 'Implement the real versioned engine adapter', 'Real engine adapter', ['P02'], ['MONA-001', 'MONA-002', 'MONA-007', 'MONA-008', 'MONA-016']],
  ['P04', 'Own runtime processes and stopping behavior correctly', 'Runtime/process supervisor', ['P03'], ['MONA-002', 'MONA-012', 'MONA-016']],
  ['P05', 'Build transactional project state and safe migrations', 'Transactional state and migration', ['P02'], ['MONA-005', 'MONA-010', 'MONA-016', 'MONA-025']],
  ['P06', "Build Mona's distinctive design system", 'Design system and accessible screens', ['P02'], ['MONA-006', 'MONA-029']],
  ['P07', 'Assemble the project catalog and desktop shell', 'Project catalog and shell', ['P04', 'P05', 'P06'], ['MONA-005', 'MONA-006', 'MONA-029']],
  ['P08', 'Deliver the live work studio', 'Live work studio', ['P03', 'P07'], ['MONA-007', 'MONA-008', 'MONA-012', 'MONA-014']],
  ['P09', 'Make the first right-click launch work', 'Early folder launch', ['P07', 'P08'], ['MONA-004']],
  ['P10', 'Implement prompt execution and durable continuation', 'Prompt work board and continuity', ['P05', 'P08'], ['MONA-009', 'MONA-010', 'MONA-024']],
  ['P11', 'Enforce the three-attempt rule and clear stop controls', 'Attempt ledger and execution boundaries', ['P04', 'P10'], ['MONA-011', 'MONA-012']],
  ['P12', 'Build the cost ledger and optional budget controls', 'Cost ledger and budgets', ['P03', 'P05', 'P08'], ['MONA-003', 'MONA-013']],
  ['P13', 'Make changes, evidence, Git, and restore trustworthy', 'Changes, Git, tests and restore', ['P08', 'P05'], ['MONA-014', 'MONA-015']],
  ['P14', 'Deliver the daily-use polish without inference overhead', 'Resume Brief, tray and focus', ['P10', 'P11', 'P12', 'P13'], ['MONA-017', 'MONA-029']],
  ['P15', 'Surface native agents, goals, fleets, and workflows', 'Agent observatory and native workflows', ['P11', 'P12', 'P13'], ['MONA-018', 'MONA-019']],
  ['P16', 'Expose providers, models, permissions, and effective settings', 'Provider/model/configuration workbench', ['P08', 'P12'], ['MONA-008', 'MONA-020']],
  ['P17', 'Make tools and extensions manageable', 'MCP, skills, plugins and hooks', ['P16'], ['MONA-021']],
  ['P18', 'Complete advanced access and the capability explorer', 'Terminal and complete capability explorer', ['P15', 'P17'], ['MONA-022', 'MONA-023', 'MONA-030']],
  ['P19', 'Finish project memory, portable handoff, and diagnostics', 'Memory, import/export and diagnostics', ['P10', 'P13', 'P18'], ['MONA-024', 'MONA-025']],
  ['P20', 'Harden recovery and test hostile or failing inputs', 'Recovery, security and failure testing', ['P14', 'P15', 'P16', 'P17', 'P18', 'P19'], ['MONA-016', 'MONA-025', 'MONA-026']],
  ['P21', 'Deliver the modern Windows menu and installation lifecycle', 'Modern Windows menu and installer', ['P09', 'P20'], ['MONA-004', 'MONA-027']],
  ['P22', 'Run whole-product QA and prove the remaining claims', 'Whole-product QA and economics recheck', ['P21'], ['MONA-003', 'MONA-006', 'MONA-028', 'MONA-030']],
  ['P23', 'Package the release candidate and finish the handoff', 'Release candidate and final handoff', ['P22'], null],
].map(([id, title, deliverable, prerequisites, requirements]) => ({
  id,
  title,
  deliverable,
  prerequisites,
  requirements,
}));

const allReqIds = Array.from({ length: 30 }, (_, i) => `MONA-${String(i + 1).padStart(3, '0')}`);
prompts.find((p) => p.id === 'P23').requirements = allReqIds;

// Track, title and acceptance-criteria seeds from Mona_Project.md section 7.
const requirements = [
  ['MONA-001', 'Foundation', 'Installed Codewhale identity, provenance, and capability discovery', [
    ['identity', 'Installed executable path, version, commit/tag and matching source are recorded with commands'],
    ['capabilities', 'Version-pinned CLI, API, configuration and extension inventory exists with evidence'],
    ['reproducible', 'Discovery is re-runnable on this machine and records non-secret facts only'],
  ]],
  ['MONA-002', 'Foundation', 'Tool-enabled Full Access headless execution with live events, interrupt, and resume', [
    ['tool-turn', 'One real tool-enabled task starts, streams, finishes through the installed runtime'],
    ['stream', 'Live events are observed, validated and survive unknown event types'],
    ['interrupt-resume', 'Interrupt and resume produce truthful receipts and no silent replay'],
    ['route', 'Effective provider and resolved model match the configured route'],
  ]],
  ['MONA-003', 'Foundation', 'Cost parity gate, zero idle inference, no hidden model or routing changes', [
    ['no-idle-inference', 'Idle UI, navigation, exports and reconnects cause zero provider requests'],
    ['parity', 'Paired direct/Mona cost per accepted task recorded with method and confidence'],
    ['transparency', 'Unknown usage or price is labeled unknown, never zero or invented'],
  ]],
  ['MONA-004', 'Core', 'Native folder and background launch, single-instance dispatch, safe paths, idempotent registration', [
    ['folder-launch', 'Explorer folder command opens or registers the project once'],
    ['background-launch', 'Folder-background command behaves equivalently'],
    ['single-instance', 'Second launch dispatches the path to the running owner without duplication'],
    ['safe-paths', 'Spaces, Unicode, quoting, duplicates, missing/inaccessible paths and drive roots are handled'],
    ['idempotent-registration', 'Repeated launches never duplicate a project entry'],
  ]],
  ['MONA-005', 'Core', 'Project catalog lifecycle without deleting user source', [
    ['catalog-actions', 'Create, open, rename label, archive, pin, search, relocate and reveal work'],
    ['no-source-delete', 'Removing a catalog entry never deletes project files'],
    ['relocation', 'Moved or aliased paths rebind deliberately instead of duplicating a project'],
  ]],
  ['MONA-006', 'Core', 'Accessible Daybreak/Afterglow desktop shell with density, scale and reduced motion', [
    ['daybreak', 'Daybreak theme meets measured contrast and hierarchy requirements'],
    ['afterglow', 'Afterglow theme meets the same accessibility bar'],
    ['accessibility', 'Keyboard access, visible focus, 200% scaling and screen-reader checks recorded'],
    ['density-motion', 'Density modes share one information architecture; reduced motion respected'],
  ]],
  ['MONA-007', 'Core', 'Streaming conversation, drafts, file references, copy/export, code rendering', [
    ['streaming', 'Turn output streams into the conversation without fabricated content'],
    ['drafts', 'Composer drafts survive navigation and restart'],
    ['file-references', 'File references work and are shown exactly as sent'],
    ['copy-export', 'Copy and export preserve real content'],
  ]],
  ['MONA-008', 'Core', 'Explicit Plan/Work and effective permission display without silent widening', [
    ['plan-work', 'Plan and Work modes are explicit and switchable'],
    ['permission-display', 'Effective permission posture and Full Access badge reflect the running runtime'],
    ['no-silent-widening', 'No UI action widens permissions without an explicit recorded decision'],
  ]],
  ['MONA-009', 'Core', 'Prompt work board with dependencies, acceptance criteria and deterministic eligibility', [
    ['prompt-catalog', 'Prompts are listed with dependencies and acceptance criteria'],
    ['dependencies', 'Blocked prompts cannot start before prerequisites are verified'],
    ['eligibility', 'Eligible-task selection is deterministic and explainable'],
  ]],
  ['MONA-010', 'Core', 'Durable state, handoff, decisions, requirement traceability, attempt ledger, conflict detection', [
    ['state-schema', 'Build state validates against a versioned schema'],
    ['atomic-replace', 'State writes are atomic and keep a recoverable prior copy'],
    ['conflict-detection', 'Stale revisions are refused instead of overwritten'],
    ['handoff', 'Handoff carries current prompt, verified work, next action and open issues'],
    ['traceability', 'Requirement evidence is tracked per criterion with paths and hashes'],
    ['attempt-ledger', 'Attempt history is append-only with no-progress counts preserved'],
  ]],
  ['MONA-011', 'Core', 'Three-attempt enforcement with honest visibility of engine-internal loops', [
    ['counter', 'Attempts and consecutive no-progress counts are recorded per stable problem ID'],
    ['stop-at-three', 'A third no-progress attempt blocks the problem and records required help'],
    ['persistence-across-restart', 'Attempt counts survive restart and are never silently reset'],
    ['engine-boundary', 'The enforcement boundary for engine-internal retries is stated, not overstated'],
  ]],
  ['MONA-012', 'Core', 'Pause after task, interrupt now, queue cancel, resume, stop owned descendants, truthful partial outcomes', [
    ['pause-after-task', 'Pause-after-task stops at the next queue boundary'],
    ['interrupt-now', 'Interrupt-now returns an engine receipt without claiming rollback'],
    ['queue-cancel', 'Cancelling queued work prevents future starts only'],
    ['stop-descendants', 'Owned descendants are stopped without killing unrelated processes'],
    ['truthful-partial', 'Partial or uncertain outcomes are labeled as such'],
  ]],
  ['MONA-013', 'Core', 'Cost lens with usage, cache evidence, attribution, unknowns, budgets and export', [
    ['usage-attribution', 'Usage is attributed by thread, turn and task without double counting'],
    ['cache-evidence', 'Cache hit/miss evidence is shown only when the provider reports it'],
    ['unknown-handling', 'Missing price or usage is visibly unknown'],
    ['budgets', 'Optional budgets warn before dispatch and disclose their enforcement limit'],
    ['export', 'Cost export labels provider-reported versus locally estimated figures'],
  ]],
  ['MONA-014', 'Core', 'Changes, tests, artifacts, receipts and provenance with large-output handling', [
    ['diffs', 'Diffs render from real workspace state with virtualization'],
    ['tests-evidence', 'Test runs link to their real output and exit status'],
    ['provenance', 'Every change and receipt attributes its source'],
    ['large-output', 'Large outputs are bounded or streamed without freezing the UI'],
  ]],
  ['MONA-015', 'Core', 'Git status/branch/worktree awareness, selected commits, non-Git operation, conflict-aware restore', [
    ['git-awareness', 'Branch, status and worktree state are read from the real repository'],
    ['selected-commits', 'Only explicitly selected changes are committed'],
    ['non-git', 'Projects without Git remain usable'],
    ['restore', 'Restore refuses conflicting scope and never destroys later user work'],
  ]],
  ['MONA-016', 'Core', 'Crash/reconnect recovery, duplicate event suppression, uncertain submission reconciliation', [
    ['crash-reconnect', 'Renderer/main restart reconnects and reconciles without replaying tool work'],
    ['dedupe', 'Duplicate events are suppressed by identity and cursor'],
    ['uncertain-submission', 'A lost submission is reported as unknown and reconciled, never blindly retried'],
  ]],
  ['MONA-017', 'Core', 'Deterministic activity digest, tray attention, quiet hours, notifications without inference', [
    ['deterministic-digest', 'Digest is computed locally from recorded events'],
    ['tray-attention', 'Tray state reflects running, blocked and completed work'],
    ['quiet-hours', 'Notifications respect quiet hours and deduplicate'],
    ['no-inference', 'No notification or digest path calls a model'],
  ]],
  ['MONA-018', 'Complete', 'Agent observatory with parent/child graph, ownership, lifecycle and spend boundaries', [
    ['graph', 'Parent/child relationships and task ownership are shown truthfully'],
    ['lifecycle', 'Child lifecycle states come from engine events'],
    ['spend', 'Child spend is shown when exposed and unknown otherwise'],
  ]],
  ['MONA-019', 'Complete', 'Native goals, fleets, workflows, queue/runs and artifacts without a competing scheduler', [
    ['native-features', 'Goals, fleets and workflows use verified engine features'],
    ['no-competing-scheduler', 'Only one component owns execution scheduling per task'],
    ['artifacts', 'Run artifacts and history are inspectable'],
  ]],
  ['MONA-020', 'Complete', 'Provider/model/profile selection with effective route visibility and Flash default', [
    ['route-selection', 'Route selection is explicit and scoped'],
    ['effective-visibility', 'Requested versus effective model, endpoint and reasoning are displayed'],
    ['reasoning-controls', 'Only controls supported by the selected route are offered'],
    ['flash-default', 'Victor’s working Flash route stays the default'],
  ]],
  ['MONA-021', 'Complete', 'MCP, skills, plugins, hooks, rules and instruction management with provenance', [
    ['mcp', 'MCP servers can be inspected and managed through engine mechanisms'],
    ['skills-plugins', 'Skills, plugins and hooks show scope, provenance and health'],
    ['config-safety', 'Edits never replace unknown configuration keys'],
  ]],
  ['MONA-022', 'Complete', 'Command palette and capability explorer over the entire pinned surface', [
    ['palette', 'Palette ranks projects, prompts, actions and capabilities locally'],
    ['explorer', 'Capability explorer lists every pinned-engine capability with status'],
    ['coverage', 'No supported capability lacks a documented surface or explicit gap'],
  ]],
  ['MONA-023', 'Complete', 'Integrated terminal and read-only advanced logs with isolation', [
    ['terminal', 'Terminal runs a real qualified PTY with copy, search and resize'],
    ['logs', 'Engine logs are viewable read-only with bounded memory'],
    ['isolation', 'Terminal cannot reach the renderer IPC bridge'],
  ]],
  ['MONA-024', 'Complete', 'Local project memory, context preview, prompt library and resume packet', [
    ['search', 'Project history and decisions are searchable locally'],
    ['context-preview', 'Exactly what will be sent as context is previewable'],
    ['resume-packet', 'A redacted resume packet can be exported and re-imported'],
  ]],
  ['MONA-025', 'Complete', 'Settings backup/restore, migration, retention, diagnostics bundle, offline browsing', [
    ['backup-restore', 'Backup and restore use a maintenance lock and verified journals'],
    ['migration', 'Migrations are versioned and recoverable'],
    ['diagnostics', 'Diagnostics bundles are local and redacted by default'],
    ['offline', 'Projects remain browsable when the runtime is unavailable'],
  ]],
  ['MONA-026', 'Complete', 'Secure local boundary: renderer isolation, narrow IPC, runtime auth, redaction, path and Markdown safety', [
    ['renderer-isolation', 'Renderer is sandboxed with context isolation and no Node integration'],
    ['narrow-ipc', 'Named, schema-validated IPC operations replace general exec/fs access'],
    ['runtime-auth', 'Runtime binds loopback with a token that never appears in URLs or renderer state'],
    ['redaction', 'Secrets are redacted from logs, diagnostics and exports'],
    ['content-safety', 'Markdown, links and paths are constrained against traversal and injection'],
  ]],
  ['MONA-027', 'Complete', 'Signed per-user installer workflow, modern Windows 11 menu, update compatibility, clean uninstall', [
    ['installer', 'Per-user install and uninstall with Mona-owned components only'],
    ['modern-menu', 'Windows 11 modern context menu works on the target system'],
    ['uninstall', 'Uninstall removes Mona registration and preserves projects and engine history'],
    ['signing', 'Signing/distribution prerequisites are recorded; unsigned test packages are labeled'],
  ]],
  ['MONA-028', 'Complete', 'Automated and human QA, performance budgets, feature matrix, release evidence and documentation', [
    ['automated-qa', 'Automated unit and integration suites run on the reference machine'],
    ['human-qa', 'Keyboard, screen-reader and scaling walkthroughs are recorded'],
    ['performance', 'Startup, idle CPU, memory and shutdown budgets are measured'],
    ['feature-matrix', 'Release evidence ties each supported feature to a passing check'],
  ]],
  ['MONA-029', 'Core', 'Model-free quick wins: Resume Brief, Focus Mode, evidence-linked completion cards, keyboard-first navigation', [
    ['resume-brief', 'Resume Brief is generated from state without inference'],
    ['focus-mode', 'Focus Mode reduces panels without hiding required controls'],
    ['evidence-cards', 'Completion claims link to the governing evidence'],
    ['keyboard-flow', 'Core flows are reachable without a mouse'],
  ]],
  ['MONA-030', 'Complete', 'No artificial feature hiding: honest unsupported states, version drift detection, upgrade qualification', [
    ['unsupported-states', 'Unsupported features explain the exact reason and never appear enabled'],
    ['version-drift', 'Runtime version changes are detected and unsafe operations disabled'],
    ['upgrade-qualification', 'Upgrades are explicit tested compatibility decisions'],
    ['coverage-report', 'A coverage report states what is qualified, partial or blocked'],
  ]],
].map(([id, track, title, criteria]) => ({
  id,
  track,
  title,
  owning_prompts: prompts.filter((p) => p.requirements.includes(id)).map((p) => p.id),
  status: 'pending',
  criteria: criteria.map(([cid, description]) => ({ id: cid, description, status: 'pending', evidence: [] })),
  verified_commit: null,
  tested_environment: null,
  open_issue_ids: [],
}));

const sha256File = (p) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
};

const target = path.join(root, 'docs', 'requirements.json');
if (fs.existsSync(target) && !force) {
  console.error(`refusing to overwrite existing ledger: ${target} (pass --force to replace; previous file is backed up)`);
  process.exit(2);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(target, backup);
  console.error(`backed up existing ledger to ${path.relative(root, backup)}`);
}

const ledger = {
  schema_version: 1,
  revision: 1,
  spec: {
    file: 'Mona_Project.md',
    companion_file: 'Mona_PROMPTS.md',
    version: '1.0',
    sha256: sha256File(path.join(root, 'Mona_Project.md')),
    companion_sha256: sha256File(path.join(root, 'Mona_PROMPTS.md')),
    indexed_utc: new Date().toISOString(),
  },
  prompts,
  requirements,
};
fs.writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(`wrote ${path.relative(root, target)}: ${prompts.length} prompts, ${requirements.length} requirements, ${requirements.reduce((n, r) => n + r.criteria.length, 0)} criteria`);
