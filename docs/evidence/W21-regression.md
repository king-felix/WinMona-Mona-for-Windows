# W21 — Regression, economics and security evidence for the settled candidate

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · source `960e00c` + the W12/W13/W19/W20/W22 change
set · installed candidate rebuilt from those bytes · engine `codewhale 0.10.2 (ff466b2ed0bf)`
(unchanged; no turn submitted in this pass).

Status: **complete.** Every required check on this candidate passes; the remaining release blockers
are external, not test failures, and they are listed at the end.

## Checks run on the settled candidate

- `npm run ci` → assets:check, `prettier --check .`, ESLint, typecheck (contracts, adapter,
  project-state, ui, desktop), **vitest 720 tests in 77 files, all passing**, then the build.
- Node `--test` suites inside `npm test` → assets 17, bootstrap 27, launch 12, install 29, spike 8;
  all pass.
- `npm run native:test` → **8 pass, 1 skip** (the skip is the per-user COM activation test, with the
  environment limit proven by a control CLSID; see W22).
- `npm run check:build -w @mona/desktop` → passes: 8 renderer files, CSP replaced, no fixtures, no
  credentials, 90 named preload channels, no engine route in the renderer bundle.
- `node tools/build/cli.mjs validate` → OK, 24 tasks, 30 requirements, **0 warnings**.
- `node tools/build/windows-review.mjs validate` → OK, 26 tasks, 0 errors.
- Installed-candidate probes on these same binaries: `npm run a11y` 12/12, `npm run qa` ok,
  `npm run memory` 12/12 scenes. All recorded under W19/W20.

## Security boundaries this pass touched

- **Runner report paths (new code).** `containPath` refuses absolute paths, `..` traversal, NUL, and
  any path whose *real* target (junction/symlink followed) leaves the workspace; report reads are
  capped at 64 KiB and report file names are validated against `A-Za-z0-9_-`. Covered by
  `runner.test.ts` — "refuses evidence outside the workspace, missing files and wrong hashes" and
  "refuses a junction that points outside the workspace" (junction created with `mklink /J`).
- **Report contract (new code).** `strict()` rejects unknown keys, so a report cannot add tasks,
  carry verifier commands or declare a run complete; human-only criteria cannot be claimed met;
  problem ids must already exist.
- **IPC / renderer isolation / Markdown / links.** Unchanged by this pass; `ipc-audit.test.ts`,
  `security.test.ts` and the UI `markdown.test.tsx` suites (17 tests) still pass, and
  `check:build` still proves no engine route reaches the renderer.
- **Executable rewrite (new tool).** `embed-exe-icon.mjs` only rewrites `RT_ICON`/`RT_GROUP_ICON`,
  refuses a signed input rather than producing a broken signature, and is verified by reading the
  resources back. It imports nothing from the network.
- **Explorer helper.** Still no network imports (`native:test` asserts ws2_32/winhttp/wininet/urlmon
  are absent) and still refuses paths containing quotes or control characters.

## Evidence reconciliation (no laundering)

- The Windows supplement ledger held three W12 evidence entries pointing at `assets/brand/*` with
  pre-change hashes. They were **re-recorded at their new bytes with corrected notes**, because the
  pipeline changed underneath them (`pipeline_version` 2, little-endian ICO) and one of the two
  "known gaps" the README note described — the embedded executable icon — was closed in W12. The
  claim those entries support did not shrink; one stale limitation was removed because it became
  false.
- Two entries that turned out to be a *different* claim (the archived `docs/evidence/brand-icons.md`
  and its screenshot) were left untouched: they describe the original artwork pass and still hash
  correctly.
- `W12` in the supplement is `verifying` and `WX-11` is `partial`: the engineering is done and
  verified on installed bytes, and the physical high-DPI visual check is still a human observation.
  Neither is marked green to tidy the ledger.
- Both ledgers now validate with zero warnings and zero errors.

## Zero-inference and provider route

- No UI path added in this pass performs inference. The runner module is local SQLite only; the
  probes in W19/W20 report `providerRequests: 0`; the installer, staging, icon pipeline and shell
  helper contain no HTTP client.
- The engine route is untouched: `~/.codewhale/config.toml` still names provider `deepseek` and
  `default_text_model = "deepseek-flash"`, `~/.codewhale/settings.toml` still records
  `permission_posture = "full-access"`, and no code in this change set writes either file.
- **Honest note on the endpoint:** `config.toml` carries `base_url` only as a commented example, so
  the engine is using its own default. That is the pre-existing state observed at W00, not a change
  made here, and it is recorded rather than described as "https://api.deepseek.com".

## What remains a release blocker (external, not a failed check)

1. Modern Explorer menu **visual** placement (`MONA-027`) — human right-click, see W22.
2. Narrator, exact 200 % scaling, mixed-DPI, text size, contrast themes, physical IME — human checks,
   see W20.
3. Recipient trust for the self-signed development certificate — a trust decision for another
   machine, see W22/W23.
4. The 350 MiB idle-memory target is still missed (352.5 MiB final, 400.6 MiB in the QA workload);
   the criterion stays open with the options listed in W19.
5. Licensing decision for distribution — unchanged, still a human decision.
