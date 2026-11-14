# Mona build handoff

**Read this first: there are two ledgers.** The original P00–P23 sequence is complete
(`.mona/build/state.json`, revision 83). The Windows supplement W00–W25 is a separate, validated id
space (D-0116) with its own state at `.mona/build/reviews/windows-v2/state.json`, written by
`tools/build/windows-review.mjs` (D-0120).

This session finished **W06's live observation** (now `verifying`), implemented and qualified
**W08** (`verifying`), and completed **W10** and **W11**. Next eligible prompt: **W12**.

Verify before trusting this file:

```text
node tools/build/cli.mjs validate           # original ledger: OK, 0 warnings
node tools/build/windows-review.mjs status  # review ledger: 8 completed, 2 verifying
npm run ci                                  # format, lint, typecheck, 705 vitest in 76 files, node --test suites, build
npm run check:build -w @mona/desktop        # 90 named preload channels, no engine route in the bundle
```

## What this session delivered

- **W06 — Focus and native fullscreen during a live turn (verifying).** `npm run focus:live` submits
  one bounded prompt on the configured route and repeats Focus, native fullscreen, F11 out/in, a Term
  drawer held across a transition and minimize/restore while the engine's own frames arrive: 21 steps,
  4 screenshots, `$0.0006`, `turnCount 1`, thread id unchanged, typed draft never sent and still in
  the composer. The probe waits for the run's first output before it touches the window, so the
  transitions overlap real work rather than the model's thinking gap; per-transition work arrival is
  recorded in `windows[]`, including the windows that gained nothing. **Open:** the "answering input"
  variant needs a real pending approval (see below).
  (`docs/evidence/W06-focus.md`, `W06-focus-live.json`.)
- **W08 — Native approval and clarification replies (verifying).** Migration 9 adds durable
  `human_requests`; `StudioService.respond` answers `POST /v1/approvals/{id}` and
  `POST /v1/user-input/{thread}/{request}` with a claimed, validated, acknowledged send. The card
  offers Allow/Deny or the runtime's questions plus `Other`, and dismissal never decides. Fixed two
  contract defects found on the way: a snake_case `approval.required` was unreadable, and the runtime
  posture `ask` displayed as `unknown`. 8 service, 2 adapter, 1 IPC, 2 renderer and 2 contract tests;
  8 live protocol steps prove both routes exist. (`docs/evidence/W08-replies.md`.)
- **W10 — Honest usage in the slim dashboard.** The Studio strip now shows the session's recorded
  cost and input/cache/output buckets with an explicit scope, `unknown` for unreported buckets and
  `+ N unpriced` beside the priced total; it refreshes once when a turn settles. (`W10-usage.md`.)
- **W11 — Composition conveniences.** The demonstrated gap was file references: they are now resolved
  with `realpathSync.native` and refused when missing or when a junction escapes the project root.
  Copy, search, favorites, export and the link-free Markdown renderer were re-verified rather than
  rebuilt. (`W11-conveniences.md`.)

Two pre-existing build-guard failures were repaired, not hidden: `check-build.mjs` treated the slash
catalog's `GET /v1/commands` provenance label as a renderer engine route, and its preload channel
list had been stale since W05/W06. Both are why `npm run check:build` had been red (it is not part of
`npm run ci`).

## Needs the Human — the one unobserved thing

A **real pending approval** has never appeared on this machine. `~/.codewhale/settings.toml` records
`permission_posture = "full-access"`, and the binary documents that `auto_approve`, `trust_mode` and
`allow_shell` are capped by that saved policy: a thread created in posture `ask` still ran a bash
tool call with no `approval.required` event (attempts recorded on `P-W08-001`; no no-progress streak).

To close W06 and W08: switch Mona's saved permission posture to **ask** in Provider settings for one
bounded turn, then run `node tools/spike/approval-roundtrip.mjs` (expect `approval.required` →
`allow` → `approval.decided` → `turn.completed`), and repeat the Focus/fullscreen transitions across
that pending card.

## Still open from the original sequence

1. **Project import has no product surface.** `importProject` is correct and tested; no channel,
   dialog or menu calls it.
2. A physical IME composition is a human check; Chromium cannot be driven into composing state.
3. Human/signing gates are unchanged: the modern Explorer menu has never been seen by a person
   (MONA-027 / W22), Narrator and physical 200 % scaling (MONA-028 / W20), the real Save dialog click,
   and the license decision. Memory stays accepted for 0.1.0 by D-0111 with the 350 MB target unmet.
4. `node-pty`'s `AttachConsole failed` trace on forced teardown is ISSUE-0020, unchanged.

## Standing authorization

D-0118: commit verified work and push to `origin main` as the closing step of a turn that changed
files. The remote is public, so the push is gated on `node tools/build/cli.mjs validate` (secret
scan included) and on a green `npm run ci`.

## Last pushed commit

Recorded in the end-of-turn report. Verify with `git ls-remote origin refs/heads/main` against local
`HEAD`; do not trust a remembered SHA.
