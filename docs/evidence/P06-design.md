# P06 — Design system, measured rather than asserted

**Prompt:** P06 · **Status:** completed · **Requirements:** MONA-006 (themes,
density, focus, scaling), MONA-029 (keyboard flow) · **Environment:** win32-x64,
Electron 45.3.0 (Chromium 156), Node v26.13.1

`packages/ui` is new: tokens, primitives, overlays, and a labelled fixture
harness. The desktop renderer imports `@mona/ui/tokens.css` and renders the
harness at `?harness=1`. `docs/design-system.md` is the human-readable contract;
this note is the evidence.

## What exists

- **Tokens** for both themes: surfaces, ink, actions, four measured status
  triplets (text/soft/loud), borders, focus, selection, typography, spacing,
  radii, shadows, motion, and two density modes.
- **Components**: Button, Field, Select, Badge, Card, Inspector, EmptyState,
  Skeleton, ErrorState, Notification, Dialog, Menu, Tabs.
- **Screens**: home, project studio, work board, cost lens, blocker card,
  settings, plus a board of non-happy states. Every screen is labelled with the
  harness banner.
- **Runner**: `npm run shots -w @mona/desktop` drives the harness through the
  DevTools protocol, captures screenshots, runs the DOM/keyboard audit, and
  exits non-zero on any failure.

## Contrast, measured

The audit parses `tokens.css` and computes WCAG ratios itself
(`packages/ui/src/contrast.ts`). It found two real problems in the starting
palette, both fixed rather than documented away:

- `--border-strong` was 2.08:1 on Daybreak and 2.30:1 on Afterglow, below the
  3:1 required for a control boundary. Strengthened to `#7a8bab` / `#6b77b8`.
- Coral `#d94a66` is 4.10:1 on white, so it cannot be status text. It stays a
  decorative accent; status text uses `--critical` (`#a81e3c`, 6.2:1).

Fourteen declared pairs now pass per theme, including body text at ≥ 7:1.

## Accessibility, observed in the real app

The runner tabs through the harness with real key events in each theme and
density and records what received focus:

```text
daybreak/comfortable: focus 14 stops, ring visible, unnamed 0, dup ids 0, external 0
daybreak/compact:     focus 14 stops, ring visible, unnamed 0, dup ids 0, external 0
afterglow/comfortable:focus 14 stops, ring visible, unnamed 0, dup ids 0, external 0
afterglow/compact:    focus 14 stops, ring visible, unnamed 0, dup ids 0, external 0
```

Zero unnamed controls, zero duplicate ids, zero colour-only status elements,
zero external resources. The focus ring is verified twice: the shipped CSS
contains a `:focus-visible` rule with a non-zero outline, and focus stops resolve
to real controls (buttons, tabs, the tab panel, fields).

Dialogs, menus and tabs have their own keyboard tests in `packages/ui/src/ui.test.tsx`,
including focus restoration to the opener and Escape handling.

## Both themes, both densities, named sizes

34 screenshots in `docs/evidence/shots/`, indexed by
`docs/evidence/P06-shots.json`:

- 2 themes × 2 densities × (7 screens + a viewport shot) at 1280×800,
- one 1920×1080 Daybreak capture,
- one 200% scaling capture (1280×800 at device pixel ratio 2).

Screenshots were taken through `Page.captureScreenshot` because `capturePage()`
returned `UnknownVizError` on this host; that is a note about the harness, not
the product.

A rendering bug was found by looking at the images rather than trusting the
audit: the Afterglow captures were rendering in Daybreak because the theme effect
overwrote the requested theme from `localStorage`. `initialTheme()` now reads the
request first. The audit would not have caught that — only the picture did.

## Economics and isolation

- No fonts, icons, or images are fetched; the CSP still allows only `'self'` and
  `data:`.
- The harness is fixture data with no engine access; opening it performs no
  request and spends nothing.
- The renderer bundle grew from 225 kB to 243 kB (the components plus fixtures);
  zod is still absent from the renderer.

## Known limits

- **No screen-reader session was run.** Automated DOM checks and a real keyboard
  traversal are recorded; a human screen-reader pass belongs to final QA (P22),
  and this note does not claim it happened.
- **The harness ships in the production bundle** behind `?harness=1`. It is
  labelled and inert, but P07 replaces the fixture screens with the real shell;
  at that point the harness should move behind a development-only flag.
- **Motion was verified by rule, not by sampling frames.** Reduced motion is a
  media query zeroing every duration; a frame-level measurement is P22 work.
- **Aesthetic judgement is not claimed.** Contrast, hierarchy and keyboard access
  are measured; "beautiful" is Victor's call at final QA.
