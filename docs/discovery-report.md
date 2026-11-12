# P00 discovery report — environment, engine, and prerequisites

Captured 2026-11-11 on Victor's machine. Commands were run read-only except for
the repository scaffolding described at the end. No credential value was read,
printed, hashed or stored; only presence and shape metadata is recorded.

## 1. Host and toolchain

| Fact | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 (build 26200) |
| Architecture | AMD64 / x64 |
| Shell | PowerShell 5.1.26100.9711 (no `pwsh`; scripts stay 5.1-compatible) |
| Workspace | `X:\AI_projects\Mona` on NTFS fixed volume, 999 GB, 998 GB free |
| Git | 2.56.0.windows.2 (repo initialized by P00; no remote) |
| Node.js | v26.13.1 |
| npm | 11.20.0, registry `registry.npmjs.org` reachable (PONG 222 ms) |
| Python | 3.13.12 on PATH (Codewhale registers its Python execution tool) |
| .NET | `dotnet.exe` runtime present, **no SDK installed** |
| Native C/C++ toolchain | none found: no `cl`, `link`, `msbuild`, `vswhere`, no Visual Studio Build Tools |
| ripgrep | not installed (use PowerShell `Select-String` / Node) |
| Editor | VS Code (`code.cmd`) present |
| npm global prefix | `X:\AI_Projects\Qwen3.8-27B\bin\npm-global` (unusual, but contains no Codewhale package) |

Consequences for later prompts:

- Electron native dependencies (SQLite binding, PTY binding) normally need
  prebuilt binaries or MSVC Build Tools. P02 must confirm prebuilt availability
  and, only if required, install Build Tools with Victor's existing
  authorization; otherwise it records the gap rather than silently switching
  stack.
- Codewhale's `doctor` reports **sandbox unavailable on this host** ("commands
  run best-effort"). Mona's security boundary must therefore come from its own
  process, IPC and content rules (spec section 13), not from OS sandboxing.

## 2. Codewhale installation identity

| Fact | Value |
|---|---|
| Command on PATH | `C:\Users\victo\AppData\Local\Microsoft\WinGet\Links\codewhale.exe` |
| Resolved binary | `...\WinGet\Packages\HunterBown.CodeWhale_Microsoft.Winget.Source_8wekyb3d8bbwe\codewhale.exe` |
| Install method | WinGet package `HunterBown.CodeWhale` (package-managed; `update` prints migration guidance) |
| Version / commit | `codewhale 0.10.2 (ff466b2ed0bf)` |
| Conflicting installs | none — `where.exe codewhale` and `Get-Command -All` return exactly one entry |
| Codewhale home | `C:\Users\victo\.codewhale` (config, settings, sessions, secrets, skills, catalog) |

Captured help and diagnostics (verbatim, unredacted because they contain no
secrets — `doctor` states it reads no credential values):

- `docs/evidence/engine/cli-help.txt`
- `docs/evidence/engine/app-server-help.txt`
- `docs/evidence/engine/exec-help.txt`
- `docs/evidence/engine/doctor.txt`

## 3. Provider route (redacted inspection only)

| Fact | Value |
|---|---|
| Provider | `deepseek` (also `[providers.deepseek]` table in `config.toml`) |
| Configured model | `deepseek-flash` (`default_text_model`, `providers.deepseek.model`) |
| Reasoning effort | `auto` |
| Auth mode | `api_key` |
| Endpoint | `https://api.deepseek.com` (doctor-resolved; `base_url` in config is commented out) |
| Credential presence | one `secrets.json` entry for `deepseek`, backend `file`, `source=secret_store_unprobed` |
| Doctor verdict | "the deepseek route has no verified key" — credentials were not probed |
| Live probe | **not run at P00**; it is paid inference and belongs to P01's declared pilot ceiling |

Nothing in `config.toml`, `settings.toml`, the secrets store, or the environment
was modified. No key value was displayed, copied or committed.

## 4. Engine surface observed (seed for the capability ledger)

- 43 top-level CLI commands (`run`, `exec`, `app-server`, `serve`, `web`, `rc`,
  `fleet`, `workflow`, `lane`, `thread`, `mcp`, `skills` via setup, `config`,
  `auth`, `providers`, `metrics`, `receipts`, …). Full rows:
  `docs/codewhale-capabilities.json` (all `unqualified` at P00, by design).
- Runtime transports advertised by `app-server --help`:
  - `--http`: full HTTP/SSE Runtime API under `/v1/*`, default `127.0.0.1:7878`,
    token via `--auth-token`, `CODEWHALE_RUNTIME_TOKEN`, or
    `DEEPSEEK_RUNTIME_TOKEN`.
  - `--stdio`: smaller JSON-RPC compatibility transport; tool-free turns require
    `allowed_tools: []`.
  - `--socket`: desktop daemon over a private local endpoint; requires
    `daemon/attach`.
  - legacy no-flag compatibility HTTP on `127.0.0.1:8787`.
- `codewhale exec` is the one-shot path: `--auto` offers tools and defaults to
  Full Access; `--output-format stream-json` exists; plain `exec` is answer-only.
- Upstream overlap to reassess at G0: this build already ships a browser client
  (`codewhale web`, `codewhale rc`) and a runtime server. Per spec section 2.3,
  Mona's justification must be the studio + continuity layer, not a duplicate
  chat client.
- Runtime posture reported by doctor: `default_mode=agent`,
  `permission_posture=full-access`, `approval_policy=on-request`,
  `telemetry=on (env)`, `control_socket=off`.

These are observed strings, not qualified contracts. Each used route must pass a
contract test against this binary at P01/P03.

## 5. Repository state and instructions

- Before P00 the directory held only `Mona_Project.md`, `Mona_PROMPTS.md`, and a
  Codewhale-owned `.codewhale/state/` directory. There was no Git repository, no
  `AGENTS.md`, and no other project instruction file — no instruction conflict
  existed to preserve.
- `.codewhale/state/*` is Codewhale's own runtime state, left untouched and
  gitignored (decision D-0007).
- P00 created the repository, `AGENTS.md`, the traceability ledger, the spec
  index, the capability seed, the build state and this report.

## 6. Open unknowns carried into P01

1. Whether the stored DeepSeek credential is valid and which resolved model the
   provider reports for `deepseek-flash` (needs `codewhale doctor --probe-api`
   or one bounded sentinel turn).
2. Runtime API route-level contracts (`/v1/*`), auth handshake, event stream
   shape, interrupt and resume receipts, and usage fields.
3. Runtime concurrency and storage-lock behaviour for parallel workspaces.
4. Whether `--http` reports effective permission posture and route identity in a
   way Mona can display truthfully.
5. Actual provider pricing and cache telemetry needed for the G1 comparison.
6. Whether upstream `web`/`rc` already covers enough of the studio experience.

## 7. P01 prerequisites (explicit)

- A live-route check before any G0 claim: bounded `codewhale doctor --probe-api`,
  or one minimal sentinel `exec` turn, recorded with cost where available.
- Benchmarks stay inside the predeclared $2 pilot ceiling from spec section 9.4;
  if real rates or telemetry cannot support that, P01 records fixtures and marks
  live economics inconclusive rather than inventing figures.
- No provider, endpoint, model, credential or telemetry setting changes.
