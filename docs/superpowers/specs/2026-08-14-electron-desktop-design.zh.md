# 设计：deepseek-harness 的 Electron 桌面应用（macOS + Windows）

[English](2026-08-14-electron-desktop-design.md) | 中文

日期：2026-08-14

Status: implemented

分支：feat/desktop-app

已实现：已交付的决策见[桌面壳 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md)。

## 目标

为 macOS（Apple Silicon，可选 x64）和 Windows（x64）交付一个 Electron 桌面应用：在进程内嵌入 harness 宿主，复用现有 web 客户端壳，并由 GitHub Actions 工作流打包成安装程序（mac：dmg + zip；win：NSIS exe）。

这是 GUI 分层笔记（`.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`）中预留的 Electron 设计："未来的 Electron 应用通过 IPC fetch 载体复用同一套 web 客户端包"以及"Electron 不复用 [webserver]"。

## 已批准的决策（来自 brainstorming）

1. **形态**：内嵌宿主 + IPC 传输层（预留架构）。单进程应用；Electron 主进程按现有装配模式启动宿主；渲染进程通过 IPC `doFetch` 载体复用 `dsh-client-web` 壳。
2. **签名**：v1 不签名。CI 上设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 和 `mac.identity: null`；签名可之后通过 secrets 添加。
3. **产物**：macOS dmg + zip；Windows NSIS exe（x64）。无 portable 构建。
4. **打包器**：electron-builder。
5. **Electron 版本**：`electron@^43`（2026 年 6 月稳定版，内置 Node 24.18.0，满足仓库的 `node: ^22.19.0 || >=24.0.0` 引擎要求）。

## 架构

### 仓库布局

新 workspace `apps/desktop`（`@deepseek-ai/dsh-desktop`，私有）。`apps/` 存放对外导出的应用；装配留在应用内（仓库约定：混合物恰好只有一个消费方，即它自己的应用）。

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

### 进程模型

- **主进程**：启动宿主插件图（与 `dsh web` 相同的能力集：session、shell、subprocess、llm、web……）加 apiproxy handler。它**不**导入 `dsh-host-webserver`（按分层笔记）。`persistenceRoot` 指向 `app.getPath('userData')/dsh`。注册 `ipcMain.handle('dsh:fetch', ...)` 桥，后端是进程内 fetch handler（来自 `dsh-host-apiproxy` 的 `toFetchHandler(api)`）。
- **Preload**：`contextBridge.exposeInMainWorld('dsh', ...)`，窄表面：`fetchRequest(url, init)`（invoke）和流订阅。不暴露裸 ipcRenderer；`contextIsolation: true`、`nodeIntegration: false`。
- **渲染进程**：现有的 `AppWebEntry` 壳（`dsh-client-web`），带接缝：
  - 主进程注入 `window.__DSH_BOOT__` manifest（从宿主图序列化，镜像 webserver 通过 HTTP 注入的内容）。
  - `BootSeams.loadBundle` 通过 IPC 实现，插件 bundle 从磁盘读取而不受 `file://` fetch 限制。
  - 线上客户端是 `IpcApiClient` 而非 `WebApiClient`；`dsh-client-connection` 插件获得一个接缝来选择它（沿用现有的 `fixtureClient` 先例，见 `packages/client/connection/src/client/index.ts:88`）。

### IPC fetch 载体（核心新代码）

协议不变式：四象限 RPC 模型（`api/rpc.ts`）和 `AbstractApiClient` 基类**不变**。载体纯粹是传输方面——一个 `doFetch` 子类，正如分层笔记中子类表预留的那样（"IPC bridge subclass … would swap only doFetch"）。

- 渲染进程 → 主进程（请求）：`ipcRenderer.invoke('dsh:fetch', { url, init })`。
- 主进程 → 渲染进程（响应）：handler 运行进程内 fetch handler；HTTP status/headers 信封作为 invoke 的解析值返回；SSE body 经 `webContents.send('dsh:stream', { streamId, chunk|end })` 流式传输。
- 渲染进程：`IpcApiClient.doFetch` 组装一个带 `ReadableStream` 的 `Response`，由流事件喂入，因此 `callUnary`、`readSse`、`respond` 原样运行在真实的线上序列化上（zod、`\n\n` 分帧、rpcId 回显检查）。

桥的分帧逻辑（请求序列化、流分块、响应重组）放在 `src/ipc/`，是 Electron-free 模块——可以用 vitest 测试而无需启动 Electron，协议级断言复用 `InProcessApiClient` 的 handler 注入。

### 依赖

- devDependencies（apps/desktop）：`electron@^43`、`electron-builder`、`vite`（workspace 级）、`@types/node`。
- 渲染进程与宿主包通过 pnpm workspace（`workspace:*`）解析，因此不需要新发布的包。
- `node-pty`（原生，来自 `dsh-subprocess-local`）必须为 Electron ABI 重建；electron-builder 的 `npmRebuild` 在 CI 上处理（Windows/macOS runner 自带所需构建工具链）。
- `pnpm-workspace.yaml` 无需改动。`apps/desktop` 有自己的 `tsconfig.json`（继承 `tsconfig.base.json`，类似 `apps/web`）；按 host/client 组命名规则，它为每个 `packages/host/*` 和 `packages/client/*` 依赖（包括 `/client` 子路径）携带显式 `paths` 条目，与仓库其余部分一样解析到 `src`。

### 打包（electron-builder）

- appId：`ai.deepseek.dsh`；productName：`DeepSeek Harness`。
- 目标：`mac: { target: [dmg, zip], identity: null }`、`win: { target: nsis }`（x64）。
- Files：构建后的宿主 `lib/` 闭包、渲染进程 `dist/`、收集的插件客户端 bundle（`dist/bundles/<package>/client.js`——应用构建期间由 `scripts/collect-bundles.mjs` 从每个 web 客户端插件构建出的 `lib/client.js` 拷贝）、electron-builder 配置、资源（图标）。其余全是 dev。
- 图标：`scripts/generate-icon.mjs` 用 sharp 把官方 favicon 的深色变体（圆角 `#1F2430` 方块上的白色鱼）渲染为 `build/icon.png`；electron-builder 从中派生 icns/ico。v1 无品牌美术素材。

## GitHub Actions 工作流

`.github/workflows/desktop-release.yml`，参照仓库现有 CI 模式（`build-exe-for-python-sdk.yml`）：

- 触发器：`workflow_dispatch`（手动）和推送 `desktop-v*` 标签（发布一个 GitHub Release，安装程序作为资产）。
- 矩阵：`macos-latest`（arm64）和 `windows-latest`（x64）——`macos-13`（x64）行已删除，因为 GitHub 已于 2025 年 12 月退役 macos-13（Intel）runner。
- 步骤：`actions/checkout@v6` → `pnpm/action-setup` → `actions/setup-node@v6`（node 24，pnpm 缓存）→ `pnpm install --frozen-lockfile` → 构建（`build:lib`，然后 `tsc -p apps/desktop --noEmit` 类型检查，再构建桌面应用——主进程、渲染进程和收集的客户端 bundle）→ `pnpm --filter @deepseek-ai/dsh-desktop exec electron-builder --mac|--win` → 上传产物；推送标签时附加到 release。
- env：`DSH_TELEMETRY_DISABLED=1`（仓库约定：CI 永不向生产遥测端点上报）。
- 未签名构建：`CSC_IDENTITY_AUTO_DISCOVERY=false`、`mac.identity: null`。
- 冒烟：在每台 runner 上传前用 `--smoke-test` 启动打包应用；应用只有在渲染进程报告已启动（`dsh:booted`，30 秒超时）后才以 0 退出，因此白屏或死掉的渲染进程会让该 lane 失败。

## 测试

- 单元：用 vitest 测 `src/ipc/` 桥的分帧（请求信封、分块分帧、重组、错误传播）；通过 `InProcessApiClient` 的 handler 注入做协议级断言，不涉及真实 fetch/网络。
- 装配冒烟：主进程宿主启动路径的无 key 启动测试（镜像仓库的非单元 REAL-composition 测试策略：经 Loader 启动，只 mock 外部服务）。
- 每个 OS 打包后在 CI 冒烟。
- 按仓库策略，非平凡改动在同一 PR 中附带 Agent Note（`.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md` + zh）和 README 更新。

## 超出范围（v1）

- 代码签名/公证（macOS Gatekeeper 和 Windows SmartScreen 会出现警告；在 README 中记录）。
- 自动更新（electron-updater）——选择 zip 产物形态是为将来支持它。
- Linux 桌面构建。
- WebSocket 式下行载体——IPC 桥通过与进程内 fetch 载体相同的 `readSse` 路径携带 SSE 分帧。
