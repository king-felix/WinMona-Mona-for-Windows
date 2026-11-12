# Mona design system

`packages/ui` holds the visual language: tokens, primitives, overlays, and a
fixture-backed harness. The desktop renderer consumes it; nothing here fetches a
font, an icon, an image, or a model response.

## Themes

Two themes, one information architecture. Daybreak is warm pearl with inky text,
a violet primary and sea-glass success; Afterglow is deep indigo with lilac
accents and mint indicators. Both are first-class: the contrast audit runs the
same requirements against each.

Tokens live as CSS custom properties in `packages/ui/src/tokens.css`. The audit
(`contrast.test.ts`) parses **that file** and measures each declared pair, so a
hand-edited hex that fails contrast breaks a test rather than shipping.

Measured corrections made while building this (the starting palette was a
starting point, not a claim):

- `--border-strong` failed the 3:1 non-text requirement (2.08:1 Daybreak,
  2.30:1 Afterglow). Strengthened to `#7a8bab` / `#6b77b8`.
- Coral `#d94a66` stays decorative only: it is 4.10:1 on white, so it is not a
  status text colour. Status text uses the measured `--critical` token instead.
- `--primary` was darkened from `#6346df` to `#5a3ed0` for a more comfortable
  margin on the primary button label (6.9:1).

Current measured values (Daybreak / Afterglow): body ink on surface 15.9 / 14.4;
muted on surface 6.8 / 8.5; primary button label 6.9 / 8.3; success 5.8 / 8.9;
attention 6.6 / 9.4; critical 6.2 / 8.6; focus ring 9.3 / 11.5 (all ≥ AA, body
ink ≥ AAA).

## Typography, spacing, motion

- System UI stack only (`system-ui`, Segoe UI Variable, Roboto…), with a mono
  stack for identifiers and logs. No webfont is bundled or requested.
- Body 0.9375 rem (15 px) at 1.55 line height; display sizes step through
  `--text-md` to `--text-xl`. Compact density reduces sizes, never the
  information architecture.
- 8 px spacing rhythm with 4 px half-steps; radii 8/12/16 px; three restrained
  shadows.
- Motion is 120–180 ms for state transitions, `cubic-bezier(0.2, 0, 0.1, 1)`.
  `prefers-reduced-motion` zeroes every duration, and the skeleton animation is
  disabled under it. Nothing animates continuously except a loading skeleton,
  which disappears when content arrives.

## Density

`data-density="comfortable" | "compact"` on the document element retunes row
height, padding, gap and type scale. The same components and the same order of
information are used in both; compact is not a different layout.

## Components

`packages/ui/src/primitives.tsx`: Button (primary/secondary/ghost/danger, two
sizes), Field, Select, Badge, Card, Inspector, EmptyState, Skeleton, ErrorState,
Notification.
`packages/ui/src/overlay.tsx`: Dialog, Menu, Tabs.

Accessibility decisions that are enforced by tests, not just intended:

- **Badges carry a glyph and a word.** `✓ success`, `! attention`, `✕ critical`,
  `i info`, `○ neutral`. Colour only reinforces them.
- **Fields** associate label, hint and error; an error sets `aria-invalid` and a
  `role="alert"` message referenced by `aria-describedby`.
- **Dialog** is `aria-modal`, labelled by its title, moves focus inside on open,
  keeps Tab inside, closes on Escape, and returns focus to the opener.
- **Menu** moves with ArrowUp/ArrowDown, closes on Escape and restores focus to
  its trigger.
- **Tabs** use roving `tabIndex` with ArrowLeft/Right/Home/End and
  `aria-selected`/`aria-controls`.
- **Notifications** are `role="status"` (polite) or `role="alert"` (assertive for
  critical), so a stream of tokens never announces itself but a failure does.
- **Focus** is a 2 px `--focus` ring with a 2 px offset, applied to
  `:focus-visible` only.

## Visual harness

`Harness` renders home, project studio, work board, cost lens, blocker card,
settings, and a non-happy-state board. It is **fixture data** and says so in a
banner on every screen (`Visual development harness — fixture data, not live
state`). It is reachable only with `?harness=1` (plus `theme`, `density`,
`screen`), which is how the screenshot runner drives it.

The fixtures deliberately include: a very long project name and path, a long
task title, unknown cost next to known cost, disconnected runtime, blocked task
with attempt count, dense event list, and permission labels.

## Evidence

`docs/evidence/P06-shots.json` lists 34 screenshots in `docs/evidence/shots/`:
seven screens plus a viewport shot in both themes × both densities at 1280×800,
one 1920×1080 shot, and one 200% (device pixel ratio 2) shot. Each audit entry
records duplicate ids (0), unnamed controls (0), colour-only statuses (0),
external resources (0), the keyboard focus trail (14 stops), and whether the
focus rule ships and paints.

`docs/evidence/P06-tests.txt` covers the contrast audit and the component
behaviour tests (148 Vitest total; 16 new here).
