# Mona build handoff

**Read this first: there are two ledgers now.** The original P00–P23 sequence is complete
(`.mona/build/state.json`, revision 83). The Windows improvement supplement W00–W25 is a separate,
validated id space (D-0116) with its own state at `.mona/build/reviews/windows-v2/state.json`,
written by `tools/build/windows-review.mjs` (D-0120). This session executed **W00, W01, W02, W03 and W04**;
they are `completed` there and `W05` is the next eligible prompt.

Verify before trusting this file:

```text
node tools/build/cli.mjs validate          # original ledger: OK, 0 warnings
node tools/build/windows-review.mjs status # review ledger: 5 completed, current W04
npm run ci                                  # format, lint, typecheck, 591 vitest in 70 files, node --test suites, build
```

## The Windows prompts completed this session

- **W00 — baseline.** HEAD `c1c91387`, engine `codewhale 0.10.2 (ff466b2ed0bf)`, Windows 11 Pro
  10.0.26200, installed candidate 1 695 files with `Status: Ok`. Each suspected Mac parallel was
  classified against this checkout before any edit (`docs/evidence/W00-baseline.md`). The only
  pre-existing gate failure was `prettier --check AGENTS.md`, repaired as formatting only.
- **W01 — drafts, navigation, submit.** An accepted send no longer destroys text typed while the
  runtime was answering; a late project selection/spend/briefing reply can no longer overwrite the
  newer one; `New session` flushes the pending draft; draft saves are serialised per session (an
  older save cannot land last); a failed save is reported. The studio claims its dispatch slot
  before the budget await and passes a journal `operationKey`, so two overlapping submits accept
  exactly one turn. Ctrl+Enter ignores IME composition and key repeat. Every guard was proved by
  disabling it and watching its test fail. `npm run composer` = 9/9 steps in a real window.
- **W02 — state integrity.** A replacement project import now clears every row the replaced project
  owns (30 tables, child-first) and takes a verified pre-import backup, while other projects and
  global tables survive. Restore refuses a newer-schema backup, retries a briefly locked rename,
  and no longer hides which database is live after a failed reopen. Export is qualified for Unicode
  and spaced destinations, existing files, unwritable destinations and cancel; the renderer cannot
  choose the path (strict IPC schema).

- **W03 — history and stream identity.** Stored history is a windowed read: the studio opens on the
  newest 500 rows of a thread, holds at most 2 000 in renderer state, renders 120, pages older rows
  by `beforeSeq`, searches stored text locally, and exports every row in bounded chunks. Prepending
  an older page keeps the reader's scroll anchor; follow-scroll stops when the reader scrolls away.
  Deltas are keyed by thread/turn/item, an id-less stream is adopted by its completion instead of
  duplicating the card, late frames are counted and dropped, and a stream that resumes past missing
  frames closes the answer as `interrupted`. Every push carries its thread, so Plan and Work cannot
  merge. A real Windows window holding 10 000 stored rows opened at seq 9881-10000 with
  `hasOlder: true` (`docs/evidence/W03-history.json`).

- **W04 — command catalog and autocomplete.** The catalog is the pinned engine's own registry
  (`GET /v1/commands`, 109 commands, 97 aliases, captured with engine version/commit/binary hash)
  plus a curated cost/side-effect/route classification; a coverage fixture reconciles both
  directions and the generator refuses gaps. Typing `/` at a command position opens a locally
  filtered, keyboard-operable list with descriptions, usage, cost and route badges; paths, code,
  quotes and `\/` stay literal; a recognized command, an ambiguous prefix or a missing argument is
  explained and never sent. 12 real-window steps pass (`docs/evidence/W04-slash.json`).

## Open items that this session did not close

1. **Project import still has no product surface.** `importProject` is correct and tested but no
   channel, dialog or menu calls it. Importing a project file is not something a person can do.
2. **Conversation history beyond 500 rows is unreachable.** Closed by W03: the initial window is the
   newest page, older rows are paged by cursor, stored text is searchable, and export walks every row.
3. **A physical IME composition is a human check.** Chromium cannot be driven into composing state
   from the main process; the composer probe records that limitation itself.
4. Human/signing gates are unchanged: the modern Explorer menu has never been seen by a person
   (MONA-027 / W22), Narrator and physical 200 % scaling (MONA-028 / W20), the real Save dialog
   click, and the license decision. Memory stays accepted for 0.1.0 by D-0111 with the 350 MB
   target unchanged and unmet.

## Decisions added this session

- **D-0119** — the supervisor restart test's crash timer moved from 2 500 to 6 000 ms because
  readiness now measures 2 821–2 948 ms; no assertion changed.
- **D-0120** — the W00–W25 review keeps its own revision-checked ledger; the original P00–P23
  validator is untouched and the review utility is developer tooling only.

## Standing authorization

D-0118: commit verified work and push to `origin main` as the closing step of a turn that changed
files. The remote is public, so the push is gated on `node tools/build/cli.mjs validate` (secret
scan included) and on a green `npm run ci`.

## Last pushed commit

Recorded in the end-of-turn report. Verify with `git ls-remote origin refs/heads/main` against
local `HEAD`; do not trust a remembered SHA.
