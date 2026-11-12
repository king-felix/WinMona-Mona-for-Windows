# Mona build handoff

**Current prompt:** P02 — Create the desktop foundation and strict contracts
**Current status:** P01 completed (state revision 5). Next eligible: P02.

**Last verified commit / dirty work:** P01 work is in this session's local
commit (see `git log`); working tree is clean after it.

## P01 result

The installed engine is usable through the local HTTP/SSE runtime API, and the
economics hold.

- **G0 pass.** A real Full Access tool turn created `sum.js` + `sum.test.js`,
  ran its own test (1 pass / 0 fail), streamed the full journal, survived a
  runtime restart, resumed in the same thread, and was interruptible with no
  owned child process left behind. Effective route on the turn record:
  `deepseek` / `deepseek-flash` / `full_access` / `first-party-payg` / `metered`.
- **G1 pass, provisional.** Matched direct `exec` and adapter turns used the
  identical wire tool schema (`bf3cf7cb…`, 15 tools, 35,883 bytes) and the same
  request counts. Median paired cost delta **+1.45%** over 6 pairs; two pairs
  exceeded 5% from model-side extra requests/longer output, not adapter overhead.
  Idle, discovery, history, and reconnect moved **zero** tokens. Pilot spend
  ≈ **$0.04** total (ceiling $2).
- **G2 pass for the discovered surface.** 250 `/v1/*` routes extracted from the
  binary; 43 commands captured with help; capability flags recorded, including
  honest `false` values for terminal streaming.

Decisions D-0011…D-0016 record transport, serialization, submission safety,
cost buckets, token handling, and the route-fingerprint discrepancy.

## Next exact action (P02)

Read P02 in `Mona_PROMPTS.md` (spec sections 3, 6, 8.1, 13) and the P01
decisions. First concrete step: scaffold the pinned Electron/React/TypeScript
project with one package manager, one schema library, one state approach and one
test runner; confirm Electron prebuilt binaries install on this machine (no MSVC
Build Tools detected at P00). No inference calls belong to P02.

## Relevant files and spec sections

- `Mona_PROMPTS.md` — P02 section (~line 224), operating contract O1–O5.
- `Mona_Project.md` — sections 3 (stack), 6 (architecture), 8.1 (state layers),
  13 (security).
- `docs/evidence/P01-feasibility.md` — gates, benchmark, gaps.
- `docs/codewhale-capabilities.json` — qualified surface and UI-route proposals.
- `tools/spike/runtime/client.mjs` — P01 client, superseded by P03.
- `tools/spike/p01-{contract,g0,bench}.mjs` — evidence generators.

## Open problem IDs and no-progress counts

No blocker. `attempts.jsonl` is empty: P01 had no dead-end hypothesis cycles.
Non-blocking issues recorded in `P01-feasibility.md`:

- **P01-ISSUE-001** — CLI exec and runtime report different endpoint
  fingerprints for the same route. Display the runtime fingerprint; resolve at
  P16.
- **P01-ISSUE-002** — Windows does not refuse a second runtime in an owned
  workspace. Serialized execution remains the default until P04/P07.
- **P01-ISSUE-003** — terminal capability flags are false on this build; expose
  as unsupported, complete at P18.
- **P01-ISSUE-004** — cost sample is small and provisional; re-run after adapter
  or routing changes.

## Blocked dependencies

None. The DeepSeek credential now has live evidence: `doctor --probe-api`
reported “the live deepseek API check passed” and the model resolved to
`deepseek-flash`.

## Last relevant validation

- `node tools/build/cli.mjs validate --verbose` → OK, state r5.
- `npm test` → 19/19 (11 bootstrap + 8 spike client/SSE tests).
- Evidence: `docs/evidence/P01-{contract,g0,bench}.json`, logs, feasibility,
  `P01-tests.txt`.

## Human input needed

None for P02 start. Later: a decision on release signing at P21/P23; a decision
if the endpoint fingerprint difference must be resolved by a config change
(do not change Victor’s working route without it).
