# Mona build handoff

**Current prompt:** P00 — Bootstrap the project and establish ground truth
**Current status:** completed (state revision 4). Next eligible: P01.

**Last verified commit / dirty work:** `2dcf848` "P00: bootstrap build workspace,
durable ledger, and engine discovery", followed by `cbd5f22` (handoff note) and
this prompt's test/evidence correction commit. Working tree clean after it.

## Completed in this session

- Inspected the host and preserved every pre-existing file; initialized Git on
  `main` (no remote) plus `AGENTS.md`.
- Discovered and recorded the engine: Codewhale 0.10.2 (ff466b2ed0bf) via WinGet,
  a single PATH entry, 43 top-level commands, four runtime transports.
- Recorded the provider route without touching it: deepseek / deepseek-flash /
  https://api.deepseek.com; credential present but unprobed.
- Built the traceability ledger (P00–P23, MONA-001–030, 114 criteria), the spec
  index with hashes, and the capability-inventory seed (43 rows, unqualified).
- Built and tested the bootstrap utility: atomic checkpoints, revision conflict
  detection, backups, journal, recovery, evidence hashing, secret scan.
- Wrote decisions D-0001…D-0010 and the P00 evidence record.

## Next exact action

Read P01 in `Mona_PROMPTS.md` (spec sections 2, 6, 7.1, 9, 10). First concrete
step: bounded live-route verification (`codewhale doctor --probe-api` or one
sentinel `exec` turn) with spend recorded, then a G0 contract probe of
`app-server --http` on a scratch workspace, all inside the $2 pilot ceiling.

## Relevant files and spec sections

- `Mona_PROMPTS.md` — P01 section (~line 204) and operating contract O1–O5.
- `Mona_Project.md` — sections 2 (gates), 6 (architecture), 7.1 (coverage),
  9 (economics), 10 (events/recovery).
- `docs/discovery-report.md` — environment, engine identity, open unknowns.
- `docs/codewhale-capabilities.json`, `docs/evidence/engine/*-help.txt`.
- `tools/build/cli.mjs` — state commands; `npm test` for the bootstrap suite.

## Open problem IDs and no-progress counts

None. `.mona/build/attempts.jsonl` is empty.

## Blocked dependencies

None. Non-blocking prerequisite: the DeepSeek credential is stored but unverified
(`BLOCKERS.md` watchlist). If the P01 probe proves the key invalid, Victor must
re-save it with `codewhale auth set --provider deepseek`; that is the only
human-only step known today.

## Last relevant validation

`npm test` → 11/11 passing (atomicity, interrupted write, torn temp, corrupt
state restore, revision conflict, graph cycle, missing requirement, stale spec
hash, evidence-less pass, evidence hashing, missing evidence path). The suite
builds its own baseline, so it stays valid as later prompts advance real state.
`node tools/build/cli.mjs validate --verbose` → OK, state revision 4, no stale
evidence hashes. Artifacts: `docs/evidence/P00-tests.txt`,
`P00-validation.txt`, `P00-final-audit.txt`.

## Human input needed

None for P01 start. Possible later: a valid provider key if the stored one fails
the probe; an eventual decision on release signing (P21/P23).

**Next eligible prompt:** P01 — Prove headless integration and preserve the
economics.
