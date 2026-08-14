# Agent Note: Electron 桌面壳——内嵌宿主与 IPC fetch 载体

Status: implemented

[English](2026-08-14-electron-desktop-shell.md) | 中文

> 分工：四象限 RPC 协议和客户端载体类家族由 [GUI 分层与 RPC 协议笔记](2026-07-19-gui-layering-and-rpc-protocol.md) 负责；本笔记记录桌面应用自身的决策——IPC fetch 载体、无 webserver 的宿主启动、client-connection 接缝、manifest 与 bundle 通道，以及 v1 未签名打包。设计方案见 [Electron 桌面设计 spec](../../../../docs/superpowers/specs/2026-08-14-electron-desktop-design.md)。

## 问题

[GUI 分层笔记](2026-07-19-gui-layering-and-rpc-protocol.md) 预留了"未来的 Electron 应用通过 IPC fetch 载体复用同一套 web 客户端包"以及"Electron 不复用 [webserver]"。`dsh web` 通过 `dsh-host-webserver` 以 HTTP 触达 web 客户端；桌面产品想要同一套 harness 能力集（session、shell、subprocess、LLM、web 工具……）和同一个 web 客户端壳，但作为自包含应用：不监听端口、无 HTTP 传输、持久化落在操作系统用户数据目录下，且渲染进程刻意不接触 Node。物理通道是新的，因此决策在于通道放在哪里：它必须只是传输方面，协议、zod 校验、SSE 分帧和 rpcId 纪律全部保持不变。

## 决策

`apps/desktop`（`@deepseek-ai/dsh-desktop`，私有 workspace）是一个 Electron 43 应用：三个进程加一个 Electron-free 的桥核心（`src/ipc/`），完全由现有包组装——不新增任何 host 或 client 包。

### 进程模型

- **主进程**（`src/main/index.ts`、`host.ts`、`ipc-bridge.ts`、`manifest.ts`）：用 `dsh-app-boot.boot()` 启动宿主插件图，不导入 `dsh-host-webserver`，注册 `dsh:fetch` / `dsh:stream` / `dsh:load-bundle` / `dsh:boot-manifest` 通道，并打开一个 1200×800 的 `BrowserWindow`，配置 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- **Preload**（`src/preload/index.ts`）：名为 `window.dsh` 的 `contextBridge` 表面，恰好四个方法——`fetchRequest`、`onStream`、`loadBundle`、`bootManifest`——不暴露裸 `ipcRenderer`。
- **渲染进程**（`src/renderer/main.tsx`、`transport.ts`）：通过 IPC 请求 boot manifest，安装 `window.__DSH_DESKTOP__`，运行来自 `dsh-client-web` 的共享 `AppWebEntry` 壳，`loadBundle` 通过 IPC 实现。

### IPC fetch 载体

载体正是子类表预留的传输方面：一个 `doFetch` 覆写，协议不变。

- `src/ipc/handler.ts` 是 Electron-free 的桥核心：`createIpcFetchHandler` 运行注入的 WHATWG fetch 面，立即返回 status 和 headers，把响应体块推给按 `streamId` 注册的订阅者——渲染进程订阅之前发出的事件先缓冲，订阅时重放。
- `src/ipc/framing.ts` 是线上分帧：一个 JSON 字符串事件联合（`chunk` / `end` / `error`），经 `webContents.send('dsh:stream', …)` 传输；渲染进程传输层轮询自己的信箱并组装流。
- `IpcApiClient`（`packages/client/connection/src/client/ipc-api-client.ts`）只覆写 `doFetch`：运行注入的 `DesktopIpcTransport`，在 IPC 一跳上强制调用方的 `AbortSignal`，把事件流重新组装成 WHATWG `Response`，因此 `callUnary`、`readSse`、`respond` 原样跑在真实的线上序列化上。该包不导入 electron；传输层是注入的。
- `dsh-client-connection` 在物化时选择载体：`fixtureClient ?? window.__DSH_DESKTOP__?.transport ?? new WebApiClient()`——桌面接缝位于 fixture 与浏览器默认之间，无服务器 UI 开发继续可用。

### 无 webserver 的宿主启动

`src/main/host.ts` 用 `boot('dsh-desktop', CONFIG_URL, HOST_PATCHES)` 启动。`cordis.yml` 是纯 Loader 条目列表，因此基础层按 profile loader 应用 bundle 的方式应用：`loadOverlayPatches('dsh-desktop', …)` 叠加在桌面自身的条目之上，外加 `hmr` 禁用（其模块重载生命周期未在长期驻留表面上测试）。配置行挂载 web profile 中不依赖 `webServer` 的宿主行——storage、session、shell、code-runtime、原生目录选择器、plugin inventory——并省略 webserver 绑定的行。启动前，Electron 入口把 `process.env.DSH_HOME` 设为 `app.getPath('userData')/dsh`，因此所有经 `dshHomePath` 解析的存储都落在操作系统用户数据目录下。ApiProxy 网关插件提供 `ctx.apiProxy`；`dsh-host-apiproxy` 的 `toFetchHandler(apiProxy)` 就是桥运行的进程内 WHATWG fetch 面。

### 通过 IPC 的 manifest 与 bundle 加载

`src/main/manifest.ts` 构建与 webserver 以 `window.__DSH_BOOT__` 注入的同一 wire 图——`{ rev, entries }`，url 形如 `/plugins/<id>/client.js?rev=<rev>`——方法是扫描 `dsh.client.platform === 'web'` 的已构建 workspace 包。`dsh:load-bundle` 通过同一次扫描把 url 解析回各包的 `lib/client.js`，因此名册与解析器不可能不一致。渲染进程用一个内联脚本评估 bundle，镜像默认 loader 的经典 async script 语义：bundle 在同步执行时用 `window.__ModuleLoader__.load` 注册工厂，load 事件在该执行之后触发。

### 打包与发布 v1

electron-builder 打包 `@deepseek-ai/dsh-desktop`（`appId: ai.deepseek.dsh`，产品名 DeepSeek Harness）：mac dmg + zip（`identity: null`）和 win NSIS x64。应用图标是生成而非绘制的：`scripts/generate-icon.mjs` 用 sharp 把官方 favicon.svg 的深色变体（圆角 `#1F2430` 方块上的白色鱼）渲染为 `build/icon.png`，改写字形填充并删除 `<style>` 媒体查询，因为 librsvg 从不求值 `prefers-color-scheme`。签名推迟：CI 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。`.github/workflows/desktop-release.yml` 在 `workflow_dispatch` 和 `desktop-v*` 标签上构建，矩阵为 macos-arm64 + windows-x64——macos-x64 行被删除，因为 GitHub 已于 2025 年 12 月退役 macos-13（Intel）runner——并且没有 `pnpm deploy` 闭包步骤：`electron-builder.yml` 的 `files` 指向 `apps/desktop/dist` 和 workspace `node_modules`，直接打包该布局已在本机验证。工作流在每个 runner 上对打包应用做冒烟测试，并把安装包附到标签的 GitHub Release。`pnpm-workspace.yaml` 把 `@electron/get@^3.0.0` 覆盖为 `^3.1.0`：electron-builder 26.15.3 的 `app-builder-lib` 引用只在 `@electron/get >= 3.1.0` 存在的 `ElectronDownloadCacheMode`，而声明的 `^3.0.0` 范围会让 lockfile 钉住过时的 3.0.0（electron 43 保留自己的 `@electron/get@^5.0.0`）。

## 曾考虑的替代方案

- **在回环端口上复用 `dsh-host-webserver`**——否决：宿主已在进程内；HTTP 传输会带来端口生命周期、CORS/鉴权面，以及同一 fetch 面的第二个所有者，且分层笔记为 Electron 预留了无 webserver。
- **渲染进程内用 WebSocket 式下行通道**——否决：SSE 分帧已经搭在基类客户端的 `readSse` 上；IPC 流通道携带同样的事件分帧，不引入新协议面。
- **渲染进程直接导入宿主包**——否决：这会破坏上下文隔离和客户端侧分层纪律；preload 桥让浏览器平面保持不接触 Node。
- **`pnpm deploy` 闭包打包**——否决：`files` 指向 `apps/desktop/dist` 和 workspace `node_modules`；直接打包该布局已在本机验证，deploy 步骤会产生 electron-builder 永远不会打包的闭包。
- **CI 矩阵中的 macos-x64**——否决：GitHub 已于 2025 年 12 月退役 macos-13（Intel）runner。
- **手绘图标素材**——否决：官方 favicon 的生成深色变体在零美术资产下保持品牌一致性。

## 结果

协议面不变：web 与桌面共享客户端图、zod 校验过的信封和 SSE 分帧；桌面的全部新意就是一个 `doFetch` 覆写加一个接缝。桥核心是 Electron-free 的，因此六个 vitest 套件（`host-boot`、`ipc-bridge`、`ipc-framing`、`ipc-handler`、`manifest`、`renderer-transport`）在不起动 Electron 的情况下覆盖启动、分帧、流式传输、manifest 以及传输层的顺序与终止规则，打包后的应用还在 CI runner 上做冒烟测试。渲染进程保持薄壳：所有组合都活在宿主图中。v1 以未签名、无更新的状态交付：首次打开时出现 Gatekeeper/SmartScreen 警告，无自动更新，无 macOS x64 安装包，且中止的 fetch 会在传输 API 变更之前留下渲染进程传输层的流监听器（已记录的 follow-up）。agent-presets 未组合：会话创建的 preset 平面没有接入桌面配置。`@electron/get` 覆盖钉住了一个只有 electron-builder 打包路径才会命中的依赖版本冲突；这是一个 pnpm-workspace 层面的决策，注释记录了原因。
