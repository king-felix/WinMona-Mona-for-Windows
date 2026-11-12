# Third-party notices

Mona is distributed with the components below. Each keeps its own license; this file records
what is bundled, what is only used to build, and what is not bundled at all. Full license texts
for the Electron/Chromium runtime ship inside the installed program tree as
`LICENSES.chromium.html` and `LICENSE`.

## Bundled at runtime

| Component           | Version              | License                         | Role                                                   |
| ------------------- | -------------------- | ------------------------------- | ------------------------------------------------------ |
| Electron            | 45.3.0               | MIT                             | Desktop runtime                                        |
| Chromium            | (inside Electron 45) | BSD-3-Clause and other licenses | Renderer engine; full text in `LICENSES.chromium.html` |
| Node.js             | (inside Electron)    | MIT                             | Main-process runtime                                   |
| node-pty            | 1.1.0                | MIT                             | ConPTY bindings for Mona's own terminal                |
| @xterm/xterm        | 6.0.0                | MIT                             | Terminal renderer                                      |
| @xterm/addon-fit    | 0.11.0               | MIT                             | Terminal sizing                                        |
| @xterm/addon-search | 0.16.0               | MIT                             | Terminal search                                        |
| react               | 19.3.1               | MIT                             | Renderer UI                                            |
| react-dom           | 19.3.1               | MIT                             | Renderer UI                                            |
| scheduler           | 0.28.0               | MIT                             | React scheduling                                       |
| zod                 | 4.6.7                | MIT                             | Schema validation in contracts, adapter and state      |

## Build and test only (not shipped)

| Component         | Version | License    | Role                                        |
| ----------------- | ------- | ---------- | ------------------------------------------- |
| esbuild           | 0.28.2  | MIT        | Preload bundling                            |
| vite              | 8.3.8   | MIT        | Renderer bundling                           |
| typescript        | 6.0.3   | Apache-2.0 | Compilation and type checking               |
| vitest            | 5.1.0   | MIT        | Unit and component tests                    |
| prettier          | 3.10.0  | MIT        | Formatting                                  |
| eslint            | 10.14.0 | MIT        | Linting                                     |
| @eslint/js        | 10.0.1  | MIT        | ESLint configuration                        |
| typescript-eslint | 8.72.2  | MIT        | TypeScript lint rules                       |
| happy-dom         | 21.0.4  | MIT        | Renderer test environment                   |
| ajv               | 8.20.0  | MIT        | JSON Schema validation in the build utility |

## Not bundled

- **Codewhale** (engine). Installed and licensed separately by its publisher; Mona drives it
  through its documented runtime API and does not redistribute it. See
  <https://github.com/codewhale-hq/Codewhale>.
- **DeepSeek API**. A service, not a library. Usage and pricing are governed by DeepSeek's terms
  and your account. Mona records what the engine reports and does not guarantee prices.
- **The Windows App SDK / MakeAppx / SignTool toolchain.** Downloaded into
  `node_modules/.cache/mona-build-tools` by `tools/install/fetch-tools.mjs` for packaging only;
  it is not part of the installed program.

## Attribution requirement

If you redistribute an installed Mona, keep `LICENSE` and `LICENSES.chromium.html` next to
`Mona.exe`. Removing them does not remove the licenses.
