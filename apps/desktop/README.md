# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The harness as a desktop application: an Electron shell that embeds the host plugin graph in the main process and runs the shared web client shell in a sandboxed renderer over an IPC fetch carrier — no HTTP, no listening ports. Installers target macOS (Apple Silicon; dmg + zip) and Windows (x64; NSIS exe). The [Electron desktop design spec](../../docs/superpowers/specs/2026-08-14-electron-desktop-design.md) is the plan; the [desktop shell Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md) records the shipped decisions.

## Architecture

Three processes plus one Electron-free bridge core (`src/ipc/`):

| Process | Files | Responsibility |
|---|---|---|
| Main | `src/main/index.ts`, `host.ts`, `ipc-bridge.ts`, `manifest.ts` | Boots the host with `dsh-app-boot.boot()` (no webserver), registers the `dsh:fetch` / `dsh:stream` / `dsh:load-bundle` / `dsh:boot-manifest` channels, opens the window |
| Preload | `src/preload/index.ts` | The `window.dsh` contextBridge surface — `fetchRequest`, `onStream`, `loadBundle`, `bootManifest`; no raw IPC exposure |
| Renderer | `src/renderer/main.tsx`, `transport.ts` | The shared `AppWebEntry` shell over the desktop IPC transport |

Persistence lives under the OS user-data directory: the Electron entry sets `DSH_HOME` to `userData/dsh` before the host boots. Plugin client bundles and the boot manifest (`{ rev, entries }`) ride the same IPC channels instead of the webserver's HTTP injection.

## Development

Built artifacts come first. From the repository root, `pnpm run build:lib` builds the host and client libraries — including the client bundles the desktop boot manifest scans — then build the app itself:

```sh
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-desktop run build
```

Run from source (a real GUI session is required):

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

Package installers (dmg/zip on macOS, NSIS on Windows):

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist       # installers
pnpm --filter @deepseek-ai/dsh-desktop run dist:dir   # unpacked app only
```

Smoke test: the packaged app accepts `--smoke-test` — it boots the host, opens a window, prints `dsh-desktop smoke OK`, and exits 0. CI runs it after packaging on each matrix target.

## Known Limitations and Deferred Work

- **Unsigned v1**: no code signing or notarization; macOS Gatekeeper and Windows SmartScreen show warnings when users first open the app. CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and `mac.identity: null`; signing can be added later via secrets.
- **No auto-update**: electron-updater is not wired; the zip artifact shape is chosen to support it later.
- **No macOS x64 installer**: GitHub retired the macos-13 (Intel) runner in December 2025; the CI matrix builds macos-arm64 and windows-x64.
- **Abort-path listener residue**: an aborted fetch leaves the renderer transport's stream listener installed until a transport API change (recorded follow-up).
- **Agent presets not composed**: the session-creation preset plane is not wired into the desktop config.
