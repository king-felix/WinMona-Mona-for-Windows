# P17 — Tools and extensions are manageable

**Status:** completed (implementation and verification recorded in this document)
**Prompt:** P17 — Make tools and extensions manageable
**Requirement:** MONA-021
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)`, Windows x64
**Spend:** zero provider requests. The probe submitted no turn and the runtime
usage totals stayed at zero turns / zero tokens / zero cost.

## What Mona now exposes

Mona adds an **Extensions** section (Alt+5, also in the command palette) built
from the engine’s own reports:

- **MCP servers** — name, global/project origin, writable flag, enabled and
  required state, transport, command or URL, argument count, environment
  **key names only**, scopes, current connection state, and a revision.
  Explicit **Check health**, **Enable** and **Disable** actions use the
  runtime’s revision guard (`If-Match`).
- **Skills** — name, description, path, source, plugin identity/content hash,
  bundled tier, invocation mode, aliases, enabled state, and shadowing warnings.
- **Plugins** — display identity, scope/origin/path, state, trust status,
  compatibility, platform list, declared inventory (skills, MCP servers,
  commands, hooks, filesystem roots, network hosts, lifecycle mutation), content
  and capability hashes, and diagnostics. Icons are dropped.
- **Hooks** — engine-enabled flag, event, name, source, background/timeout, and
  redacted command text. Problems are shown as reported.
- **Rules and instructions** — every instruction source the engine checks for
  this workspace, with kind, status, existence, byte count, relative path and
  warnings; imported files and the generated-fallback flag are shown.

The page also explains the three scopes (global, project, bundled) and states
that project executable content stays inert until the engine’s own trust or
approval step.

## Deliberate boundaries

- **No implicit connections.** Opening Extensions reads list and detail routes
  only. It does not call `/v1/apps/mcp/tools`, does not reconnect a server, and
  does not spawn a process. Health is an explicit user action. The live probe
  recorded 7 snapshot calls: MCP list, two MCP details, skills, plugins, hooks
  and instructions; no tools or reconnect calls.
- **No tool-description loading.** Tool names are returned only after an explicit
  health check. The full input schema and server description never enter the
  model context because Mona never sends them anywhere.
- **Engine authority.** Enable/disable is the runtime’s own config write. Mona
  sends the revision it displayed; a stale revision is refused with a conflict
  rather than overwritten. Install, trust, update, hook approval, skill loading
  and project-server trust remain engine routes with their own consent steps;
  the UI shows the exact advanced command/flow instead of simulating it.
- **No renderer scripting.** Hook commands are displayed, redacted, and never
  executed by Mona. The renderer cannot invoke the desktop bridge from hook or
  imported content.
- **Secrets.** MCP environment variables are projected as key names. Commands,
  URLs, hook commands, warnings and errors pass through a credential-shape
  redactor before crossing the adapter boundary. The probe’s fixture token did
  not appear anywhere in the projected view or in the health error.

## Live evidence (`docs/evidence/P17-extensions.json`)

An isolated `CODEWHALE_HOME` and workspace were created under the local temp
directory with:

- a real stdio MCP fixture (`tests/fixtures/mcp/echo-server.mjs`) that
  advertises one read-only `echo_text` tool;
- a second server whose executable does not exist and whose environment carries
  a unique secret value;
- an unknown top-level key and an unknown server-level key;
- a project-scope MCP file that the engine does not accept without trust;
- a project `AGENTS.md`;
- a project `hooks.toml` that has not been approved;
- a local custom skill.

All checks passed:

1. MCP servers and a revision are reported.
2. Snapshot requests no tool catalog and performs no reconnect.
3. Only global servers appear; the unapproved project server is absent.
4. Environment values are key names only; the secret is absent.
5. The custom skill is listed with provenance.
6. `AGENTS.md` is reported as loaded.
7. Unapproved project hooks are rejected by the engine; Mona reports the
   problem and does not enable them.
8. The fixture server connects on an explicit health check and reports
   `echo_text`.
9. The missing executable produces an actionable, redacted error.
10. Disable is verified by reading the server back.
11. Only the intended server changed; the unrelated server is still present.
12. The unrelated server’s secret and the unknown top-level/server-level keys
    survived the edit.
13. A stale revision is refused with a conflict.
14. The refused stale edit leaves the server disabled.
15. Re-enable is verified.
16. Runtime usage before and after is identical: zero turns, zero tokens, zero
    cost.

## Capability coverage rows

`docs/codewhale-capabilities.json` now records:

- **CAP-0052 — MCP servers (runtime):** qualified. List/detail/health/enable/
  disable exercised, revision guard and unknown-key preservation verified.
- **CAP-0048 — skills (runtime):** read-qualified.
- **CAP-0049 — plugins (runtime):** read-qualified.
- **CAP-0050 — hooks (runtime):** read-qualified; project approval requirement
  observed.
- **CAP-0051 — workspace instructions (runtime):** read-qualified.
- **CAP-0023 — `mcp` CLI:** advanced action for add/remove/connect/login/
  validate; exact invocation shown, not assembled from remote content.
- **CAP-0013 — `install` CLI:** advanced action for plugin bundles; install is
  not performed from the renderer.

## Honest gaps

- Project-scope MCP servers and hooks are visible only after the engine records
  workspace trust and approval. P17 reports that state; it does not bypass it.
- Plugin trust/install/update and skill install/trust/update were not exercised
  because they execute or stage third-party content; they remain engine actions.
- MCP add/remove/login are CLI advanced actions. The runtime exposes no add or
  remove route in this build.
- The health check can start a configured server. That is why it is explicit and
  never part of page load.
- `/v1/skills` in the isolated probe also scans the user’s real
  `~/.codewhale/skills`; its thirty-odd “shadowed” warnings are an artifact of
  the isolated home plus the user home, not a product defect. In a normal single
  home the list is the bundled set plus installed skills.

## Tests and checks

- `packages/adapter/src/extensions.test.ts` — mapping, unavailable sections,
  missing detail, health, stale revision, required-server refusal, read-back
  verification, redaction.
- `apps/desktop/src/main/extensions-service.test.ts` — disconnected view,
  workspace scope caveat, empty-list explanation, required-server refusal,
  conflict mapping, health forwarding, unknown project.
- `apps/desktop/src/main/extensions-ipc.test.ts` — declared channels, payload
  validation, exact revision forwarding, untrusted sender, unavailable service.
- `apps/desktop/src/renderer/App.test.tsx` — Extensions navigation, provenance,
  instruction source, explicit health check and disable with the observed
  revision.
- `npm test` — 403 Vitest (43 files), 13 bootstrap, 12 launch, 8 spike.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
  and `npm run check:build -w @mona/desktop` pass; the preload exposes 51 named
  channels.
