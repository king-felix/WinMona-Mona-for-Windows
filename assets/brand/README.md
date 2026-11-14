# Mona brand artwork

`MidnightMona.png` is the approved Mona mark: a dark rounded tile carrying a
gradient ribbon "M". It is the source of every icon Mona ships. Nothing in this
directory is drawn, recoloured or re-created by hand.

## Provenance

- Source file: `MidnightMona.png` (1254 × 1254, 8-bit RGBA, non-interlaced).
- sha256: `cebc87174132…` — the exact value is recorded verbatim in
  `generated/manifest.json` under `source.sha256`.
- Supplied by Victor on 2026-11-14 as the new logo. It arrived in the repository
  root and was moved here unchanged.

## Generated derivatives

`generated/` is produced by `tools/assets/build-icons.mjs` from the source
bytes. Run `npm run assets:icons` to regenerate and `npm run assets:check` to
prove the committed files still match. `npm test` runs the check.

The pipeline:

1. decodes the PNG itself (no image dependency, so a build needs nothing extra);
2. crops to a centred square around the artwork's alpha bounding box with 2%
   padding, so the tile is not left floating in a wide transparent margin;
3. resamples with a coverage-weighted box filter in premultiplied alpha, which
   avoids the grey fringe that straight-RGBA averaging leaves on the edges;
4. writes `mona-16…256.png`, a multi-size `mona.ico`, and the three package
   images `AppxManifest.xml` declares (`StoreLogo.png` 50, `Square44x44Logo.png`
   44, `Square150x150Logo.png` 150).

`apps/desktop/src/renderer/assets/mona-mark.png` is a verified copy of
`mona-128.png` for the in-app header, kept in the Vite root so the renderer can
import it as a module asset.

## Where the artwork is displayed

- Window and taskbar icon: `mona.ico`, loaded by the main process.
- Notification-area tray: `mona-32.png`.
- In-app header: the 128 px copy in the renderer.
- Start menu / installed identity: the three package images above.

## Known limitation

At 16 px the ribbon detail collapses into the dark tile; the shape still reads
as a distinct app icon but the "M" does not. A dedicated small-size variant
would need artwork that does not exist yet, so none was invented. This is
recorded as open work rather than treated as finished.

The packaged `Mona.exe` is a renamed Electron binary, so its _embedded_
executable icon is still Electron's; changing it needs a PE resource editor that
this repository does not currently carry. Window, taskbar, tray, Start and
package surfaces all carry the approved mark.
