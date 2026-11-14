# Mona Windows — improvement and fix execution prompts

Version 1.0 · November 14, 2026 · W00–W25

Requirements: `Mona_Windows_Improvements_Project.md` (sections S00–S10), supplementing the existing `Mona_Project.md` and `Mona_PROMPTS.md`.

**This is not a Windows code-review report.** Mac findings are investigation leads. Confirm the actual Windows implementation and keep working features. Do not apply `MacMona_Review_Hotfix.patch` or assume Mac source paths exist here. The original P00–P23 sequence stays intact.

## 1. Start and resume

Place both new Windows documents in the Windows repository. Start with:

```text
Continue the existing Windows Mona using
Mona_Windows_Improvements_Project.md and
Mona_Windows_Improvements_PROMPTS.md. Start W00.

Read repository instructions, the original Windows handoff/state/blockers,
and this file's operating contract. Reconcile current source and evidence;
preserve completed work, user changes and all persistent attempt counts.
This is an improvement pass, not a rebuild or a presumed code review.

Complete W00 through validation and a durable checkpoint, then report the
next eligible prompt. Keep Codewhale's current route and economics.
Use “Needs the Human” in new interfaces, reports and generated instructions.
```

For later sessions:

```text
Resume Mona_Windows_Improvements_PROMPTS.md. Read the Windows improvement
handoff/state and relevant original blockers. Reconcile unfinished work
with the source and evidence. Resume the current unfinished W prompt,
otherwise the earliest eligible one. Complete it end to end, update the
ledgers and handoff, then report. Preserve the three-attempt rule.
```

For an explicitly authorized longer development session:

```text
Execute the remaining eligible W00–W25 prompts from
Mona_Windows_Improvements_PROMPTS.md. Checkpoint after each and continue
within that finite sequence. Finish implementation, verification and docs;
do not stop merely after proposing a plan. At three attempts on one problem
without material progress, stop that problem, record the exact help needed
under Needs the Human, and continue independent eligible work. If nothing
eligible can progress, checkpoint and report. Do not lower requirements or
reset counts. Complete W25's honest handoff after the run is settled.
```

These instructions authorize development of the feature set. They do not authorize starting arbitrary real project queues, purchasing signing services, changing OS trust, publishing a release or silently changing provider/model. Use existing explicit authorization where it already covers an action; do all independent authorized work before asking for an unavailable prerequisite.

## 2. Operating contract for every W prompt

**Act on the current checkout.** Read `AGENTS.md`, the existing build handoff/state and relevant blockers. Discover actual source entry points with `rg`. At W00, index the two new documents and record hashes; thereafter read only the current prompt, referenced S sections and affected source unless hashes changed. A single builder using the existing Flash route is sufficient; no mandatory delegation or second paid reviewer.

**Preserve state.** Use the subordinate Windows review namespace established in W00. Map enhancement evidence to original MONA criteria without rewriting generated requirement structures by hand. Use current CLI/schema/revision operations. Do not touch another platform's ledger. Retain old results with their actual source/build identity; reverify claims affected by changes.

**Finish the assignment.** Implement, run meaningful focused tests, update documentation and requirement evidence, checkpoint, and make a coherent local commit according to repository rules. If a feature already meets the criteria, record fresh evidence and avoid needless rewrites. Do not mark missing or blocked acceptance completed. Don't write tests that merely repeat an implementation, or keep rerunning unrelated suites after relevant checks pass.

**Three attempts persist.** Record a stable problem ID, hypothesis, action, result, total attempts and consecutive attempts without material progress. The third no-progress attempt stops that problem. Preserve counts across sessions, phases and agents; reopen only with a human decision or material evidence. Continue genuinely independent work, not work requiring the blocked result. Do not architect around failure, broaden permissions, delete a requirement/test, fake integration or change platforms to declare success.

**Keep costs low.** UI and orchestration logic make zero inference calls. Preserve the working engine pin/route, including provider, endpoint, model, credentials and tool/context semantics. Use fixtures for broad coverage and targeted local tools. A new live benchmark needs remaining explicit budget/authorization; do not treat the original pilot ceiling as replenished for every prompt. Ordinary CSS changes need no new paid benchmark. Never print secrets or commit private transcripts, memory snapshots or signing material.

**Keep the user in control.** Ordinary authorized local installs/builds/tests proceed. Never erase unrelated changes or silently reset/stash/clean a workspace. Follow existing remote rules; do not invent a remote. No automatic public publication or purchases. Full Access does not override UAC, certificate trust or managed policy. New product language is **Needs the Human**, not an individual's name.

**Truthful evidence.** Label static inspection, fixture/unit tests, real Windows runtime/packaged tests and human observations separately. A tool-accepted prompt is not a completed task. Browser zoom is not physical OS scaling; development timings are not packaged timings; self-signing is not recipient trust. The final report must preserve these distinctions.

**Report briefly.** State prompt ID and disposition; what changed or was already verified; relevant tests/platform/artifact; unresolved problems and exact help; checkpoint location and next eligible ID. Do not dump routine command output into the conversation.

## 3. Dependency and coverage map

Prefer ascending numeric order among eligible prompts. Dependencies are behavior/evidence gates; do not infer that every lower number must be completed. An unlisted prerequisite discovered in source must be recorded before dependent work starts. W19–W23 include useful independent profiling/qualification work even when a feature or trust prerequisite is blocked. An unfinished subcheck remains unfinished.

| Prompt | Deliverable | Prerequisites | Spec |
|---|---|---|---|
| W00 | Reconcile Windows baseline and seed review state | Existing Windows project | S00, S01, S10 |
| W01 | Lossless drafts, async navigation, Ctrl+Enter | W00 | S02 |
| W02 | State cleanup, restore discipline and export dialog | W00 | S02 |
| W03 | Complete history and stable streaming | W01, W02 | S02 |
| W04 | Descriptive slash-command catalog/autocomplete | W00 | S03 |
| W05 | Native command dispatch and real `/new` | W01, W03, W04 | S03 |
| W06 | Focus and native Windows fullscreen Studio | W01, W03 | S03 |
| W07 | Aurora appearance and Vivid/Quiet | W06 | S04 |
| W08 | Native approval and clarification replies | W01, W03 | S05 |
| W09 | Agent observatory, follow-ups and steering | W05, W08 | S05 |
| W10 | Factual slim dashboard, costs and budgets | W00, W03 | S07 |
| W11 | Composition, navigation and review conveniences | W01, W03, W04 | S05 |
| W12 | Windows app/icon identity | W00; approved asset for final imagery | S04 |
| W13 | Prompt Runner contract and state model | W00 | S06 |
| W14 | Numbered Markdown importer and preview | W13 | S06 |
| W15 | Durable automatic sequential execution | W01, W05, W10, W13, W14 | S06 |
| W16 | Verification, blockers and Needs the Human | W08, W15 | S06 |
| W17 | Runner UI, spending and lifecycle controls | W06, W07, W09, W10, W16 | S06, S07 |
| W18 | Runner fault qualification and user guide | W02, W03, W15, W16, W17 | S06, S08 |
| W19 | Memory profile and performance repairs | W00; final measurement after relevant changes | S07 |
| W20 | Narrator, physical DPI and accessibility | W00; final UI required for final signoff | S08 |
| W21 | Whole-change regression/evidence reconciliation | W00; test the actual settled candidate | S01, S08, S10 |
| W22 | Modern Explorer menu and signing/trust qualification | W00 | S09 |
| W23 | Installer, upgrade, uninstall and clean recipient | W00; W21 for final candidate qualification | S09 |
| W24 | Packaged workflows, timings and release gate | W21, W23; W22/W20 for their release claims | S07, S08, S09 |
| W25 | Final maintainable handoff and disposition | W00; no active mutating work | S10 |

W25 is a reporting/closure task. Execute it after the authorized sequence is settled or further work is externally blocked; it may account for blocked tasks without claiming they completed. W24 can perform packaged timings while signing or human checks remain open, but cannot declare release qualification complete. Record partial work so the next session resumes the missing check rather than rerunning everything.

## 4. Numbered execution prompts

### W00 — Establish the actual Windows baseline

**Read:** S00/S01/S10; original project instructions, `.mona/build` state/handoff/decisions/blockers, original requirements and current package scripts.

**Execute:** Reconcile HEAD, dirty files, engine version/pin, target Windows build and existing QA evidence against the supplied P23 report. Preserve P00–P23 progress and D-0103/D-0104 or newer decisions. Inventory production entry points for shell, Studio, history, state store, engine adapter, queue, cost, IPC, native shell helper, packaging and tests; do not copy Mac paths into the plan.

Create the subordinate review ledger, indexed S/W sections and dependency map. Classify each suspected Mac parallel as reproduced, already fixed, absent/different or unverified. Reproduce high-impact claims cheaply before editing. Run current validation and appropriate baseline checks; distinguish existing failures, test-fixture credential patterns and actual secret findings. Do not disable a scanner or normalize away a failure. Make necessary formatting-only repairs separately from behavior changes.

Record the known native gaps and exact required evidence. Determine whether a claimed clean-root test used a truly clean trust/user environment. Identify the installer recipients should eventually use. Establish machine-testable versus human/signing gates so those do not prevent independent work.

**Acceptance:** Current source/engine/platform and baseline checks recorded; W tasks indexed with no falsely completed statuses; real existing features preserved; evidence/attempt counts survive validation; no production behavior changed without a targeted finding.

**Checkpoint:** W00 assessment table, source map, current evidence limitations and next eligible prompt. Do not say this document itself constituted a Windows code review.

### W01 — Make drafts, navigation and keyboard submission lossless

**Read:** S02; actual composer, shell selection handlers, draft persistence, submit path and relevant tests.

**Execute:** Follow draft text and identity through saves, submissions, project/thread switches and runtime reconnects. Capture submission text plus project/thread/revision before awaits. Accepted sends clear only their captured revision. Late saves cannot label newer text saved; late selection responses cannot overwrite current project state. Preserve drafts, selection, composition and carets through mode/layout changes. Restore all registered views after restart using the current shared view source of truth.

Implement or qualify **Ctrl+Enter** through the same submit gate as the button, while Enter remains newline. Guard IME/composition, key repeat, empty input, incompatible modifiers, busy/unavailable mode and pending request controls. Use a main-process/operation guard as well as renderer feedback to prevent duplicate accepted turns.

**Acceptance:** Deterministic deferred-promise tests cover send→type more, send→switch project/thread, out-of-order saves, duplicate button/shortcut events, uncertain/rejected send and restart. Newer and other-project drafts remain; empty/blocked submissions send nothing; exactly one accepted request occurs for the same user action. Native Windows keyboard smoke covers IME and Ctrl+Enter in the real composer.

**Checkpoint:** Reproduction and repair evidence or already-satisfied evidence, changed contracts and focused test results for WX-02.

### W02 — Preserve state integrity and finish export qualification

**Read:** S02; project imports, migrations, backups/restores, events/cursors, Markdown export and save-dialog boundary.

**Execute:** Verify replacement import deletes/rebinds all records it owns, including tables without foreign keys, within the proper transaction. Preserve unrelated projects and engine-owned history. Review every active writer against the maintenance gate, including subscriptions, indexers, queues and backup paths. Keep the recovery journal until a verified replacement is durable. Confirm Windows file-lock, access-denied and disk-full behavior without weakening recovery guarantees.

Retain the delivered export implementation and adaptive fences. Exercise the actual packaged/native Windows save dialog: save, cancel, existing filename, empty conversation, Unicode/spaced destination, read-only/error destination and successful atomic write. Do not mistake the tested writer for a tested dialog. Never overwrite user data outside the chosen scope.

**Acceptance:** Replacement import/export tests cover associated-row cleanup and unrelated-data preservation; fault injection preserves usable prior state or a recoverable checkpoint; all writers participate in maintenance; dialog cancellation leaves state intact; no model calls from import/export UI.

**Checkpoint:** WX-03 evidence, any original MONA-007 impact, and exact native checks still pending. Existing working features must remain intact.

### W03 — Make history complete and streaming identity-correct

**Read:** S02; actual event projection, database paging, timeline and virtual list implementation, engine cursor contracts.

**Execute:** Verify thread/turn/item keys isolate simultaneous content. Plumbing/heartbeat events must not split a streamed answer or cause a later final answer to duplicate it. Reconcile deltas and completion against their own item. Handle replay, out-of-order delivery, reconnect gaps, interrupted output and missing fields conservatively according to qualified engine semantics.

Replace any raw-event-only history ceiling with real stored-history paging while keeping visible DOM and memory bounded. Preserve anchors on prepend, show accurate loading/end/error states and keep search access to older content. Reset or scope follow-scroll/unread state by conversation. Stable keys preserve focus and tool-card expansion during streaming. Retain the proven Changes diff virtualization and traversal protections.

**Acceptance:** Fixtures include >10,000 stored events, >2,000 frames in one turn, interleaved threads/items, heartbeat between deltas, duplicate replay and genuine gaps. Old content remains reachable; no ALPHA/BETA cross-thread merge; no duplicated completed card; scrolling while reading is not hijacked. Paging makes no provider calls.

**Checkpoint:** WX-04 projection/paging contract, bounded rendering observations and Windows long-session smoke.

### W04 — Add useful descriptions to native command autocomplete

**Read:** S03; pinned Codewhale command registry/help/source, existing command/capability catalog and composer keyboard handlers.

**Execute:** Inventory every slash command and alias in the actual pinned engine. Distinguish slash commands from CLI subcommands/API names. Store useful concise descriptions, argument hints, side effects, cost class, provenance and support route. Unsupported/TUI-only entries stay discoverable with a truthful explanation.

Add an accessible autocomplete list at command positions. Filter locally, expose descriptions and arguments, preserve selection/cursor behavior, allow arrows/Tab and pointer selection, and close with Escape. Plain Enter stays newline. Ctrl+Enter on incomplete/ambiguous input explains what remains rather than silently selecting or executing a different command. Treat pasted code, ordinary prose, escaped slashes, drive/UNC paths and quoted command examples correctly. No model-generated runtime descriptions.

**Acceptance:** A coverage fixture reconciles every pinned registry row and alias; no unexplained omission or invented route. Test keyboard/IME, cursor replacement, multiline paste, literal text, Narrator semantics and large scaling. Filtering/help makes zero inference calls.

**Checkpoint:** WX-05 versioned catalog and provenance, coverage matrix, actual composer captures and routing work left for W05.

### W05 — Execute commands correctly and qualify a real new conversation

**Read:** S03; W04 catalog, main-process command dispatch, thread persistence, engine submission/reconciliation and work ownership.

**Execute:** Dispatch qualified commands through typed operation-specific IPC and supported engine APIs. Never interpolate user command text into PowerShell/cmd, send a recognized local command to the model, or fake a TUI-only result. Keep an explicit literal-text route for discussing commands. Aliases share validation; scope/model/permission-changing actions preserve existing authorization boundaries.

Implement or qualify `/new` as a fresh engine conversation, preserving previous thread/history/draft/cost/attempt evidence. Bind new-thread operation keys durably and distinguish local thread preparation from actual engine creation. Busy work remains attached to its original thread; offer wait or explicit interrupt where qualified. Do not allow a lost acknowledgement, restart or project switch to create duplicate conversations or redirect a pending send.

**Acceptance:** Positive/negative dispatch for every executable route; argument injection refused; `/new` idle/busy/disconnected/response-lost/restart/project-switch cases; old histories/drafts remain accessible; chosen provider and permission posture unchanged. Unsupported native semantics are a recorded blocker, not hidden by keystroke automation.

**Checkpoint:** WX-05 command-to-native matrix with receipts and old/new identities; a shared new-conversation operation ready for Prompt Runner.

### W06 — Deliver Focus Studio and true Windows fullscreen

**Read:** S03/S08; actual shell layout, window/menu boundary, title bar, focus management and Studio state.

**Execute:** Evolve existing Focus mode into a viewport-filling conversation/composer/HUD layout. Hide nonessential shell chrome while retaining exit, current context and interruption controls. Add actual desktop fullscreen through the narrow native window boundary, with enter/leave state observed from the window. Distinguish fullscreen, maximize and Focus. Qualify F11 or the repository's existing shortcut; avoid conflicts and duplicate renderer/menu toggles.

Replace fixed/clamped transcript heights with remaining-space layout. Let the composer grow within a cap and resize by pointer/keyboard. Keep its minimum useful height. Persist preferences without forcing fullscreen on relaunch. Preserve prior bounds/maximize state across monitor changes and exit. Escape respects autocomplete/dialog/drawer priority and never acts as Interrupt.

**Acceptance:** Actual Windows tests enter/leave while streaming, typing, scrolled back, answering input and opening drawers. No remounted engine or new inference; draft/caret/scroll survives. Alt+Tab, F11/menu exit, minimize/restore and close/quit remain usable. Narrow and 200% layouts keep essential controls reachable.

**Checkpoint:** WX-06 native state trace and normal/focus/fullscreen screenshots; separate any real-monitor check still unavailable.

### W07 — Make Aurora Studio visibly more expressive

**Read:** S04; live production components/styles/tokens, theme settings and current contrast/reduced-motion tests.

**Execute:** Apply Daybreak/Afterglow and Vivid/Quiet consistently across Studio, rail, Home, HUD, task cards, tool cards and important empty/error states. Use rich project identity, violet/iris controls, sea-glass activity, coral attention and selective gradients/edge lighting. Give conversation roles a clear hierarchy while keeping text/code on calm, readable surfaces.

Use shared tokens and existing primitives. Do not add a heavyweight animation/theme framework or change only design/demo screens. Keep animations brief and tied to actual status; paused/disconnected work must not look active. Honor reduced motion, forced colors and high-contrast focus. Appearance changes remain local and do not create a turn or reconnect a runtime.

**Acceptance:** Inspect actual rendered before/after screenshots for both themes/intensities, normal/fullscreen, long content, tool failures, Needs the Human, empty state and narrow/200% layouts. Measure contrast on real foreground/background pairs. No idle animation CPU regression, hidden focus or inaccessible status color.

**Checkpoint:** WX-07 visual evidence, token decisions and performance observations. A stylesheet diff alone is not visual verification.

### W08 — Let the human answer actual agent requests

**Read:** S05; pinned engine request/reply endpoints/events, Studio pending-input handling, runtime ownership and existing attention service.

**Execute:** Persist structured native approval/clarification requests with stable ID, project/thread/turn, permitted reply schema, displayed question/action, expiry/status and acknowledgement. Build the answer controls and send through the actual supported authenticated protocol. Keep reply controls distinct from the ordinary composer. Reconnect restores pending questions; project switches do not redirect answers.

Remove any advice that treats a broader permission profile as a workaround for a waiting approval. Reuse existing explicit Full Access choices for ordinary work. If the installed engine lacks a required reply route, investigate the real contract within the three-attempt rule, then document the precise gap. Do not claim an ordinary prompt answered it or that another client can attach without proving the ownership path.

**Acceptance:** Native/fixture request round trip, rejected or expired answer, duplicate click, lost acknowledgement, reconnect and concurrent request IDs. “Delivered” requires an acknowledgement. Dismissing UI does not approve. Text drafts survive. Complete independent display/state work if a native reply capability blocks final verification.

**Checkpoint:** WX-08 actual route/evidence and a reusable structured request surface for Needs the Human.

### W09 — Make watching and communicating with agents enjoyable

**Read:** S05; W08 requests, agent/goal/fleet surfaces, task controller, timeline and qualified steering support.

**Execute:** Add a real current-work strip, expandable tool cards with bounded output and artifact access, durations/results, turn dividers, error/attention markers, parent-child/filter views, unread activity and jump-to-latest. Do not invent hidden thoughts, percentage completion or decorative agent activity.

Provide **Send after this turn** as a visible editable/cancellable queue entry with immutable original target identity. Add **Steer this run** only for a qualified native route and label its actual semantics. A half-written ordinary draft never auto-sends at turn end. Coordinate manual messages with the existing task scheduler so two owners cannot dispatch competing work. Pause/resume and permission/budget checks apply before sending.

**Acceptance:** Completion during typing, cancellation at dispatch boundary, thread/project switch, reconnect, uncertain send, paused queue and child-agent cases. Exactly one dispatcher controls the workspace; queued and delivered are distinct; no accidental spend from browsing activity. Windows notifications are quiet/deduplicated under existing settings.

**Checkpoint:** WX-08 message-intention contract, event provenance and actual Studio walkthrough.

### W10 — Put honest usage and controls in the slim dashboard

**Read:** S03/S07; cost ledger/rate revisions, usage normalization, request/turn relationships, budgets and native activity state.

**Execute:** Build the compact HUD with project/thread, actual running/waiting/disconnected state, elapsed time, requested/effective model where available, cost and input/output/cache usage with explicit scope. Put detailed breakdowns in a drawer. Unknown usage is unknown and unpriced is not zero; no fictional live token counter.

Verify late receipts update the originating task, duplicate events do not double-charge, child totals aren't counted twice and historical rates remain historical. Preserve existing user-set budget logic. Expose a reusable pre-dispatch gate for normal sends, continuations and Prompt Runner; do not introduce a default small spending cap for ordinary work. Explain in-flight limits accurately and pause an enabled currency gate when enforcement is impossible due to unknown data.

**Acceptance:** Usage fixtures cover cache hit/miss, inclusive reasoning/output, missing price, parent/child totals, delayed updates, duplicate replay and scope changes. HUD controls work at 200%. Browsing the dashboard causes no provider call; configured gates block the actual dispatch path.

**Checkpoint:** WX-09 cost provenance/coverage and focused mathematical/dispatch tests.

### W11 — Add everyday composition, navigation and review conveniences

**Read:** S05; existing favorites/history, search, file-context/attachment capability, copy/export and changes views.

**Execute:** Preserve implemented conveniences and fill demonstrated gaps: recoverable draft history; favorites/templates inserted deliberately; local transcript search with reachable old matches; copy answer/code/path; shortcut reference; safe reveal/open links; useful empty/errors; clear context size preview and qualified file references/attachments. Keep potentially sensitive prompt history local under current privacy controls.

File selection must clearly distinguish a reference path, included content and an engine-accepted attachment. Qualify the actual route before enabling it. Do not silently send an entire directory, treat a path as an upload, or route missing attachment support through an invented API. Preserve Changed Files review and export already delivered. Avoid eager heavy-editor loads for small conveniences.

**Acceptance:** No wrong-project insertion; cancellation preserves draft; supported attachment context is shown accurately; invalid/outside-root/reparse cases follow the existing policy; links cannot cross IPC/renderer privilege boundaries. Keyboard, large text and error/cancel states work. Local lookup/copy/search adds no inference.

**Checkpoint:** WX-10 before/after workflow evidence and any concrete unsupported capability still open.

### W12 — Apply the approved Mona icon across Windows

**Read:** S04/S09; approved local artwork, current asset pipeline, executable/package metadata, app identity and installer shortcuts.

**Execute:** Locate the approved Mona M source. Preserve the original. Use deterministic tools to produce the required `.ico` resolutions and package image sizes appropriate to the existing build system. Check small-size readability, alpha edges, tile padding and dark/light presentation. Apply to window/executable, taskbar, Start shortcut, installer and supported Explorer surfaces.

Keep stable app/package identifiers. Verify new install and upgrade behavior rather than renaming identities to defeat icon caching. No global shell/cache reset or Explorer restart without a necessary explicit action. If the source asset is absent, record exactly which file is needed and complete independent pipeline work without inventing a replacement logo.

**Acceptance:** Inspect installed icons at small/large sizes and high DPI; the packaged binary carries the correct artwork; shortcuts bind the intended executable/app identity; no stretched, white-matted or missing images.

**Checkpoint:** WX-11 asset provenance, generated sizes and actual installed captures; preserve any missing-source blocker.

### W13 — Define Prompt Runner ownership and result contracts

**Read:** S06; actual board/task states, persistent problem ledger, engine submissions, new-thread route and scheduler ownership.

**Execute:** Extend the current architecture with the smallest necessary runner service/schema. Define durable run/task/dispatch/thread/turn/request/problem identities, lifecycle states, frozen plan revision, operation keys, counters and ownership. Keep queue state in the main process, separate from UI selection and developer build state. Reuse existing task transitions and completion gate. A run/dispatch receipt marked successful after send must not be mistaken for task success.

Implement a bounded versioned result report: identities and prompt hash; disposition (`ready_for_verification`, `needs_continuation`, `blocked`, `needs_human`); work summary; acceptance/evidence with provenance; problems/attempts/questions; next action. Prefer an existing qualified reporting tool, otherwise assign an atomic JSON file in a controlled project-local location. Bind its agent-known dispatch ID to engine-observed turn identity in Mona. Agent data cannot execute verifier commands or change the run scope.

Use Windows-safe assigned paths, schema/size/identity validation and workspace containment including reparse/alias handling. Note that a Full Access agent can write files; this reporting protocol is not an OS sandbox or proof of correct reasoning.

**Acceptance:** State/schema tests reject stale/mismatched/partial reports and distinguish acceptance, turn completion and evidence verification. Migration/backup approach preserves existing project state. No new paid orchestration layer.

**Checkpoint:** WX-12 contract and decision note; portable scheduling logic with Windows integrations at existing boundaries.

### W14 — Import numbered prompt files into a clear, inert plan

**Read:** S06; W13 schema, existing plan importer, Markdown parser and task dependency UI.

**Execute:** Add **Run prompt file…**, selecting a local Markdown file and previewing exact task text, shared instructions, IDs, titles, criteria, hashes and dependencies. Support the original P file, the Studio R file if supplied, and this W file. Ignore code-fence examples and ordinary numbered lists. A heading in the startup instructions is not a task. Parse locally; offer explicit mapping/manifest edits for ambiguous inputs.

Flag duplicate IDs, cycles, unresolved prerequisites, gaps and order ambiguity. Preserve authored dependencies; otherwise propose visible predecessor dependencies. Selection is a finite set/range. Outside-selection prerequisites need existing verified evidence. Imported completed labels are informational until reconciled. Reimport/source revision must not reset completed work or attempts. Freeze the approved plan; changed files trigger boundary review rather than silently altering future work.

**Acceptance:** Real-file fixtures and synthetic cases cover headings in fenced code, multiple prefixes, shared rules, Unicode/spaced paths, missing dependencies and reimports. Preview text matches what will be submitted. Importing/selecting does not create a thread, invoke a model or execute imported instructions.

**Checkpoint:** WX-12 parser/manifest contract, exact preview screenshots and accepted source-format limitations.

### W15 — Run the selected sequence automatically and durably

**Read:** S06/S07; W13/W14 contracts, W05 fresh-thread action, W10 cost gate, adapter recovery and work controller.

**Execute:** Implement one main-process advancement owner using the existing scheduler. Before each dispatch, reconcile uncertainty and recheck immutable workspace/task/plan identity, dependencies, blockers, revision, stop flags, maintenance and budget. Persist fresh-thread intent, obtain its qualified receipt, persist the exact generated prompt/operation intent, then submit once to that thread. Hold the workspace boundary through actual work and settlement.

Observe engine events and validate a matching report before proposing completion. Commit verified task state and the next decision before another task begins. Continue unfinished work within its current task/thread; create a fresh conversation between tasks. Include only stable shared instructions, exact current task, relevant requirements and concise durable handoff, not all transcripts or every prompt. Use the template in section 6.

Implement bounded continuation, default three automatic follow-up turns per task, configurable at launch, separate from three no-progress attempts. At most one report-repair follow-up counts within that allowance. Never infer completion from final-text wording, inactivity, disconnect or a successful send. Unknown outcome reconciles read-only; no blind retry with a new key. A new session cannot replenish counters.

**Acceptance:** Fake runtime proves three prompts run in order in distinct threads, with one accepted send per dispatch and no extra task afterward. Duplicate events, double Start, response loss, concurrent UI/manual dispatch and restart do not duplicate work. A busy native workflow or uncertain active turn prevents another mutating task.

**Checkpoint:** WX-12 transition traces and durable submission/recovery evidence. Do not launch the real development sequence with this runner until W18 qualifies it.

### W16 — Gate progress on evidence and collect Needs the Human

**Read:** S05/S06; existing acceptance/fingerprint gate, attempt/reopen operations and W08 native requests.

**Execute:** Build **Needs the Human** as durable structured records: task/thread, exact question, why needed, affected dependencies, evidence, options/recommendation, status and answer history. Separate advisory questions, task blockers, human-only checks, uncertain operations and active native approvals. Native replies use actual request identity/acknowledgement; advisory answers become scoped durable context.

Apply the existing verification gate to each report, recording observed checks versus agent claims versus human observations. Only preauthorized verifiers may run; never execute arbitrary JSON command strings. Keep human-only acceptance incomplete. Reconcile evidence fingerprints so later intentional shared-file edits mark affected claims stale without endlessly rerunning all previous tasks.

Preserve stable problem counts across tasks/restart/reimport. Reopen only on material evidence or a human decision; keep history. Full Access/model-internal reasoning is not fully observable, so enforce reported attempts and controller limits without claiming perfect semantic detection. A blocked task blocks dependents; independent work requires a suitable workspace and settled prior mutation. No automatic stash/reset to make it suitable.

**Acceptance:** Third no-progress attempt, dependent/independent branches, stale evidence, native request still holding a turn, malformed report, human-only check, expired/duplicate answer and explicit skip all have correct outcomes. Unanswered required work is never complete. Reports distinguish all verified from finished with blockers.

**Checkpoint:** WX-13 inbox and completion provenance, actual state transitions and unresolved engine reply limits.

### W17 — Integrate the runner into Studio and Windows lifecycle

**Read:** S06/S07/S08; Focus/HUD, human inbox, manual messages, notifications, process supervisor and native power/quit behavior.

**Execute:** Add task ID/title, sequence position, completed/blocked counts, real activity, elapsed time, cost/coverage and Needs the Human count to the slim HUD. Let the user open prior task conversations without redirecting work. Auto-follow is optional; scrolling/typing remains under user control. Apply Aurora styling with text/icons and reduced motion.

Provide distinct Pause after task, Interrupt now, Cancel remaining, Resume and Review results actions. Main-process gates handle completion races; cancel remaining does not promise rollback or stop an active turn. Manual follow-up/steering cannot silently become another task or bypass the scheduler. Gate every continuation/report repair with the same user-set budget; no free/zero assumptions from missing usage.

Make minimize/close/quit/lock/sleep/relaunch behavior explicit. By default restart recovers state and waits for Resume before new spending. Support an explicit keep-awake option scoped to the active run through the qualified native mechanism, released on pause/end. No scheduled task/service, global sleep-policy change or promise to survive logout/forced shutdown. Updates/restores must not race active writers.

**Acceptance:** Native Windows/fixture tests cover stop races, view/thread switches, minimize/restore, sleep recovery, close confirmation, power-request cleanup and late usage. UI operations make zero inference calls. Keyboard/fullscreen/200% layouts retain the controls.

**Checkpoint:** WX-14 lifecycle/action semantics, actual UI captures and precise platform limits.

### W18 — Qualify Prompt Runner failures and document its use

**Read:** S06/S08; all runner tests, engine replay/ownership and restore/update gates.

**Execute:** Use the existing fake engine for a bounded failure matrix: crash before send, after possible acceptance, after result persistence and before next-task dispatch; duplicate terminal events; source edit; missing/malformed/stale result; output uncertainty; exhausted continuation; third no-progress attempt; approval wait; blocked dependency plus independent task; disk-full/locked-file checkpoint; budget gate; two app instances; active-run upgrade/restore.

Prepare a disposable three-task example with simple harmless file writes, explicit dependencies, result reporting and a separate human-only check. Qualify through the packaged/native app. Any paid live smoke uses remaining explicit budget and a known route; fixtures cover the broad matrix. Do not use the entire real review sequence as an unattended smoke test.

Document file format, preview, selection/dependencies, fresh-session handoff, starting/resuming, human inbox, cost/continuation limits, closing/sleep and recovery. Generate a deterministic end-of-run Markdown report with evidence, open questions and usage coverage. Include a small example file and state how already-completed work is reconciled.

**Acceptance:** Every matrix row has evidence or a precise blocker; no duplicate model effects, lost attempts or false task completion. Runner tests work without development-only paths in the recipient package. The feature is not called fully qualified if native/reply tests remain unavailable.

**Checkpoint:** WX-12/WX-13/WX-14 qualification and usable guide; authorize future real queues only through the user's explicit selection/start action.

### W19 — Profile memory and repair demonstrated performance problems

**Read:** S07; D-0104/current performance decisions, original targets and release measurement harness.

**Execute:** Local heap/process profiling is part of this improvement assignment. Reproduce representative release/packaged startup, idle, long history, opened/closed editor, terminal and repeated project switching on a documented reference machine. Record total Mona processes and engine separately with raw bytes, metric definition and MB/MiB units. Reconcile the reported 406.4 MB against the original under-350-MiB target before comparing; do not quietly change the target or mark a deviation accepted.

Use profiles to fix measurable causes: eager Monaco/PTY/dependency loading, retained histories/DOM/listeners, duplicate subscriptions/caches, unbounded queues, leaked windows/processes or costly decoration. Keep data private and profiles out of Git. Do not hide history, disable isolation, omit a process or replace the platform to meet a number. Profile only as needed; avoid an optimization rewrite without evidence.

**Acceptance:** Comparable before/after measurements and relevant regression checks; no loss of features, accessibility or inference parity. Report current target pass/miss with practical remaining options. If still above target, retain the performance criterion open pending repair or an explicit release exception. CPU and long-history interaction are also measured.

**Checkpoint:** WX-15 reproducible method/results, source/artifact identity and any unresolved D-0104 decision. Repeat final measurements only if later changes materially affect them.

### W20 — Complete Windows accessibility and real scaling checks

**Read:** S08; current accessible components, shortcut map, prior MONA-028 gaps and human checklist.

**Execute:** Run automated accessibility and keyboard checks, then a real Narrator walkthrough through Home, Studio, command suggestions, focus/fullscreen, tools/history, Needs the Human, queued messages, Prompt Runner and essential settings. Announce meaningful status changes without token-by-token noise. Verify labels, relationships, focus order/return, listbox selection, dialog traps and terminal/editor escape routes.

Test actual Windows 200% display scaling plus text enlargement and contrast themes. Move between different-DPI monitors and disconnect/reconnect a display when hardware permits. Keep browser zoom as additional evidence only. Confirm viewport/HUD/composer resize without losing actions or changing task identity. Exercise IME and composition under the actual submit shortcut.

**Acceptance:** Required native/human observations have real evidence; otherwise retain exact unverified criteria and a short checklist with expected results. Do not claim Narrator passed from DOM attributes or physical DPI passed from emulated zoom. Fix observed defects and rerun affected paths.

**Checkpoint:** WX-16 and original MONA-028 traceability, observed configuration, outstanding human tests and accessible screenshots where relevant.

### W21 — Reconcile regressions and evidence against final source

**Read:** S01/S08/S10; W findings/changes, original requirement ledger, actual CI entrypoints and security boundaries.

**Execute:** Run the repository-required format/lint/type/build/tests/native checks appropriate to the settled candidate. Fix causal regressions and distinguish preexisting failures honestly. Test IPC sender/schema validation, renderer isolation, unsafe Markdown/links, path traversal/reparse aliases, imported prompt instructions, ownership and all-writer restore gates affected by this pass. Don't broaden trust or disable failing checks.

Verify every original view still persists and every delivered Core feature remains accessible. Review requirement/evidence hashes affected by new bytes; rerun relevant checks instead of laundering historical evidence through updated hashes. Use current ledger tools to validate both original and subordinate state. Resolve scaffold/formatting/scanner fixture noise narrowly with provenance.

Recheck zero-inference UI behavior and provider route preservation. Where context/adapter/orchestration changed, use deterministic request captures and, only within remaining authorized budget, the existing cost benchmark protocol. Fresh-thread behavior should be measured honestly rather than sold as guaranteed savings. An unavailable network lookup is not evidence of no upstream change.

**Acceptance:** Required checks on the actual candidate pass or remain explicit release blockers. No claimed Windows-native result is supported only by a foreign host/mock. Original and enhancement ledgers agree about completed, stale, partial and blocked work.

**Checkpoint:** WX-01 regression/economics/security evidence summary with exact source identity. Later code changes invalidate only relevant evidence and require the corresponding final check.

### W22 — Resolve modern Explorer menu and trust honestly

**Read:** S09; original MONA-027, native helper, package identity/manifests/signing pipeline, actual install error events and current Microsoft primary documentation.

**Execute:** Inspect modern folder/folder-background registration and its relationship to installed executable location, COM/helper architecture and identity. Preserve a small helper that passes selected paths as data and never does inference/network work in Explorer. Test path quoting, Unicode, aliases, second launch and startup failure without hanging the shell.

Diagnose `0x800B0109` against actual signing chain, package publisher, trust context and registration method. Do not assume Developer Mode fixes certificate trust. Keep classic-menu fallback usable and honestly labeled while modern qualification remains open. Prepare the exact package, public certificate identity/fingerprint, store/scope/removal plan and remaining prerequisite before asking for any trust decision. Use existing explicit authorization if it exists; otherwise no silent certificate-store changes, security bypass or key export.

Qualify the selected test or production route on a genuinely clean Windows environment. Existing authorized production credentials may be used through the secured build path; unavailable enrollment/certificate/license decisions remain human prerequisites. No purchases or public uploads.

**Acceptance:** Modern-menu invocation is observed under the declared trust state. Test trust is not production distribution. Failed trust/registration remains MONA-027 blocked; classic success does not close it. Installer/uninstaller remove only their own registration.

**Checkpoint:** WX-17 exact native/trust evidence and the smallest actionable human prerequisite, with all independent engineering work complete.

### W23 — Produce an installer that a recipient can use

**Read:** S09; current installer, dependency packaging, license/notices, update/restore ownership and W21 evidence.

**Execute:** Improve the existing distribution path into one clearly identified installable entry file rather than a collection of developer scripts. Preserve per-user defaults and the current signed-package architecture. Bundle or securely bootstrap qualified required runtime components so recipients need no Node, compiler or source checkout. Explain any required internet step; preserve external Codewhale config/history and let the recipient supply their own credentials.

Qualify clean native Windows environment/user installation, launch from Start, project selection, Explorer launch, repair if supported, upgrade from the earlier candidate, active-work deferral, error rollback and uninstall. Check missing dependencies, locked files, non-admin use, Unicode/spaced install/user paths and absent developer tools. Distinguish a new destination folder from a clean system/trust store.

Keep generated builds free of developer credentials, projects/transcripts, private keys and machine-specific secrets. Verify notices and redistribution terms against actual dependencies. Do not choose the deliberately unselected license. Test retaining projects/history by default and removing only Mona-owned files/registrations. Provide clear first-run route/key/profile setup with no forced provider switch.

**Acceptance:** Local/test candidate has a demonstrable recipient installation path and lifecycle evidence on its actual bytes. W22 signing/trust or licensing gaps remain explicit release gates; do not call an untrusted package frictionless friend-ready distribution. Installer work can complete without pretending those external decisions are made.

**Checkpoint:** WX-18 exact installer filename, architecture, dependency/network story, lifecycle results and unresolved distribution prerequisites.

### W24 — Qualify the packaged candidate and release claims

**Read:** S07/S08/S09; W19/W20 performance/accessibility evidence, W21 regression results and W22/W23 packaging/trust disposition.

**Execute:** Measure cold and warm interactive startup on the actual installed artifact, distinguishing UI readiness from engine/provider start. Include Explorer activation and reopening an existing project. Record multiple samples and method; don't reuse the old development-harness figures as packaged timing. Measure total app idle memory/CPU and representative interaction with correct scope and units.

Exercise installed Ctrl+Enter, save dialog, command autocomplete, real `/new`, focus/fullscreen, long history, pending request reply, manual follow-up and tiny Prompt Runner/recovery sequence. Use fixtures for exhaustive failure paths and only authorized bounded live tasks. Verify normal quit leaves no owned orphan descendants.

Generate final provenance, compatibility manifest and checksums after signing if signing is available. Ensure tested artifact matches recorded source/lockfile and signatures. Evaluate clean recipient trust, modern menu, Narrator/physical DPI, target misses and license decision separately. Packaged tests may proceed while those external gates remain blocked; release status must retain them.

**Acceptance:** Actual packaged timings/workflows and artifact identity are recorded. A development smoke or a source checkout is not substituted. Signed-distribution readiness is claimed only for the final validated package and resolved mandatory gates; full 1.0 still requires the original complete scope.

**Checkpoint:** WX-15/WX-18 release gate matrix, final artifact path/hash and precise remaining actions.

### W25 — Leave a complete, honest handoff

**Read:** S10; all original/enhancement states, evidence, human requests, final candidate and remaining blockers.

**Execute:** Reconcile all W00–W24 dispositions and affected original requirements. Retain incomplete acceptance and attempt history. Update README, user/developer guides, shortcuts, costs, Prompt Runner examples, release notes, compatibility, migration/rollback, install/uninstall and notices to describe the actual product. Use Needs the Human consistently in new UI/report templates.

Give the human a short ordered review inbox: decision/check, why needed, affected feature/release claim, prepared artifact/evidence, and exact next action. Do not bury required trust, memory exception, Narrator/DPI or license choices in a generic “polish” list. Distinguish completed engineering, still-blocked capability and unavailable human/credential evidence.

Record the final source revision, engine/platform, installer filename/hash, measurement scope, remaining decisions and next eligible work. Run final ledger validation. Commit coherently under repository rules, without invented remotes or unsolicited publication. Do not begin unrelated later-scope features.

**Acceptance:** Every task accounted for; docs match behavior; no falsely green requirement; no leaked secrets; the next session can resume without rediscovering context. A closure prompt may finish with an accurate blocked-task report; it does not mark the blocked tasks complete.

**Report:** What improved; how to use it; what was actually tested; cost behavior/limitations; what file can currently be installed/shared and its trust status; what Needs the Human; next exact action.

## 5. Minimal durable records

Use existing schemas/tools wherever possible. The following fields are requirements, not permission to create a second competing database:

- Task: W ID, status, dependencies, spec/source hashes, acceptance completed/open, original and WX IDs, evidence path/provenance, problems and next action.
- Problem: stable ID, symptom, affected criteria, hypothesis/result history, total/no-progress counts, material-progress evidence, help needed and reopen reason.
- Evidence: source/build identity, platform, command/observation, result, artifact hash/reference, scope, timestamp and whether observed, agent-reported or human-observed.
- Handoff: current task, last verified change, remaining exact step, relevant files, unresolved attempts, human prerequisites and next eligible tasks.

Keep structured state atomic and revision-checked; keep handoffs short. Document routine source changes through coherent checkpoints rather than rewriting every ledger after every shell command. State reports contain no credentials or private chat dumps.

## 6. Generated Prompt Runner task instruction

Implement an equivalent template with validated fields. This is **runtime task input**, not a request for the builder to launch a real queue now. Preview the actual submitted content. Paths and imported text are data, never shell substitutions.

```text
You are executing {task_id}: {task_title} in {workspace} for an authorized
Mona Prompt Runner sequence. This assignment is only this task. Mona will
select subsequent tasks after your result is verified.

Read applicable project instructions and the bounded handoff below.
Preserve existing work, decisions and persistent problem/attempt counts.
Complete this task's implementation, required verification, documentation
and checkpoint before reporting. Use the already authorized tools/route.

After three attempts on the same problem without material progress, stop
that problem. Record the approaches, results, evidence and exact help
needed from the human. Do not rename the issue, weaken requirements or
architect around it. Complete independent work within this assignment
when possible. Keep blocked/human-only acceptance incomplete.

Before ending, atomically write the result to {assigned_result_path}
according to {schema_reference}, using the supplied run/task/dispatch
IDs and prompt hash. Report evidence provenance honestly. If unfinished,
give the next exact action. Put human questions under Needs the Human.
Do not start another task, execute /new, change the queue or claim that
ending a turn proves this task is complete.

Shared contract:
{selected_global_contract}

Durable handoff, decisions and unresolved attempt counts:
{bounded_handoff}

Exact selected task and acceptance criteria:
{selected_task_text}
```

## 7. End-of-run report template

```text
Windows improvement run: [completed / partial / blocked]
Source / engine / Windows build:
Completed W prompts and principal user-facing changes:
Validation: [focused / integrated / native / installed / human]
Performance: [metric, units, app scope, engine separate, artifact]
Economics: [zero-inference checks, usage coverage, remaining limits]
Installable artifact: [exact path, hash, signing/trust status]
Needs the Human: [decision/check → affected requirement → next action]
Unfinished tasks and persistent attempts:
Handoff / next eligible prompt:
```
