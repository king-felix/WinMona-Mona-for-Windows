# W01 — Lossless drafts, async navigation and Ctrl+Enter

Executed 2026-11-14 on the reference machine at HEAD `c1c91387` + this change set.
Requirement: WX-02. Original criteria affected: MONA-007 (drafts and submission), MONA-016
(duplicate suppression and uncertain-submission reconciliation).

## What was reproduced before anything was changed

Four defects were found by reading this checkout, not inferred from the Mac report:

1. **An accepted send destroyed newer text.** `StudioPanel.tsx` captured `text` before awaiting
   (correct), but on success called `onDraftSent()` with no argument, and `App.tsx` cleared the
   composer unconditionally. Typing during the round trip was lost and the empty draft was
   persisted over it.
2. **A late project selection could win.** `activateProject` awaited a draft save and then
   `selectProject`, committing `setSelected`/`setUi`/`setSessionId`/`setDraftText` with no request
   identity. Clicking A then B let A's later reply replace B. `loadSpend` and `loadBriefing`
   assigned unconditionally too.
3. **`New session` did not flush the pending draft.** `changeScreen` flushed; `newSession` did not,
   so up to 350 ms of typing was dropped on the session it belonged to.
4. **Nothing prevented a duplicate paid send.** `studio-service.ts` checked the run state, then
   awaited the budget evaluation, then committed `preparing`, and passed **no** `operationKey` to
   `adapter.submitTurn` — so the adapter minted a fresh key per call and its journal could not
   dedupe. A second invoke arriving during the budget await sent the prompt twice.

Also found and fixed while in the file: a draft save failure was dropped silently, and no
`isComposing`/`event.repeat` guard existed on the composer shortcut (Ctrl+Enter itself was already
correct, and plain Enter was already a newline).

Each fix was checked by disabling it and watching the new test fail:

- `nav guard removed → `drops a late project selection…` fails with `expected 'alpha' to contain 'beta'`;
- revision guard removed → `clears only the accepted prompt…` fails with `expected '' to be 'Second thoughts'`;
- `preparing` removed from the run-state refusal → `accepts exactly one dispatch when two submits overlap` fails with `expected [ true, true ] to have a length of 1`;
- save chain removed → `keeps two draft saves in order…` fails with `expected [ 'A', 'AB' ] to deeply equal [ 'A' ]`.

## What changed

- `apps/desktop/src/renderer/App.tsx`
  - `onDraftSent({projectId, sessionId, text})` compares the accepted revision with the live
    composer (`draftRef`) and only then clears it and persists the empty draft. Text typed during
    the round trip, and any other project's draft, survives.
  - `navGeneration` counter: `activateProject` and `newSession` capture a generation and drop their
    result if a later selection has claimed the shell; `loadSpend`/`loadBriefing`/`persistDraft`
    accept the generation and skip a stale assignment.
  - `persistDraft` serialises every write for one `project:session`, so two saves cannot arrive out
    of order: an older save cannot land on top of newer text and then call it saved. `flushDraft`
    reads the live text through a ref, reports a failed save as a notice instead of dropping it, and
    routes through `persistDraft`.
  - `newSession` flushes the pending draft first.
- `apps/desktop/src/renderer/StudioPanel.tsx`
  - `submittingRef` single-flight latch (state updates are asynchronous; a same-tick second press
    used to pass).
  - Ctrl+Enter respects `isComposing` and `keyCode 229` (older Windows IME paths), ignores
    `event.repeat`, and still routes through the same `canSubmit` gate as the button.
  - References are cleared only when they are the ones that were sent.
- `apps/desktop/src/main/studio-service.ts`
  - the dispatch slot is claimed in the same tick as the guard (`preparing` is now written before
    the budget await); every refusal path restores the previous run state through one `release()`.
  - `submitTurn` receives `operationKey: newOperationKey('turn')`, so an uncertain outcome
    reconciles against the accepted dispatch instead of minting a second key.
- New live probe `apps/desktop/src/main/composer-probe.ts` + `apps/desktop/scripts/composer.mjs`
  (`npm run composer`), wired as `--composer-probe`.

## Verification

- `npm test` → **584 Vitest tests in 70 files**, plus 11 bootstrap, 26 launch, 12 assets, 29 install
  and 8 spike tests, all passing. New coverage:
  - `App.test.tsx`: clears only the accepted prompt; keeps the draft on a rejected send; drops a
    late project selection; submits once on Ctrl+Enter with composition and repeat ignored; flushes
    before `New session`; keeps two saves in order; restores a saved non-Studio section after
    restart.
  - `studio-service.test.ts`: two overlapping submits accept exactly one dispatch, open one thread,
    and carry a journal `operationKey`.
  - `tests/bootstrap/windows-review.test.mjs`: 5 cases for the review ledger gate.
  - The renderer harness now unmounts every root in `afterEach`; a failed test previously left a
    350 ms debounce timer alive that wrote into the next test's bridge. That was a real
    cross-test leak, found while proving the send/typing test.
- `npm run composer` → **9/9 steps** in a real Electron window, keys pressed through
  `webContents.sendInputEvent` (Electron's own input path), two screenshots
  (`docs/evidence/shots-w01/composer-plain-enter.png`, `composer-ctrl-enter.png`):
  plain Enter inserts a newline; Ctrl+Enter inserts none and sends nothing without a connected
  runtime; an IME-composition Enter is not consumed; a held Ctrl+Enter is one shortcut.
- `node tools/build/windows-review.mjs validate` and `node tools/build/cli.mjs validate` → OK.

## Limits this evidence does not cross

- **A physical IME composition was not exercised.** Chromium refuses to be driven into composing
  state from the main process, so the composition case is a `KeyboardEvent` with `isComposing: true`
  dispatched into the real page. The probe records this limitation itself. A person typing with a
  real IME remains a human check.
- No live provider turn was run for this prompt (zero spend), so the "exactly one accepted turn"
  guarantee is proven against the fake adapter and the service's own state machine, not against a
  billed runtime. The operationKey path is the same one the P03 live smoke qualified.
- The draft store still keeps 20 sessions per project and 200 000 characters per draft; older
  sessions are dropped by that bound, which is unchanged and visible in `ui-state.ts`.

## Unrelated finding repaired to keep the gate honest

`packages/adapter/src/supervisor.test.ts` was failing on this machine: its fake runtime crashed at
2 500 ms, while readiness (node spawn + first successful health probe) now measures 2 821–2 948 ms
across three runs. The fixture's crash timer is now 6 000 ms. Every assertion in that test —
bounded restarts, three unexpected exits, `restart_exhausted` — is unchanged; only the setup delay
moved. Recorded as D-0119.
