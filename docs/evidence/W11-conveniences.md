# W11 — Composition, navigation and review conveniences

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`.

Status: **complete.** Most conveniences were already delivered (P14/P23/W01/W03); the demonstrated
gap was file references: they were checked syntactically but never against the project on disk, so a
missing path, or a junction pointing outside the project, was sent as if it were part of it.

Evidence:

- **Fixture** — `studio-service.test.ts`: the reference-composition test (now creating real files)
  and the new "refuses a reference that is missing or escapes the project through a junction".
- **Real Windows runtime** — `npm run composer` 9/9 (`docs/evidence/W01-composer.json`), `npm run
  a11y -w @mona/desktop` 12/12 including 200 % zoom, `npm run surfaces` 26/26. None starts a
  runtime or sends a prompt.

## What changed

**A file reference is now checked against the project it belongs to, and against the disk.**

```text
absolute path, drive path or ".."        → refused before any thread work
"/" at the start, control characters     → refused
not a file in this project               → "…is not a file in this project."
resolves outside after links/junctions   → "…resolves outside this project and was not sent."
duplicate spellings of one path          → sent once
```

Containment is decided on `realpathSync.native` of the project root and of the resolved reference, so
a Windows junction (created without elevation in the test) cannot smuggle an outside file into the
prompt. The check runs in `StudioService.submit` after the project is known and before the dispatch
claim, so a refused reference costs nothing and leaves the draft in the composer.

The reference is still **a path in the prompt**, never uploaded content: `composePrompt` appends a
`Files referenced by this request:` list, the capability row keeps saying attachments are
unsupported, and the composer shows the paths verbatim rather than implying the model has the file.

## Already delivered, re-verified rather than rebuilt

- **Copy** — a timeline entry's text can be copied; a clipboard failure is reported, not swallowed.
- **Local search** — stored text is searched in the database (`studioSearchHistory`), with hits that
  page to the row and no provider call.
- **Favorites, shortcuts, export** — prompt favorites insert as text and stay a draft until Submit;
  the shortcut list is rendered; conversation export walks stored rows through the native save
  dialog.
- **No cross-privilege links** — the Markdown renderer emits no anchors and no raw HTML, so a link in
  model output cannot reach the renderer as navigation; remote navigation and popups are refused by
  the window policy (P02 security smoke).
- **Draft safety** — the picker and every dialog return to the composer with the draft intact
  (W01 composer probe), and cancelling a picker inserts nothing.

## Verification

```text
npx vitest run apps/desktop/src/main/studio-service.test.ts   # 39 passed
npm run composer                                             # 9 steps, 2 screenshots
npm run a11y -w @mona/desktop                                # 12 steps
npm run surfaces                                             # 26 steps
```

## Not claimed

- Actual attachments (content upload) remain unsupported on this runtime contract; W11 did not
  invent an API for them.
- A physical IME composition is still a human check (W20); the probe covers the guard, not a person
  typing with an IME.
