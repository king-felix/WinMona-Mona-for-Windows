# W04 — descriptive native command autocomplete

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 / Chromium 140.0.0.0 / Node 26.13.1 (development build).

Evidence classes:

- **Real Windows runtime** — the product window typing through Electron's own input path
  (`npm run slash`; `docs/evidence/W04-slash.json`, log and screenshots beside it).
- **Fixture** — unit tests over the shipped catalog and the parser.
- **Static/captured registry** — `GET /v1/commands` from the installed binary, recorded verbatim.

## Where the catalog comes from

The pinned engine serves its real slash-command registry at `GET /v1/commands` on the canonical
HTTP surface. `tools/build/slash-catalog.mjs capture` starts the installed engine on a loopback port
in a throwaway `CODEWHALE_HOME` (usage reporting switched off, no credentials, no provider
contact), reads the route once, and records 109 commands with the engine version, commit, binary
SHA-256, route and timestamp in `docs/evidence/W04-commands-raw.json`. The process tree is stopped
afterwards. `build` merges that capture with the curated classification in
`tools/catalog/slash-annotations.json` and writes
`apps/desktop/src/shared/slash-catalog.ts`; `check` fails if the shipped file is stale.

The registry is the coverage source. Nothing in the product can add a row, and the generator
refuses: an unannotated registry row, an annotation naming a command the engine does not have, a
name annotated twice, and an alias that collides with a command name or another alias. Every row
carries the engine's own `summary`, `usage`, `subcommands`, `hidden` and `discovery` values, plus
Mona's classification:

- **cost class** — `model` (sends a provider request), `none` (no provider request), `unknown`
  (the registry summary does not settle it; Mona does not claim zero). A `model` row is required by
  test to say "provider request" in its side-effect note.
- **side effects** — one sentence about what the command changes.
- **route** — `mona` (a typed Mona operation exists), `tui-only` (the engine implements it in its
  terminal UI), `unsupported`. In W04 every row is `tui-only`; W05 flips the rows it dispatches.
  The route note explains the situation for that specific command rather than repeating a slogan.

CLI subcommands and runtime endpoints are a different interface and are not mixed in: this file is
the engine's slash-command registry only, and the CLI's own help stays in
`docs/evidence/engine/commands/`.

## The composer

Typing `/` at column 0 of a line opens a locally filtered list. Filtering is prefix → alias →
substring → description, ranked, bounded to 8 rows, and makes no engine or model call. Each row
shows the command, its aliases, the engine's description, the usage line, a cost badge and a route
badge.

Command position is deliberately narrow, so ordinary text is never mistaken for a command: the
line must start with `/` at column 0, the caret must still be in the first token, and the token may
only contain command characters. `/usr/bin/env`, `C:\work`, `\\server\share`, an indented code
line, `> /new`, `"/new"` and an escaped `\/new` are all ordinary text.

Keys: `↑`/`↓` move the selection, `Tab` fills the highlighted command (adding the trailing space
only when it takes arguments), pointer `mousedown` fills it too, `Escape` closes the list without
touching the draft or interrupting work, and plain `Enter` still inserts a newline. Ctrl+Enter
keeps its W01 behaviour (IME composition and key repeat are still ignored) and now also refuses
command-shaped input instead of sending it.

Refusals, each with the reason and the way out:

- an exact command → "`/new` is a Codewhale command." plus the route note, the missing argument if
  the engine requires one, and `Start it with \/ to send it to the model as ordinary text`;
- an ambiguous prefix → the candidates, so nobody executes a different command by accident;
- an unknown word, prose, a path or pasted code → sent as text, unchanged;
- `\/new` → sent as `/new` and the notice says the backslash was an escape.

The full catalog is also a drawer under the composer: all 109 rows, including the three the engine
hides from its own palette, each with cost, route, side effects and the engine version it was
captured from. Reading it makes no request.

## Verification

```text
node tools/build/slash-catalog.mjs check    # catalog is current: 109 rows, 97 aliases
npx vitest run apps/desktop/src/shared/slash.test.ts apps/desktop/src/main/slash-catalog.test.ts
                                            # 24 passed
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx   # 25 passed
npm test                                    # 655 passed in 73 files; node --test suites pass
npm run ci                                  # format, lint, typecheck, tests, build: exit 0
npm run slash                               # 11 real-window steps passed, 3 screenshots
```

Real Windows runtime (`docs/evidence/W04-slash.json`; 0 provider requests):

```text
PASS typing / opens the command list        rows: 8, count: "8 of 109 commands. ↑↓ choose · Tab fills · Esc closes"
PASS the list exposes listbox semantics     aria-expanded=true, aria-controls=slash-command-list,
                                            aria-activedescendant=slash-command-advisor, aria-live=polite
PASS the model row shows description/cost/route
PASS Tab fills the command and closes the list      afterTab: "/model "
PASS Escape closes the list and keeps the draft     afterEscape: "/co"
PASS a recognized command is explained, not sent    "/new is a Codewhale command. … This line was not sent."
PASS prose and Windows paths do not open the list
PASS the catalog drawer lists every command       109 rows, provenance shows GET /v1/commands
PASS at 200% window zoom the list stays visible and keeps a selected row
```

The 200 % step is a Chromium window zoom, not the OS display scale: it proves the list stays
reachable and operable when text doubles, and it is labelled as such. The physical 200 % display
setting and a real Narrator session remain W20's human checks.

Coverage fixture (`apps/desktop/src/main/slash-catalog.test.ts`) compares the shipped catalog with
the raw capture: names equal and unique, every alias equal in both directions, engine summary /
usage / subcommands / hidden / discovery preserved, provenance equal, no alias collision, and the
engine-hidden rows marked hidden rather than dropped.

## Left for W05 and later

> **Updated by W05.** `/new` and `/help` are now real Mona routes: typing them dispatches a typed
> operation in the main process (see `docs/evidence/W05-dispatch.md`). The generated catalog in this
> working tree therefore shows two `Mona route` rows, and the probe's refusal example is `/model`
> rather than `/new`. Everything else in this section still holds: the remaining 107 rows are
> `tui-only`, and physical 200 % scaling and Narrator sign-off remain W20's.

- **Routing.** Every row is `tui-only`: W04 describes, it does not execute. W05 adds typed
  operations for the rows Mona can own (`/new` first) and the catalog route notes change with it.
- **Physical scaling and Narrator.** The list is keyboard-operable, has listbox/option roles with
  `aria-selected` and `aria-activedescendant`, and sizes in `rem` with wrapping; the real 200 %
  display scale and a Narrator walkthrough remain human checks under W20.
- **Packaged build.** This probe ran the development build; packaged timings and the installed
  binary belong to W24.
