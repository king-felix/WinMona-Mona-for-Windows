# W10 — Honest usage in the slim dashboard

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`.

Status: **complete.** The ledger, budgets and dispatch gate already existed; what was missing was a
usage readout in the Studio strip that shows the recorded buckets for the session on screen, and
proof that reading it costs nothing.

Evidence:

- **Fixture** — `studio-service.test.ts` "reads session usage from recorded rows…" (records, priced
  and unpriced rows, cache hit/miss, inclusive reasoning, duplicate replay, session scope, and no
  submission caused by reading the view) plus the three `StudioPanel.test.tsx` chip tests.
- **Cost math and gate** — the existing `costs.test.ts` matrix (disjoint cache buckets, inclusive
  input, unknown never zero, duplicate/replay, parent-and-child, per-turn/task/session attribution,
  warn→block, reservations, day scope) and `studio-service.test.ts` "gates the next dispatch by
  budget and makes no provider request for UI actions".
- **Real Windows runtime** — `npm run surfaces`, 26 steps, 4 screenshots; `npm run a11y -w
  @mona/desktop`, 12 steps including 200 % zoom. Neither starts a runtime or sends a prompt.

## What changed

**The Studio strip now shows the session's recorded usage**, not just the project spend chip:

```text
$0.0025 · in 1.0k · cache 256 · out 300          (title: scope, cache hit/miss, reasoning inside output)
$0.0025 + 1 unpriced · in unknown · …            (an unpriced turn, and a bucket the runtime omitted)
No usage recorded for this session                (nothing to price yet — not "$0.0000")
```

Rules the code enforces rather than describes:

- **Scope is named.** `StudioUsage.scope = 'session'`, and the tooltip says `Scope: this session (N
  recorded turn(s))`. The header chip keeps reporting the project; the two are no longer confusable.
- **Unknown is not zero.** `CostTotals` token buckets are `number | null`; a bucket the runtime did
  not report renders `unknown`. Unpriced records are counted beside the priced total
  (`+ N unpriced`), never folded into it.
- **Reasoning is labelled inclusive.** The pinned deepseek route reports reasoning inside output
  (D-0014), so the readout says `(inside output)` instead of implying a separate bucket.
- **Reading is free and cheap.** `sessionUsage` reads the ledger's own `lens()` projection — no
  engine call, no new query path — and the renderer refreshes it once when a turn settles, merging
  only the usage field so scroll position and rows are untouched. A failed read returns `null`
  (a readout must not break the studio) rather than a fabricated zero.

## Verification

```text
npx vitest run apps/desktop/src/main/studio-service.test.ts   # 38 passed (1 new usage test)
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx # 39 passed (3 new chip tests)
npm run surfaces        # 26 real-window steps, 4 screenshots, 0 provider requests
npm run a11y -w @mona/desktop  # 12 steps, including 200% zoom with no horizontal overflow
```

## Not claimed

- The HUD is not a live token counter. Numbers appear from recorded rows after a turn settles; there
  is no per-frame token estimate, and no invented "live" spend.
- Physical 200 % display scaling and Narrator remain W20's human checks; 200 % here is Chromium zoom
  in a real window.
- The header project chip and the Cost lens were reconciled at P25 and are unchanged here.
