# Approved Mona artwork applied (2026-11-14)

Requested by Victor: "MidnightMona.png is the new logo, and it's to be used anywhere you currently
have the new logo displayed." This record covers what was replaced, what proves it, and what is
still open. It is not a W12 completion: W12 also requires installed-icon inspection at small and
large sizes and high DPI.

## Source and provenance

- Source: `assets/brand/MidnightMona.png`, moved unchanged from the repository root.
  sha256 `cebc871741323a49e556d633fbf0e656a6134bb4c6c4b839ce13a67963df41be`,
  1254 × 1254, 8-bit RGBA, non-interlaced.
- Pipeline: `tools/assets/build-icons.mjs`. Deterministic; no timestamps or ancillary chunks in
  any output. Crops to a centred square around the alpha bounding box (1134 px) with 2 % padding,
  then resamples with a coverage-weighted box filter in premultiplied alpha.
- Manifest with every generated size and hash: `assets/brand/generated/manifest.json`.
- `npm run assets:check` is part of `npm run ci` and fails if any committed derivative drifts from
  the source.

## Surfaces replaced

| Surface | Before | Now |
|---|---|---|
| In-app header mark | Letter "M" in a coloured square (CSS) | `mona-128.png` as an `<img>` (see `app-header.png`) |
| Window / taskbar icon | Not set — Electron default | `mona.ico` (16–256 px, PNG-compressed entries) |
| Notification-area tray | Hardcoded 32 px hand-drawn data URL | `mona-32.png` loaded from `dist/resources/icons` |
| MSIX identity package | Three solid purple rectangles | `StoreLogo.png` (50), `Square44x44Logo.png` (44), `Square150x150Logo.png` (150) |

`apps/desktop/src/main/tray-icon.ts` was deleted rather than left as an unused stale logo. A
missing icon now fails loudly: the tray reports `tray unavailable` in stderr, the installer throws
with the exact missing path and the `npm run assets:icons` command, and `copy-icons.mjs` refuses to
build a stage without the artwork.

## What was verified

- `npm test` — icon pipeline (11 cases: declared sizes, ICO directory vs payload, transparent
  corners, byte stability, `--check`, renderer copy) and package-artwork guards.
- `npm run build` — the renderer emits `assets/mona-mark-DS6ZO2Ay.png`; `copy-icons` reports
  `copied 5 brand icons`.
- `npm run surfaces` — 26/26 steps on the rebuilt app, 4 screenshots; the header capture in this
  directory shows the mark rendering.
- `npm run ci` — exit 0 (assets check, format, lint, typecheck, tests, build).

## Open, recorded rather than hidden

1. **16 px legibility.** The faithful downscale reads as a dark tile at 16 px; the ribbon detail
   collapses. A dedicated small-size mark would need artwork that does not exist, so none was
   invented.
2. **`Mona.exe` embedded icon.** The packaged executable is a renamed Electron binary and still
   carries Electron's icon resources. Changing them needs a PE resource editor that this repository
   does not carry. Window, taskbar, tray, header and package surfaces all carry the approved mark.
3. **Installed inspection.** The MSIX tile and Start entry were not opened and photographed after
   repackaging; the package images are size-checked against the manifest but not seen on screen.
4. **`npm run smoke` is currently red for an unrelated reason.** Its preload-key allowlist was last
   updated at P19, while P24/P25 added keys. That gate was not touched here.
