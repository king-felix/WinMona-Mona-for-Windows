# W03 — complete history and identity-correct streaming

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 / Chromium 140.0.0.0 / Node 26.13.1 (development build, not packaged).

Evidence classes are separated on purpose:

- **Fixture** — unit/contract tests in the repository against recorded engine-event shapes.
- **Real Windows runtime** — the product window, real database, real renderer (no provider turn).
- **Static inspection** — reading the pinned engine's declared event contract.
- No live provider turn was made in this prompt. Provider spend stayed at zero, and paging or
  searching history makes no model call by construction (both are store reads).

## What changed

**The ceiling is gone, not widened.** `listTimelineItems(threadId, 500)` returned the *oldest*
500 rows ordered `seq ASC`; beyond 500 stored rows the newest history was unreachable, and export
wrote that same prefix. The store now exposes one windowed read (`timelinePage`) with
`beforeSeq` / `aroundSeq` / `afterSeq` cursors, `hasOlder` / `hasNewer` computed from the actual
rows, a total count, a case-insensitive local search (`searchTimelineItems`), and a chunked forward
iterator (`iterateTimelineItems`) used by export. The studio's first load is now the newest window;
older windows are fetched on request. Export walks every stored row in bounded chunks.

**Renderer window.** State holds at most 2 000 rows and the DOM renders 120 at a time; older rows
are one request away and searchable. Prepending an older page preserves the reader's scroll anchor
(measured `scrollHeight`/`scrollTop` delta), never triggers follow-scroll, and never adds to the
unread count. Follow-scroll is per conversation: it stops when the reader scrolls away from the
newest row, counts arrivals as unread instead of moving the viewport, and resets on a
project/session/mode change.

**Stream identity.** Deltas are keyed by `(thread, turn, engine item id)`. A delta the runtime sends
without an item id binds to that turn's single open anonymous stream, so a heartbeat or a filtered
frame cannot start a second answer card. A later `item.completed` for an id-less stream *adopts*
that row (same id, same sequence, final text) instead of adding a duplicated completed card — and
adoption is refused when the open stream is ambiguous. A frame that arrives after its card closed
is counted as late and ignored. A duplicate replay is refused by the `(thread, seq)` identity
already enforced in `putTimelineItem`, which now also moves a known row to its later sequence
instead of inserting a second row for the same identity.

**Cross-thread isolation.** Every projected row and every push now carries the thread it belongs to.
The service refuses an event whose envelope thread differs from the subscription, and the renderer
ignores pushes for a thread it is not showing, so Plan and Work (or two sessions) cannot merge. A
thread switch detaches the previous subscription and resets the cursor instead of keeping the old
stream alive.

**Honest gap handling.** A skipped sequence is recorded as a diagnostic fact, not silently stitched.
When the stream *resumes past* frames that were never delivered, the open answer is closed as
`interrupted` and a status row names how many frames were lost — the text shown stays exactly as it
was, and no completion is claimed.

## Verification

```text
npx vitest run packages/project-state/src/timeline-paging.test.ts   # 6 passed
npx vitest run apps/desktop/src/main/studio-service.test.ts         # 32 passed
npx vitest run apps/desktop/src/main/studio-ipc.test.ts             # 10 passed
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx       # 9 passed
npm run ci                                                          # format, lint, typecheck, 615 vitest, node --test, build: green
```

Acceptance fixtures, one per requirement in the checkpoint:

| Requirement | Fixture / observation | Where |
|---|---|---|
| >10 000 stored events | 10 050 rows: newest window, two back-pages, first row reached and `hasOlder` false | `timeline-paging.test.ts` |
| Whole thread walked once | 3 000 rows in 6 × 500 chunks, ascending, no duplicates | `timeline-paging.test.ts` |
| Old content remains reachable | window centred on seq 500; search finds seq 117 among 2 000 rows; no cross-thread hit; wildcards literal | store + `studio-service.test.ts` |
| >2 000 frames in one turn | 2 100 id-less deltas → exactly one assistant row, truncated and labeled, no sequence gap | `studio-service.test.ts` |
| Interleaved threads | a frame claiming another thread is refused and never projected | `studio-service.test.ts` |
| Heartbeat between deltas | `ALPHA` → `turn.lifecycle` → ` BETA` → one card, `ALPHA BETA` | `studio-service.test.ts` |
| Duplicate replay | replayed `(thread, seq)` and a duplicate item completion → one row | existing + new tests |
| Genuine gap | reconnect at seq 9 after seq 3 → answer `interrupted`, status names 5 lost frames | `studio-service.test.ts` |
| No duplicated completed card | id-less stream + final message → one card with the final text | `studio-service.test.ts` |
| Export is complete | 1 200 stored rows exported, first and last row present, `all 1200 stored item(s)` | `studio-service.test.ts` |
| Paging makes no provider call | `adapter.submissions` and `adapter.threadCalls` empty after view/paging/search | `studio-service.test.ts` |
| Anchor preserved on prepend | scroll anchor `320 + (1600 − 1000)` after prepend | `StudioPanel.test.tsx` |
| Scrolling while reading is not hijacked | prepend does not follow-scroll; newer rows outside the window produce a deliberate jump control, not a viewport move | `StudioPanel.test.tsx` |

Real Windows runtime, 10 000 stored rows in the product database, one real Electron window
(`npm run qa`, evidence `docs/evidence/W03-history.json`, log `W03-history-log.txt`):

```text
"the studio opened at the newest stored rows and offers the older ones": ok
  rendered: 120   oldestSeq: 9881   newestSeq: 10000   hasOlder: true
  label: "10,000 stored · 500 loaded"
"scrolling stays within a frame budget": ok   frameP95: 16.8 ms
"the studio rendered a bounded window of the seeded history": ok   loadedRows: 500
```

The probe previously planted history under mode `work`, which the studio never queries (its modes
are `agent` and `plan`); that defect is fixed here, which is why this run observes the stored rows
rather than only the synthetic push.

## Not verified in this pass

- A live provider turn carrying id-less deltas or heartbeats was not run: that spends money and the
  acceptance for W03 is fixture-based. The pinned engine's event shapes used by the fixtures come
  from the recorded contract evidence (`docs/evidence/P01-contract.json`), not from a live turn.
- Physical 200 % scaling and Narrator behaviour of the new history controls are W20's scope.
- The packaged candidate was not exercised; these numbers are development-build numbers (W24
  owns packaged timings).
