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
4. writes `mona-16…256.png`, a multi-size little-endian `mona.ico`, and the three
   package images `AppxManifest.xml` declares (`StoreLogo.png` 50, `Square44x44Logo.png`
   44, `Square150x150Logo.png` 150).

The ICO container is **little-endian**, which is what Windows and Chromium read. The first
version of the encoder wrote big-endian fields: Windows read the file as type 256 with 1792
directory entries, and Electron's `nativeImage` returned an empty image, so the window and
taskbar icon had silently been missing. `tests/assets` now reads the directory the way
Windows does, and `npm run assets:check` fails if the bytes drift.

## The executable's own icon

`Mona.exe` is the Electron runtime renamed, so its PE resource section still carries
Electron's icon group. `tools/assets/embed-exe-icon.mjs` replaces `RT_GROUP_ICON` and
`RT_ICON` with the seven images from `mona.ico` while leaving every other resource (version
information, manifest, string tables) byte-for-byte intact. The installer calls it on the
staged executable, so a stage cannot ship Electron's artwork by accident.

The rewrite is a pure function of (executable bytes, ICO bytes): it keeps the resource RVA,
moves the base-relocation section past the grown resource section, updates `SizeOfImage`,
and appends the new resource bytes at the end of the file. Running it twice produces the
same bytes. It refuses a signed input rather than shipping a stale signature. Electron's
distributed `electron.exe` is unsigned, so nothing is invalidated here.

Verification on 2026-11-14: the installed `Mona.exe` carries all seven images byte-identical
to `mona.ico`; Windows `ExtractIconEx` returns 16 px and 32 px bitmaps that match
`mona-16.png` and `mona-32.png` exactly (mean and maximum channel difference 0); Electron's
`nativeImage` decodes the ICO at 256 px. See `docs/evidence/W12-icons.md`.

`apps/desktop/src/renderer/assets/mona-mark.png` is a verified copy of
`mona-128.png` for the in-app header, kept in the Vite root so the renderer can
import it as a module asset.

## Where the artwork is displayed

- Window and taskbar icon: `mona.ico`, loaded by the main process.
- The executable's embedded icon group: written by `tools/assets/embed-exe-icon.mjs`
  during staging, so Explorer, Task Manager and unpinned taskbar entries show Mona.
- Notification-area tray: `mona-32.png`.
- In-app header: the 128 px copy in the renderer.
- Start menu / installed identity: the three package images above.

## Known limitation

At 16 px the ribbon detail collapses into the dark tile; the shape still reads
as a distinct app icon but the "M" does not. A dedicated small-size variant
would need artwork that does not exist yet, so none was invented. This is
recorded as open work rather than treated as finished.
