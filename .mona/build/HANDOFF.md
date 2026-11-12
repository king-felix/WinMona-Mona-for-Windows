# Mona build handoff

**Current prompt:** P07 — Assemble the project catalog and desktop shell
**Current status:** P00–P06 completed. State revision 22. Next eligible: P07.

**Last verified commit / dirty work:** the P06 commit covers the design system,
the harness, the desktop integration and the evidence below; the working tree is
clean after it.

## P06 result — a measured design system

`packages/ui` is new and the desktop renderer now consumes it
(`import '@mona/ui/tokens.css'`).

- **Tokens:** Daybreak and Afterglow, density modes (`compact`/`comfortable`),
  120–180 ms motion with `prefers-reduced-motion` zeroing it, system fonts only.
- **Components:** Button, Field, Select, Badge, Card, Inspector, EmptyState,
  Skeleton, ErrorState, Notification, Dialog, Menu, Tabs — with keyboard
  behaviour (roving tabs, menu arrows + Escape, dialog focus trap and
  restoration) covered by tests.
- **Contrast is computed, not assumed.** The audit parses `tokens.css`. It found
  two real failures and they were fixed: `--border-strong` was 2.08:1/2.30:1
  (< 3:1), and coral `#d94a66` at 4.10:1 cannot be status text (it stays
  decorative; status uses `--critical`). Fourteen pairs now pass per theme, body
  ink ≥ 15:1.
- **Harness** at `?harness=1` (theme/density/screen), labelled on every screen as
  fixture data: home, studio, work board, cost lens, blocker card, settings,
  non-happy states. Long names/paths, unknown cost, disconnected, blocked.
- **Runner:** `npm run shots -w @mona/desktop` captures 34 screenshots (2 themes
  × 2 densities × 8 views at 1280×800, plus 1920×1080 and 200% scaling) through
  the DevTools protocol, drives a real Tab traversal, and fails on unnamed
  controls, duplicate ids, colour-only status, external resources, or a missing
  focus rule.
- **A bug the audit missed and the picture caught:** Afterglow captures were
  rendering in Daybreak because the theme effect overwrote the requested theme
  from `localStorage`. `initialTheme()` now reads the request first.

Evidence: `docs/design-system.md`, `docs/evidence/P06-design.md`,
`P06-shots.json` + `docs/evidence/shots/`, `P06-tests.txt` (148 Vitest),
`P06-checks.txt`, `P06-build.txt`. Decisions D-0035…D-0037.

## Next exact action (P07)

Read P07 in `Mona_PROMPTS.md` and spec 4.2, 4.3, 5, 9.1. Build the real shell:
left rail (projects, recents, queue, search, settings), top context bar with
project/branch, real runtime connection, effective model, Full Access, spend and
command palette; center studio; one inspector; bottom drawer closed by default;
persistent control strip during execution. Wire it to `ProjectStore`
(`packages/project-state`) for the catalog: create/open/rename/pin/archive/
search/rebind, distinct empty states (choose folder, connecting, offline, missing
runtime, missing credentials), and no inference at idle. Move the P06 fixture
harness behind a development-only flag now that the real shell exists.

## Relevant files and spec sections

- `packages/ui/src/{tokens.css,primitives.tsx,overlay.tsx,contrast.ts,harness/*}`
- `apps/desktop/src/renderer/{App.tsx,main.tsx,styles.css}`,
  `apps/desktop/src/main/{main,shots,local-state,engine-host}.ts`
- `packages/project-state/src/{store,identity,backup,export}.ts`
- Spec 4.2/4.3 (layout, views), 5 (journeys), 9.1 (zero inference), 12.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace; Mona
  leases one, parallel workspaces stay off.
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray has no tray affordance until P07.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032).
- **P06-ISSUE-001** — the fixture harness still ships behind `?harness=1`; P07
  should move it behind a development-only flag.
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 148 pass (16 new for P06); bootstrap 13; spike 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer 243 kB.
- `npm run smoke -w @mona/desktop` → pass, 332 MB, security assertions intact.
- `npm run lifecycle -w @mona/desktop` → 10/10 + local state opened (schema v1).
- `npm run shots -w @mona/desktop` → 34 screenshots, 4 audits clean.
- `node tools/build/cli.mjs validate --verbose` → OK, state r22.
- Spend ≈ $0.05 of the $2 pilot ceiling; P05 and P06 made no provider request.

## Human input needed

None. Same caution: edit source with byte-safe tools, and avoid PowerShell
backtick/template round-trips in code edits (they broke a file twice this
session; both were repaired immediately).
