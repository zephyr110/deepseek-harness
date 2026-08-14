# Agent Note: The Electron desktop shell — an embedded harness host over an IPC fetch carrier

Status: implemented

English | [中文](2026-08-14-electron-desktop-shell.zh.md)

> Division of labor: the four-quadrant RPC protocol and the client carrier class family are owned by the [GUI layering and RPC protocol note](2026-07-19-gui-layering-and-rpc-protocol.md); this note records the desktop application's own decisions — the IPC fetch carrier, the webserver-free host boot, the client-connection seam, the manifest and bundle channels, and the unsigned v1 packaging. The design plan is the [Electron desktop design spec](../../../../docs/superpowers/specs/2026-08-14-electron-desktop-design.md).

## Problem

The [GUI layering note](2026-07-19-gui-layering-and-rpc-protocol.md) reserves "a future Electron application reuses the same web client packages over an IPC fetch carrier" and "Electron does not reuse [webserver]". `dsh web` reaches the web client over HTTP through `dsh-host-webserver`; a desktop product wants the same harness capability set (session, shell, subprocess, LLM, web tools, …) and the same web client shell, but as a self-contained application: no listening ports, no HTTP carriage, persistence under the OS user-data directory, and a renderer deliberately kept free of Node. The physical channel is new, so the decision is where the channel lives: it must be only the transport aspect, with the protocol, its zod validation, SSE framing, and rpcId discipline untouched.

## Decision

`apps/desktop` (`@deepseek-ai/dsh-desktop`, private workspace) is an Electron 43 application: three processes plus one Electron-free bridge core (`src/ipc/`), assembled entirely from existing packages — no new host or client package.

### Process model

- **Main process** (`src/main/index.ts`, `host.ts`, `ipc-bridge.ts`, `manifest.ts`): boots the host plugin graph with `dsh-app-boot.boot()` and no `dsh-host-webserver` import, registers the `dsh:fetch` / `dsh:stream` / `dsh:load-bundle` / `dsh:boot-manifest` channels, and opens a 1200×800 `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- **Preload** (`src/preload/index.ts`): a `contextBridge` surface named `window.dsh` with exactly five methods — `fetchRequest`, `onStream`, `loadBundle`, `bootManifest`, `booted` (one-way smoke signal: the renderer reports its booted roster size after `AppWebEntry.run()` settles) — and no raw `ipcRenderer` exposure.
- **Renderer** (`src/renderer/main.tsx`, `transport.ts`): requests the boot manifest over IPC, installs `window.__DSH_DESKTOP__`, runs the shared `AppWebEntry` shell from `dsh-client-web` with `loadBundle` implemented over IPC, and sends the `booted` smoke signal after the boot settles.

### The IPC fetch carrier

The carrier is exactly the transport aspect the subclass table reserves: one `doFetch` override, protocol untouched.

- `src/ipc/handler.ts` is the Electron-free bridge core: `createIpcFetchHandler` runs an injected WHATWG fetch face, resolves status and headers immediately, and pushes body chunks to a per-request `streamId` subscriber — events emitted before the renderer subscribes are buffered and replayed on subscribe.
- `src/ipc/framing.ts` is the wire framing: a JSON-string event union (`chunk` / `end` / `error`) carried over `webContents.send('dsh:stream', …)`; the renderer transport polls its mailbox and assembles the stream.
- `IpcApiClient` (`packages/client/connection/src/client/ipc-api-client.ts`) overrides only `doFetch`: it runs the injected `DesktopIpcTransport`, enforces the caller's `AbortSignal` at the IPC hop, and reassembles the event stream into a WHATWG `Response`, so `callUnary`, `readSse`, and `respond` run against the real wire serialization unchanged. The package imports no electron; the transport is injected.
- `dsh-client-connection` selects the carrier at materialization: `fixtureClient ?? window.__DSH_DESKTOP__?.transport ?? new WebApiClient()` — the desktop seam sits between the fixture and the browser default, so serverless UI development keeps working.

### Host boot without a webserver

`src/main/host.ts` boots with `boot('dsh-desktop', CONFIG_URL, HOST_PATCHES)`. `cordis.yml` is a plain Loader entry list, so the base layer is applied the same way the profile loader applies a bundle: `loadOverlayPatches('dsh-desktop', …)` over the desktop's own rows, plus `hmr` disabled (its module-reload lifecycle is untested on long-lived surfaces). The config rows mount the web profile's host rows that do not depend on `webServer` — storage, session, shell, code-runtime, the native directory picker, plugin inventory — and omit the webserver-bound ones. Before boot, the Electron entry sets `process.env.DSH_HOME` to `app.getPath('userData')/dsh`, so every `dshHomePath`-resolved storage lands under the OS user-data directory. The ApiProxy gateway plugin provides `ctx.apiProxy`; `toFetchHandler(apiProxy)` from `dsh-host-apiproxy` is the in-process WHATWG fetch face the bridge runs.

### Manifest and bundle loading over IPC

`src/main/manifest.ts` builds the same wire graph the webserver injects as `window.__DSH_BOOT__` — `{ rev, entries }` with urls `/plugins/<id>/client.js?rev=<rev>` — by scanning the collected bundle root: `scripts/collect-bundles.mjs` (part of the app build) freezes one `<package>/client.js` per web client plugin (`dsh.client.platform === 'web'`, the same discovery dev-web uses) under `apps/desktop/dist/bundles`, which electron-builder packs into the asar. Scanning the workspace instead would break in the packaged app — no URL inside the asar can normalize back to the repository root, so the roster would come back empty — which is why the main entry injects the bundle root explicitly (`app.getAppPath()/dist/bundles` when packaged, `apps/desktop/dist/bundles` in dev). `dsh:load-bundle` resolves those urls back to `<bundle root>/<package>/client.js` through the same scan, so the roster and the resolver cannot disagree. The renderer evaluates a bundle with an inline script that mirrors the default loader's classic async script semantics: the bundle registers its factory with `window.__ModuleLoader__.load` synchronously during the script's execution, which happens synchronously on append — completion is the append itself, because modern Chromium fires the load event only for fetched scripts, never for inline ones (relying on it hung every bundle load and left the boot stuck on the loading page).

### Packaging and release v1

electron-builder packages `@deepseek-ai/dsh-desktop` (`appId: ai.deepseek.dsh`, product name DeepSeek Harness): mac dmg + zip (`identity: null`) and win NSIS x64. The app icon is generated, not drawn: `scripts/generate-icon.mjs` renders the official favicon.svg's dark variant (white fish on a rounded `#1F2430` square) to `build/icon.png` with sharp, rewriting the glyph fill and dropping the `<style>` media query because librsvg never evaluates `prefers-color-scheme`. Signing is deferred: CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. `.github/workflows/desktop-release.yml` builds on `workflow_dispatch` and `desktop-v*` tags with a macos-arm64 + windows-x64 matrix — the macos-x64 row is dropped because GitHub retired the macos-13 (Intel) runner in December 2025 — and there is no `pnpm deploy` closure step: `electron-builder.yml` `files` name `apps/desktop/dist` (main, preload, renderer, `dist/bundles`) and the workspace `node_modules`, and packaging that layout directly is verified locally — the bundles are collected into `dist/bundles`, and packaged scanning is verified by unit tests on fixture bundle roots (the explicit bundle-root injection is thin main-process wiring). The workspace peer dependencies of every desktop dependency are declared as regular dependencies: electron-builder packs only regular dependencies, so a peer satisfied by dev-time hoisting would be missing from the asar (`ERR_MODULE_NOT_FOUND` at host boot) — a packaged boot fails loud until the union is complete. The workflow smokes the packaged app on each runner and attaches the installers to the tag's GitHub Release. `pnpm-workspace.yaml` overrides `@electron/get@^3.0.0` to `^3.1.0`: electron-builder 26.15.3's `app-builder-lib` references `ElectronDownloadCacheMode`, which exists only in `@electron/get >= 3.1.0`, while the declared `^3.0.0` range lets the lockfile pin the stale 3.0.0 (electron 43 keeps its own `@electron/get@^5.0.0`).

## Alternatives considered

- **Reuse `dsh-host-webserver` over a loopback port** — rejected: the host already lives in-process; HTTP carriage would add the port lifecycle, the CORS/auth surface, and a second owner for the same fetch face, and the layering note reserves no-webserver for Electron.
- **A WebSocket-style downlink channel in the renderer** — rejected: SSE framing already rides the base client's `readSse`; the IPC stream channel carries the same event framing with no new protocol surface.
- **Renderer importing host packages directly** — rejected: it would defeat context isolation and the client-side layering discipline; the preload bridge keeps the browser plane free of Node.
- **`pnpm deploy` closure packaging** — rejected: `files` name `apps/desktop/dist` and the workspace `node_modules`; packaging that layout directly is verified locally, and a deploy step would produce a closure electron-builder never packages.
- **macos-x64 in the CI matrix** — rejected: GitHub retired the macos-13 (Intel) runner in December 2025.
- **Hand-drawn icon art** — rejected: the generated dark variant of the official favicon keeps brand consistency with zero art assets.

## Consequences

The protocol surface is unchanged: web and desktop share the client graph, the zod-validated envelopes, and the SSE framing; the desktop's whole novelty is one `doFetch` override plus one seam. The bridge core is Electron-free, so six vitest suites (`host-boot`, `ipc-bridge`, `ipc-framing`, `ipc-handler`, `manifest`, `renderer-transport`) cover boot, framing, streaming, the manifest, and transport ordering and termination without launching Electron, and the packaged app is smoke-tested on CI runners — `--smoke-test` exits 0 only after the renderer reports its booted roster over `dsh:booted` (30s timeout, then exit 1), so a white or dead renderer fails the lane instead of passing on `did-finish-load`. The renderer stays a thin shell: all composition lives in the host graph. v1 ships unsigned and un-updated: Gatekeeper/SmartScreen warnings on first open, no auto-update, no macOS x64 installer, and an aborted fetch leaves the renderer transport's stream listener installed until a transport API change (recorded follow-up). agent-presets are not composed: the session-creation preset plane is not wired into the desktop config. The `@electron/get` override pins a dependency-version conflict that only electron-builder's packaging path hits; it is a pnpm-workspace-level decision with a comment recording the reason.
