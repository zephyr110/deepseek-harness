# Design: Electron desktop app for deepseek-harness (macOS + Windows)

Date: 2026-08-14
Status: approved
Branch: feat/desktop-app

## Goal

Ship an Electron desktop application for macOS (Apple Silicon, optionally x64)
and Windows (x64) that embeds the harness host in-process, reuses the existing
web client shell, and is packaged into installers (mac: dmg + zip; win: NSIS
exe) by a GitHub Actions workflow.

This is the Electron design reservation from the GUI layering note
(`.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`):
"a future Electron application reuses the same web client packages over an IPC
fetch carrier" and "Electron does not reuse [webserver]".

## Approved decisions (from brainstorming)

1. **Form**: embedded host + IPC transport (the reserved architecture). A
   single-process app; the Electron main process starts the host via the
   existing assembly pattern; the renderer reuses the `dsh-client-web` shell
   over an IPC `doFetch` carrier.
2. **Signing**: none in v1. `CSC_IDENTITY_AUTO_DISCOVERY=false` and
   `mac.identity: null` on CI; signing can be added later via secrets.
3. **Artifacts**: macOS dmg + zip; Windows NSIS exe (x64). No portable build.
4. **Packager**: electron-builder.
5. **Electron version**: `electron@^43` (stable June 2026, bundles Node
   24.18.0, satisfying the repo's `node: ^22.19.0 || >=24.0.0` engine).

## Architecture

### Repository layout

New workspace `apps/desktop` (`@deepseek-ai/dsh-desktop`, private). `apps/`
holds externally exported applications; assembly stays in the app (repo
convention: a mixture has exactly one consumer, its own app).

```
apps/desktop
  src/
    main/        Electron main process (host boot, IPC fetch bridge, window lifecycle)
    preload/     contextBridge surface
    renderer/    vite entry over the dsh-client-web shell (thin, like apps/web)
    ipc/         Electron-free IPC bridge core (fetch request/stream framing) — unit-testable
  package.json   electron-builder config + scripts
  electron-builder.yml
```

### Process model

- **Main process**: boots the host plugin graph (the same capability set as
  `dsh web`: session, shell, subprocess, llm, web, …) plus the apiproxy
  handler. It does **not** import `dsh-host-webserver` (per the layering note).
  `persistenceRoot` points at `app.getPath('userData')/dsh`. Registers an
  `ipcMain.handle('dsh:fetch', ...)` bridge backed by the in-process fetch
  handler (`toFetchHandler(api)` from `dsh-host-apiproxy`).
- **Preload**: `contextBridge.exposeInMainWorld('dsh', ...)` with a narrow
  surface: `fetchRequest(url, init)` (invoke) and stream subscription.
  No raw ipcRenderer exposure; `contextIsolation: true`, `nodeIntegration:
  false`.
- **Renderer**: the existing `AppWebEntry` shell (`dsh-client-web`) with
  seams:
  - `window.__DSH_BOOT__` manifest injected by the main process (serialized
    from the host graph, mirroring what the webserver injects over HTTP).
  - `BootSeams.loadBundle` implemented over IPC so plugin bundles read from
    disk without the `file://` fetch restriction.
  - The wire client is `IpcApiClient` instead of `WebApiClient`; the
    `dsh-client-connection` plugin gains a seam to select it (following the
    existing `fixtureClient` precedent at
    `packages/client/connection/src/client/index.ts:88`).

### IPC fetch carrier (the core new code)

Protocol invariant: the four-quadrant RPC model (`api/rpc.ts`) and the
`AbstractApiClient` base class are **unchanged**. The carrier is purely the
transport aspect — one `doFetch` subclass, as the subclass table in the
layering note reserves ("IPC bridge subclass … would swap only doFetch").

- Renderer → main (request): `ipcRenderer.invoke('dsh:fetch', { url, init })`.
- Main → renderer (response): handler runs the in-process fetch handler; the
  HTTP-status/headers envelope returns as the invoke resolution; the SSE body
  streams over `webContents.send('dsh:stream', { streamId, chunk|end })`.
- Renderer: `IpcApiClient.doFetch` assembles a `Response` with a
  `ReadableStream` fed by the stream events, so `callUnary`, `readSse`, and
  `respond` run unchanged against the real wire serialization (zod,
  `\n\n` framing, rpcId echo checks).

The bridge framing logic (request serialization, stream chunking, response
reassembly) lives in `src/ipc/` as Electron-free modules — testable with
vitest without launching Electron, reusing the `InProcessApiClient` handler
injection for the protocol-level assertions.

### Dependencies

- devDependencies (apps/desktop): `electron@^43`, `electron-builder`,
  `vite` (workspace-level), `@types/node`.
- The renderer and host packages resolve through the pnpm workspace
  (`workspace:*`), so no new published packages are required.
- `node-pty` (native, from `dsh-subprocess-local`) must be rebuilt for the
  Electron ABI; electron-builder's `npmRebuild` handles this on CI
  (Windows/macOS runners carry the needed build toolchains).
- `pnpm-workspace.yaml` does not need changes. `apps/desktop` gets its own
  `tsconfig.json` (extending `tsconfig.base.json`, like `apps/web`); per the
  host/client group naming rule it carries explicit `paths` entries for every
  `packages/host/*` and `packages/client/*` dependency (including the `/client`
  subpaths), resolved to `src` like the rest of the repo.

### Packaging (electron-builder)

- appId: `ai.deepseek.dsh`; productName: `DeepSeek Harness`.
- Targets: `mac: { target: [dmg, zip], identity: null }`,
  `win: { target: nsis }` (x64).
- Files: built host `lib/` closure, renderer `dist/`, plugin client bundles
  (`lib/client.js` per client plugin), electron-builder config, resources
  (icon). Everything else is dev.
- Icons: a simple generated icon set (icon.icns / icon.ico) under
  `apps/desktop/build/`; no brand art v1.

## GitHub Actions workflow

`.github/workflows/desktop-release.yml`, modeled on the repo's existing CI
patterns (`build-exe-for-python-sdk.yml`):

- Triggers: `workflow_dispatch` (manual) and push of tag `desktop-v*`
  (publishes a GitHub Release with the installers as assets).
- Matrix: `macos-latest` (arm64), `macos-13` (x64), `windows-latest` (x64).
- Steps: `actions/checkout@v6` → `pnpm/action-setup` →
  `actions/setup-node@v6` (node 24, pnpm cache) →
  `pnpm install --frozen-lockfile` → build (`build:lib` + `build:web` +
  desktop renderer) → `pnpm --filter @deepseek-ai/dsh-desktop exec
  electron-builder --mac|--win` → upload artifacts; on tag push, attach to the
  release.
- env: `DSH_TELEMETRY_DISABLED=1` (repo convention: CI never reports to the
  production telemetry endpoint).
- Unsigned build: `CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity: null`.
- Smoke: launch the packaged app briefly on each runner (`--version`-style
  smoke or app-exit check) before upload.

## Testing

- Unit: the `src/ipc/` bridge framing (request envelope, chunk framing,
  reassembly, error propagation) with vitest; protocol-level assertions via
  the `InProcessApiClient` handler injection so no real fetch/network is
  involved.
- Assembly smoke: a keyless launch test of the main-process host boot path
  (mirroring the repo's non-unit REAL-composition test policy: boot through
  the Loader, mock only external services).
- CI smoke after packaging on each OS.
- Per repo policy, non-trivial changes include an Agent Note in the same PR
  (`.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md`
  + zh), plus README updates.

## Out of scope (v1)

- Code signing / notarization (macOS Gatekeeper and Windows SmartScreen
  warnings will appear; documented in README).
- Auto-update (electron-updater) — the zip artifact shape is chosen to
  support it later.
- Linux desktop build.
- WebSocket-style downlink carrier — the IPC bridge carries SSE framing
  through the same `readSse` path as the in-process fetch carrier.
