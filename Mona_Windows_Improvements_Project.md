# Mona Windows — Studio, reliability and Prompt Runner improvements

Version 1.0 · November 14, 2026 · Companion: `Mona_Windows_Improvements_PROMPTS.md`

## S00 — Status and evidence boundaries

This is an implementation specification for improving the existing Windows Mona. **It is not a Windows repository code review.** No Windows source tree or installed Windows app was inspected for this document. The implementing agent must reproduce suspected problems against its actual checkout before fixing them.

Inputs: the original `Mona_Project.md` and `Mona_PROMPTS.md`; the supplied Windows P23 release report; `MacMona_Studio_Review_PROMPTS.md`; and `Mona_Prompt_Runner_PROMPT.md`. The two new Windows documents are self-contained supplements. Do not apply the Mac hotfix patch to Windows, assume identical source paths, or import Mac build-state files.

The latest supplied Windows report, which may now be stale, describes a **Core usable release candidate 0.1.0**, not a completed 1.0:

| Reported evidence | What the new work must preserve or resolve |
|---|---|
| P00–P23 delivered; state revision 71, ledger revision 325; validation clean | Reconcile current state. Do not restart or renumber the original sequence. |
| Product `287a7e5`, release docs `205a104`, rebuilt candidate `28e0979`; no remote then | Treat these as historical references, not current HEAD or permission to invent a remote. |
| 28 requirements verified; MONA-027 blocked; MONA-028 partial | Preserve the exact outstanding criteria and connect new evidence to them. |
| Real Changes section and virtualized 8,007-line diff; 29 rendered rows; traversal refused | Retain working Changes functionality. Improve only demonstrated gaps. |
| Conversation Markdown export and atomic write path tested | Retain fence escaping, cancellation and empty-session behavior; qualify the actual native save dialog. |
| `PROJECT_VIEWS` unifies rendering/persistence/validation; D-0103 | Preserve all existing navigation sections and their restart persistence. |
| Clean-root install/verify/uninstall and classic Explorer menu passed; external Codewhale state preserved | Repeat on the changed candidate. A staging install root is not necessarily a clean Windows trust environment. |
| Test-signed MSIX still failed trust with `0x800B0109` | Modern-menu/production-distribution work remains open unless newer evidence closes it. |
| Idle Mona reported as 406.4 MB; engine 256.4 MB separately; D-0104 keeps target unchanged | Profile and measure honestly. Original spec says under 350 MiB; reconcile MB/MiB and metric before comparison. Do not silently accept a higher target. |
| Cold 1,093 ms, warm 741 ms, idle CPU 0.04%; startup harness used development build | Preserve historical results as development-build evidence. Measure the packaged app. |
| Narrator and physical 200% scaling unverified | Keep these explicit native/human tests; browser zoom is not OS scaling. |
| Codewhale `0.10.2 (ff466b2ed0bf)`; upstream check failed | Inspect the actual installed pin. No silent upgrade or claim of new upstream compatibility. |
| License deliberately unchosen | Do not select a license on the user's behalf or claim broad distribution is ready without resolving this. |

Potential Mac-to-Windows parallels to investigate: asynchronous draft loss; stale navigation responses; orphaned event/cursor rows on replacement import; cross-thread or cross-item text merging; heartbeat-induced duplicate cards; inaccessible older history behind a raw-event cap; missing shortcut; incomplete fullscreen; missing command catalog/dispatch; missing native approval replies; attachments without a qualified route; CI/scanner noise; release gaps. **All are hypotheses for Windows until local evidence establishes their status.**

## S01 — Scope, ownership and continuity

Target the existing Windows 11 x64 native build on qualified local NTFS workspaces. Keep Windows ARM64, WSL, UNC/network and cloud-synced working directories at their existing qualification level. Do not introduce WSL, Rosetta, a platform rewrite, a hosted service or a different engine to satisfy this enhancement pass.

Preserve the configured DeepSeek/Codewhale provider, endpoint, model, credentials, tool authority and context behavior. Full Access is the existing chosen execution posture; it does not mean Windows administrator rights or permission to silently change certificate trust. Routine authorized local development, software/tool installation, builds and tests may proceed without repeated confirmation. Preserve existing rules for commits, remotes, signing and publication.

Use a subordinate enhancement ledger at `.mona/build/reviews/windows-v2/` unless the actual repository already has a suitable Windows review namespace. Keep `state.json`, `HANDOFF.md`, `DECISIONS.md`, `BLOCKERS.md`, an index of requirements and evidence references. Integrate through the current ledger CLI where possible. Do not overwrite the original `.mona/build` task state or any macOS/Linux ledger.

Track W00–W25 separately from P00–P23. Each record includes prerequisites, selected source/spec hashes, status, acceptance still open, evidence provenance, affected original requirements, stable problem IDs and next action. Atomic revision-checked writes and recovery copies are required. Historical evidence remains historical when code changes; fresh checks must qualify changed bytes. Do not blindly replace hashes to make a validator green.

The product's project/task/run state remains separate from these developer build records. A user of Prompt Runner must not need Mona's own `monabuild` utility in their project.

An attempt means a hypothesis plus an observed result. After three consecutive attempts on the same problem without material progress, stop that problem, retain all counts and evidence, and involve **the human**. Continue genuinely independent eligible work; block dependent work. A new session, task name or child agent does not reset the count. Material progress needs evidence. Never lower requirements, remove tests, conceal gaps or create a substitute architecture to erase a blocker.

Use **Needs the Human** throughout the new UI, exports and generated agent instructions. Do not hard-code a person's name. Preserve a project's own maintainer references in its original instruction files.

## S02 — Reliable conversations and state

### Drafts and submissions

Bind every draft, save acknowledgement and submission to project/thread plus a draft revision. Capture the actual submitted text before awaits. Clear only that accepted revision; preserve newer text, other projects' drafts and caret/selection. Errors, cancellation and uncertain acceptance retain recoverable text. Main-process single-flight/idempotency guards must prevent duplicate paid sends, not merely disable a React button after a render.

Guard async project selection, runtime connection, history and action results with stable identities/generations. A late response cannot overwrite another project's state. Preserve the existing shared view allowlist. Project/thread changes and focus/fullscreen changes must not remount the runtime or drop draft state.

Enter inserts a newline. **Ctrl+Enter submits** through the exact same validation path as the Send button. Handle composition/IME, auto-repeat, empty input, unsupported mode, pending input and disabled/busy states. Do not intercept unrelated editor/terminal shortcuts. Tab accepts an autocomplete candidate; plain Enter still inserts a newline.

### History, rendering and export

Store and project events by engine/thread/turn/item identity, with documented cursor semantics. Heartbeats and connection plumbing do not finish answer cards. Replays do not duplicate text, tools or usage. Reconcile a final message with its streamed item without merging another item's content.

Keep rendering bounded while retaining access to the full stored conversation. Page by stable cursor/anchor, not a misleading “show earlier” control over only the newest raw frames. Preserve scroll position, unread count and jump-to-latest behavior. A follow-scroll preference must not pull the user away from reading history.

Replacement imports, restores and migrations handle all associated rows, including events/cursors that may lack foreign keys. All writers obey maintenance mode. Use qualified SQLite backup/restore and safe atomic filesystem operations. Never delete the recovery journal before a verified replacement is committed. Preserve unrelated projects and external Codewhale storage.

Retain Markdown export with safe variable-length fences and atomic output. Test the Windows save dialog itself as well as its writer. Avoid overwriting user files without the native save workflow. Exporting, paging and searching make no model calls.

## S03 — Commands and a complete Studio

### Descriptive slash autocomplete

Build a versioned catalog from the installed engine's real slash-command registry/source/help. Runtime endpoints, CLI subcommands and TUI slash commands are different interfaces. Each row records canonical name, aliases, description, argument hints, scope, side effects, cost class, provenance, qualified execution route and support state.

Typing `/` in a command position opens an accessible searchable list with useful descriptions. Respect multiline text, cursor selection, pasted code, escaped literal commands and Windows paths. Do not interpret `C:\...`, UNC text or quoted example commands as actions. Do not invent descriptions with a runtime model call.

Execute qualified local commands via typed main-process operations. Never send recognized `/new` text to the model or interpolate command input into a shell. A TUI-only capability gets truthful guidance, not simulated success. Unknown input remains visible and can be deliberately sent as ordinary text; no silent ambiguous fallback.

`/new` creates a fresh engine conversation while retaining old history, draft, usage, task and attempt records. It preserves model/permission selection. Busy, disconnected and lost-acknowledgement paths must be explicit. Thread creation and turn submission are separately durable operations. Unsupported idempotency or lookup does not justify blind retry.

### Focus and Windows fullscreen

**Focus Studio** fills the application content area with a slim dashboard, agent timeline and composer. **Full screen** uses the desktop shell's actual window fullscreen operation, with observed native state as authority. Keep these separate from maximize. Reuse current layout/state services and expose menu/keyboard controls; F11 is the proposed fullscreen shortcut only after checking current bindings. Choose a conflict-free Focus shortcut and document it.

Retain an obvious exit and interrupt control. Preserve window bounds, maximize state, focus, draft selection, scroll anchor and pending requests across transitions. Keep the app accessible with keyboard/Alt+Tab and its normal close/quit flow. Avoid duplicate toggles between menu accelerators and renderer handlers. Escape dismisses the topmost transient surface before exiting Focus; it never interrupts work or erases text. Do not restore into fullscreen without an explicit user preference/action.

The HUD should normally be about 44–56 logical pixels high and wrap at larger scaling. Show project/thread, actual activity/connection state, elapsed time, requested/effective model where known, cost/token scope, and Needs the Human. Secondary diagnostics belong in a drawer. The timeline takes remaining height; a resizable growing composer must not push it completely offscreen.

## S04 — Aurora appearance and application identity

Make the real production shell visibly more expressive, not just a demo screen.

| Treatment | Direction |
|---|---|
| Daybreak | Pearl/lilac canvas, ink text, saturated iris controls, sea-glass accents and selective coral |
| Afterglow | Midnight indigo, raised amethyst surfaces, electric orchid, luminous mint activity and coral attention |
| Decorative palette | Iris `#795CFF`, orchid `#C16CFF`, cyan `#38CFE8`, mint `#55E3B3`, coral `#FF7E96`; validate every actual text/background pair |
| Identity | Rich project plaque/monogram, active-project rail, thin gradient separators and selective illuminated edges |
| Content | Stable high-contrast reading/code surfaces; distinct user, agent and tool hierarchy |
| Motion | Brief real-state transitions; no particle fields, giant continuous blur or fictional busy animation |
| Preference | Vivid / Quiet decoration intensity; both support both themes and all functions |

Use shared tokens and existing component primitives. Respect Windows contrast themes/forced colors, reduced motion, text size and keyboard focus. Do not fetch decorative assets or fonts at runtime or spend inference for decoration. Benchmark rendering/idle changes.

Use the approved Mona M artwork if available locally: violet/mint/coral over midnight indigo. Retain its original asset and create proper multi-resolution Windows icon/package assets using deterministic tooling. Inspect small-size legibility, transparency and clipping. Apply consistently to the executable/window, taskbar, Start menu, installer and supported shell surfaces. Test installed icons and upgrade behavior; do not change app identity/IDs just to refresh a cached icon. If the approved source is missing, log that asset prerequisite and continue other work. Do not silently replace it with a new logo.

## S05 — Watching agents and communicating with them

Show real work: current tool/task strip, turn dividers, expandable command/path/result cards, duration and exit status when supplied, tool errors, parent/child ownership, unread activity, jump-to-latest and filter/search. Keep long output bounded with access to the complete artifact. Never invent progress percentages, private reasoning, agent identities or live token counts.

Three message intentions must remain distinct:

1. **Answer this request:** reply to a specific pending approval/clarification using its native request ID and supported protocol.
2. **Send after this turn:** enqueue a visible, editable/cancellable follow-up bound to its original project/thread.
3. **Steer this run:** available only when the pinned engine has a verified steering interface.

Persist requests, permitted answer shapes, status and acknowledgement. Handle expiry, duplicate answers, reconnect and project switching. “Delivered” requires a receipt. Do not suggest broader permissions to bypass a waiting question, or assume another client can safely attach to the same owned runtime.

The **Needs the Human** inbox also contains advisory decisions, blocked issues, human-only acceptance checks and uncertain execution. It shows exact questions, source tasks, evidence, affected dependencies, options/recommendations and answer history. Closing a card is not answering or satisfying a requirement. Use local notifications through existing settings; avoid repeated alerts while the relevant view is already open. No automatic email or external messages.

Composition conveniences include recoverable drafts, prompt favorites/history with deliberate insertion, local conversation search, copy answer/code/path, safe open/reveal, export, a shortcut reference and qualified file context. Distinguish a file path reference from actual uploaded/attached content. Do not present unsupported attachments as delivered or add a large editor to initial load for a minor convenience.

## S06 — Prompt Runner product contract

### Import and authorization

The person chooses a numbered Markdown prompt file, previews selected tasks and dependencies, then selects **Start selected prompts**. That authorizes the finite selected run. Importing, opening a project, reading history or answering an unrelated question never starts spending. Default to one mutating task per workspace within the existing runtime ownership limits.

Parse headings such as `### R00 — …`, `### P00 — …` and `### W00 — …`, excluding fenced examples and ordinary numbered lists. Capture shared operating instructions separately. Preserve IDs, exact task text, acceptance criteria, source hashes and references. Flag duplicate IDs, cycles, unresolved dependencies, gaps and ambiguous structure. Offer a visible mapping/manifest when necessary; no AI parsing dependency.

Use explicit dependencies where available. In an unannotated sequence, propose predecessor dependencies and show that assumption. Only genuinely independent recorded tasks may pass a blocker. Existing verified status can satisfy prerequisites; imported “done” text alone cannot. Reimports must not reset work or attempts. Freeze the authorized plan and review source changes at task boundaries instead of silently adding/replacing tasks.

### Execution and continuity

For every new task, create a fresh Codewhale conversation through the qualified equivalent of `/new`, then submit the selected task plus bounded global instructions, relevant requirements, durable handoff and outstanding problem counts. Do not synthesize keystrokes. Do not pass every prior transcript or all other prompt bodies to the new conversation.

Persist identities for run, task, dispatch, thread, turn, problem and human request. The main process owns advancement; renderer state and current UI selection do not. One owner holds the workspace mutation boundary through actual work, not only through submission acceptance. Coordinate with board, native workflows, queued user messages, maintenance and update services.

An accepted submission is not a completed turn; a completed turn is not a verified task. Advance only after actual terminal engine state, a matching structured result and the task's evidence gate. Failed/interrupted/uncertain work stays incomplete. Continuations address the same unfinished task, normally in the same conversation; new conversations are the default between tasks.

Use a bounded, versioned result contract and an assigned local file written atomically, or an already qualified structured reporting channel. Include run/task/dispatch IDs, prompt hash, disposition, work summary, acceptance/evidence, unresolved issues/attempts/questions and next action. The controller supplies engine identity from its own records; agents need not guess hidden IDs. Validate schema, size and binding; reject stale/partial results and unsafe evidence paths. Reports cannot add tasks, execute arbitrary commands or mark the queue complete.

Use durable operation keys, transactional/revision-checked transitions and supported reconciliation. After lost acknowledgement, do not repeat an uncertain write under a new key. After restart, recover and show Resume by default; minimized operation may continue within the authorized run. Full Access means the agent may write project files, so the result contract is not a security sandbox or proof of correct work.

Enforce the persistent three-no-progress-attempt rule. Also expose a distinct finite continuation allowance, default three automatic follow-up turns per task, adjustable at launch. A result-repair follow-up is limited to one and counts against that allowance. Increasing allowances requires a deliberate human choice; changing threads does not replenish them. A healthy long-running turn is not automatically interrupted merely for being long.

### Completion and human work

Distinguish observed checks, agent-reported results and human observations. Human-only criteria remain unverified. Do not execute command strings from result JSON; verification uses previously authorized checks through the normal boundary. Evidence must match the relevant code/artifacts; later edits may invalidate a claim without automatically re-running every prior task.

A blocked task keeps its partial work and blocks its dependents. Independent work proceeds only when the workspace is suitable and prior mutating activity has actually settled. A pending native approval can leave a turn active: recording its question does not free the workspace. Switching tasks may require an authorized and confirmed interruption; uncertainty prevents another mutating start.

An advisory question can wait without blocking unrelated acceptance. Answering an inbox item records the decision and reopens only the affected work. A skipped task is an explicit scope decision and does not automatically satisfy dependencies. End states distinguish all verified, finished with blockers, waiting for the human, interrupted and cancelled.

Provide a deterministic Markdown report with completed work/evidence, unfinished tasks, Needs the Human, recorded changes/commits, usage coverage and next actions. No summarizing model.

### Runner experience and lifecycle

Use the Studio HUD for task ID/title, sequence position, completed/blocked counts, real activity, elapsed time, cost and Needs the Human count. Sequence position is not percent completion. Make it easy to inspect earlier conversations without redirecting work or losing a draft.

Keep **Pause after this task**, **Interrupt now**, **Cancel remaining**, **Resume** and **Review results** distinct. Human intervention cannot race an automatic next dispatch. A user follow-up is not silently appended to another task. Updates/restores must defer or quiesce every writer and owned run.

Offer an explicit keep-awake option for a running queue using the qualified desktop mechanism. Release it on pause/end. Do not install a service or scheduled task for this feature, disable system sleep globally, prevent shutdown, or promise survival of forced sleep/logout. Document minimize, close, quit, lock, sleep/wake and relaunch behavior on Windows.

## S07 — Economics, metrics and performance

All navigation, theme changes, autocomplete, deterministic summaries, queue selection, exports, search and notifications use zero inference. Preserve engine context/protocol ownership and model route. No automatic expensive fallback, paid reviewer, compulsory parallel agents or background summarizer.

Costs must show scope and provenance. Deduplicate request/turn usage; distinguish inclusive parent totals from incremental children. Avoid double-counting cached input or reasoning tokens. Preserve historical rates and label estimates/provider-reported/unknown. Late usage updates change the correct original task, never the currently selected one. Do not invent real-time spend or a prepaid balance.

Reuse existing budgets before every new paid submission, including runner continuations/result repair. Limits are user-set, not a new mandatory small spending ceiling. A between-turn gate cannot promise a hard invoice ceiling for an in-flight agent turn. If an enabled currency limit cannot be enforced because usage/pricing is missing, pause and explain that condition. Fresh sessions can resend context and affect caching; no unconditional savings claim.

Authorize focused local profiling and ordinary fixes within this improvement scope. Measure release/packaged Mona processes together and the engine separately. Record bytes, MB/MiB conversion, working set/private memory definitions, hardware, OS build, runtime/build type, scenario and sampling method. Never compare V8 heap alone with a whole-application target. The original initial-idle target remains under 350 MiB unless an explicit current decision changes it; D-0104 is not silently superseded.

Profile representative startup/idle/history/terminal/editor scenes. Investigate eager editor/PTY loading, retained DOM/event arrays, duplicate caches/subscriptions, listeners, unnecessary process creation and background work. Prefer lazy loading, bounded projections and correct cleanup. Keep profiles private/redacted. Do not remove isolation, discard accessible history or replace Electron to meet a number. If the target remains missed, report the measured result, practical fixes and exact remaining decision without hiding it.

Retain the original startup targets: warm interactive view within 2 s, cold within 5 s with engine/provider components separated; idle app CPU under 1% over 60 s on the reference machine; usable typing/scrolling with 10,000 events. A build smoke test is not an interactive-startup timing measurement. Compare the actual distributed candidate and hash the tested artifact.

## S08 — Windows accessibility and native qualification

Test keyboard-only operation, Narrator, high contrast/forced colors, reduced motion, text enlargement and **actual Windows 200% display scaling**. Include mixed-DPI monitor moves and display removal when available. Browser zoom supplements these checks; it does not replace them. If the build machine lacks a human/native capability, complete automated work and leave a concise actual-observation checklist.

Meaningful announcements describe turn/task transitions, tool failures and questions without reading every streamed token. Accessible autocomplete follows a consistent focus/selection model. Dialogs restore focus. Terminal/editor/drawers have an escape route. Fullscreen, the HUD, the composer and interruption controls remain usable at 200% and narrow sizes.

Run installed workflows, not only development harnesses: new/dirty folder launch, long session, `/new`, Ctrl+Enter, save dialog, focus/fullscreen, pending input, queued follow-up, three-task runner, interruption/recovery, budget refusal and shutdown without orphaned owned descendants. Use fake-engine fixtures for broad deterministic coverage and minimal live tasks only within existing test authorization/budget.

## S09 — Modern Explorer menu, installer and sharing

Preserve the existing package/installer architecture unless a demonstrated issue requires an authorized design decision. Qualify modern Windows 11 folder and folder-background menus separately from classic **Show more options**. Keep Explorer integration small and fast, with no model/network work in the shell. Pass paths as data, test Windows quoting, Unicode, ampersands, apostrophes, parentheses, drive roots, reparse/junction aliases, moved installations and second-instance launches.

Modern menu integration and package identity/signing have distinct failure surfaces. Microsoft documents the packaged/external-location identity route and target-device trust requirement [S1–S3]. Developer Mode is not a blanket cure for an untrusted signing chain. Diagnose the actual `0x800B0109` event, package publisher/signing identity and relevant trust context. Do not hide failure or label a classic-menu fallback as MONA-027 complete.

Keep local development/test trust separate from broad distribution. Never silently import a trust root, disable validation, export/share a private signing key or embed credentials. For a test-certificate path, first prepare the concrete public certificate fingerprint, affected store/scope and removal steps; use an already explicit authorization or ask for that specific trust change. Verify the documented store/scope on the actual deployment path; do not spread a broad root trust as a convenience. Production signing uses existing authorized credentials/services or remains a precise external prerequisite. No certificate purchases without authorization.

The desired recipient experience is an executable installer (or the project's existing supported installable package) that can be shared directly, installed without developer tools or manual source builds, and opened from Start or Explorer. Keep per-user installation by default and the app non-elevated during normal work. Name the exact file a friend should use; distinguish it from source archives, raw payload folders and development scripts.

Bundle or explicitly bootstrap qualified redistributable runtimes and dependencies with integrity checks, license/provenance and a clear offline/network story. Never package the developer's API keys, history, certificates/private keys, machine paths or personal configuration. First-run key/profile setup is separate from installation; recipients use their own credentials. Preserve an existing external Codewhale install/config. Verify current redistribution terms from the actual dependency sources and record them; do not invent license approval.

Test clean user and genuinely clean Windows environment, install/first launch, both menu paths, same-version repair where supported, upgrade from prior candidate, active-work deferral, failure rollback, uninstall and retained user projects. A fresh destination folder alone does not prove clean trust or absence of preinstalled runtimes. Do not kill or restart Explorer or active work without an explicit user-facing action/necessary authorization.

Build reproducibly, record artifact hashes/source commit/dependency lock/architecture, and provide notices, changelog, rollback and concise user/developer guides. Validate the final signed artifact after signing; hashes from an earlier unsigned package do not describe it. Signing does not guarantee absence of reputation warnings. Keep the unresolved license decision explicit.

Release labels must remain honest: Core usable candidate; test-signed development package; signed distribution candidate; complete 1.0 only when its original mandatory criteria pass. Complete all independent code/build/verification work before asking for unavailable credentials or human signoff. Creating artifacts does not authorize publishing them publicly.

## S10 — Enhancement traceability and completion

The implementing agent maps these supplement IDs to the actual original requirement ledger; IDs below do not replace MONA requirements.

| Supplement ID | Outcome | Owning prompts |
|---|---|---|
| WX-01 | Evidence-led adoption; durable review state | W00, W21, W25 |
| WX-02 | Lossless drafts, async navigation and Ctrl+Enter | W01 |
| WX-03 | Transactional imports/restores and real export workflow | W02 |
| WX-04 | Complete, stable and efficient history | W03 |
| WX-05 | Descriptive native command catalog and correct execution | W04, W05 |
| WX-06 | Focus/native fullscreen Studio | W06 |
| WX-07 | Aurora themes/intensity and accessible polish | W07 |
| WX-08 | Native human requests and agent communication | W08, W09 |
| WX-09 | Factual HUD, usage, costs and budgets | W10 |
| WX-10 | Composition/navigation/file-context conveniences | W11 |
| WX-11 | Approved icon throughout Windows distribution | W12 |
| WX-12 | Numbered-file import and deterministic Prompt Runner | W13, W14, W15 |
| WX-13 | Evidence-gated progression and Needs the Human | W16 |
| WX-14 | Runner UI, economics, lifecycle and recovery | W17, W18 |
| WX-15 | Measured memory/performance with unchanged targets | W19, W24 |
| WX-16 | Narrator, real DPI and keyboard qualification | W20 |
| WX-17 | Modern Explorer integration and trust | W22 |
| WX-18 | Installable/shareable candidate and honest handoff | W23, W24, W25 |

Every completed prompt needs implemented behavior or an evidenced already-satisfied finding, focused verification, original/supplement requirement links and a durable checkpoint. A human/signing blocker does not prevent unrelated work, but it does prevent claiming the affected feature complete. The final handoff accounts for all tasks, even when some remain blocked.

## Reference notes

Primary platform documentation checked November 14, 2026; implementation must use the APIs of the repository's pinned versions. These references inform platform boundaries, not a claim that Mona has passed those tests.

- [S1 — Microsoft: external-location package identity](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps).
- [S2 — Microsoft: File Explorer context-menu extension](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer).
- [S3 — Microsoft: App Installer trust troubleshooting](https://learn.microsoft.com/en-us/windows/msix/app-installer/troubleshoot-appinstaller-issues).
- [S4 — Electron: BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window): use observed window state with the appropriate native operation.
- [S5 — Electron: performance](https://www.electronjs.org/docs/latest/tutorial/performance): profile actual bottlenecks before optimization.
