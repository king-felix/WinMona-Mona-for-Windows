# P16 — Providers, models, permissions and effective settings

- Prompt: P16
- Requirements: MONA-008 (explicit Plan/Work and permission display), MONA-020
  (provider/model/profile selection with effective route visibility and Flash
  default)
- Engine: Codewhale 0.10.2, commit `ff466b2ed0bf`
- Date: 2026-11-12
- Status: completed with recorded limitations (P16-ISSUE-001..004)

## Delivered behavior

- **Read-only configuration projection.**
  `packages/adapter/src/configuration.ts` maps `/v1/config`, `/v1/providers`,
  `/v1/providers/{id}/models` and `/v1/settings/schema` into strict contract
  types. It never writes.
- **Provider workbench.** `apps/desktop/src/main/provider-workbench.ts` and
  `apps/desktop/src/renderer/ProviderWorkbench.tsx` show the provider catalog,
  credential state (never a value), model capabilities, requested vs effective
  route, saved default, supported reasoning levels, permission choices and
  offline connection diagnostics.
- **Scoped writes.** `codewhale config set` is the only writer. Before a write,
  Mona snapshots `config.toml` and `settings.toml`, hashes both, copies them to
  an app-private backup directory and checks an expected revision. After the
  write it reads the key back and refuses to claim success without confirmation.
  Unknown keys are preserved by the engine CLI.
- **Scope contract.** A saved route changes new threads. The active thread keeps
  the provider/model it was created with; the workbench shows both values and
  refuses to present a default as if it had changed the active turn.
- **Permissions and mode.** New-session permission and startup mode are written
  to `settings.toml` through the same backup/revision path.
- **Connection diagnostics.** Mona reads `doctor --json` (offline) and classifies
  missing credential, invalid endpoint, route error and unprobed connectivity
  separately. It never calls `--probe-api` from this view.
- **Redaction.** Diagnostics text is synthesized from safe fields and passed
  through `redactSecrets`; a test proves credential-shaped values do not survive.

## Acceptance evidence

| Acceptance item | Evidence |
|---|---|
| Changing a new-thread default leaves an active turn alone | `P16-scope.json`: thread created on `deepseek-flash`; `config set model deepseek-chat`; `getThread` still reports `deepseek-flash`; the runtime still reports its launch route |
| Missing key and invalid endpoint are distinct | `provider-workbench.test.ts`: `missing_credential` vs `invalid_endpoint` with different findings |
| Effective model matches the receipt | `P15-agent-run.json` thread/turn records report `effective_model: deepseek-flash`; the studio profile is read from the engine thread, not guessed |
| Unsupported reasoning choices are not sent | Flash reports `reasoning_effort: unknown`; `reasoning.supported` is false and no levels are offered. Mona’s turn contract has no reasoning field |
| Route failure stays on the configured route | No fallback path exists. Failed writes are refused before/after verification; the provider/current values are never changed as a side effect (stale-revision and missing-credential tests) |
| Exported diagnostics contain no secrets | `redactSecrets` test strips API keys, bearer tokens and `token:` values; `doctor --json` is metadata-only |
| Victor’s Flash route stays the default | No provider/model was changed in Victor’s real `CODEWHALE_HOME`. The live probe used an isolated temp home; the production default remains `deepseek` / `deepseek-flash` |

## Observed engine contract

- `GET /v1/config` → provider, model, `model_available`, base URL, reasoning
  effort, default mode, approval mode.
- `GET /v1/providers` → credential state (`configured`, `missing`,
  `login_required`, `local`), source and writability.
- `GET /v1/providers/{id}/models` → per-model capability flags and reasoning
  levels. `deepseek-flash` reports `reasoning_effort: "unknown"` with no levels.
- `GET /v1/settings/schema` → permission options; `permission_posture` and
  `default_mode` are persisted settings.
- `codewhale config set model …` writes `config.toml`; `permission_posture` and
  `default_mode` write `settings.toml`. Both are covered by the backup/revision
  snapshot.
- `codewhale doctor --json` is offline (`api_connectivity.checked: false`) and
  reports credential presence as `not_probed`, never a key value.

## Open issues

- **P16-ISSUE-001 — no reasoning control for the Flash route.** The engine
  reports reasoning support as `unknown` with no levels, so Mona offers no
  control and sends none. If a later engine build qualifies levels, the same
  projection will offer them.
- **P16-ISSUE-002 — live provider probes are not automated.** Diagnostics are
  offline by design; `--probe-api` remains an explicit engine action. A live
  route failure is therefore classified from doctor/route metadata, not from a
  paid request.
- **P16-ISSUE-003 — credential entry stays with the engine.** Mona shows state
  and refuses a provider without a usable credential, but does not add a new
  secret-entry surface. This is deliberate for the security boundary.
- **P16-ISSUE-004 — model catalog coverage varies.** Providers without a live
  catalog report no model list; the workbench then refuses to pretend a model is
  valid and asks the engine to validate the choice.

## Evidence files

- `docs/evidence/P16-surface-raw.json` — config, provider, model, settings and
  doctor shapes.
- `docs/evidence/P16-scope.json` — isolated live scope probe (zero inference).
- `docs/evidence/P16-tests.txt` — Vitest results.
- `docs/evidence/P16-checks.txt` — typecheck, lint, format, build and bundle
  checks.
- `docs/evidence/P16-build.txt` — production build output.

## Spend

Zero. Every P16 check was local and offline; no provider request was made.
