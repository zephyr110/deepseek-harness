# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

作为桌面应用的 harness：一个 Electron 壳，在主进程中内嵌宿主插件图，并通过 IPC fetch 载体在沙箱化的渲染进程中运行共享的 web 客户端壳——没有 HTTP，不监听端口。安装包面向 macOS（Apple Silicon；dmg + zip）和 Windows（x64；NSIS exe）。[Electron 桌面设计 spec](../../docs/superpowers/specs/2026-08-14-electron-desktop-design.md) 是方案；[桌面壳 Agent Note](../../.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md) 记录了已交付的决策。

## 架构

三个进程加一个 Electron-free 的桥核心（`src/ipc/`）：

| 进程 | 文件 | 职责 |
|---|---|---|
| 主进程 | `src/main/index.ts`、`host.ts`、`ipc-bridge.ts`、`manifest.ts` | 用 `dsh-app-boot.boot()` 启动宿主（无 webserver），注册 `dsh:fetch` / `dsh:stream` / `dsh:load-bundle` / `dsh:boot-manifest` 通道，打开窗口 |
| Preload | `src/preload/index.ts` | `window.dsh` contextBridge 表面——`fetchRequest`、`onStream`、`loadBundle`、`bootManifest`；不暴露裸 IPC |
| 渲染进程 | `src/renderer/main.tsx`、`transport.ts` | 基于桌面 IPC 传输层的共享 `AppWebEntry` 壳 |

持久化位于操作系统用户数据目录下：Electron 入口在宿主启动前把 `DSH_HOME` 设为 `userData/dsh`。插件客户端 bundle 和 boot manifest（`{ rev, entries }`）走同一条 IPC 通道，而不是 webserver 的 HTTP 注入。

## 开发

先有构建产物。从仓库根目录运行 `pnpm run build:lib` 构建宿主与客户端库——包括桌面 boot manifest 扫描的客户端 bundle——然后构建应用本身：

```sh
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-desktop run build
```

从源码运行（需要真实的 GUI 会话）：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

打包安装程序（macOS 上为 dmg/zip，Windows 上为 NSIS）：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist       # installers
pnpm --filter @deepseek-ai/dsh-desktop run dist:dir   # unpacked app only
```

冒烟测试：打包后的应用接受 `--smoke-test`——启动宿主、打开窗口、打印 `dsh-desktop smoke OK` 并以 0 退出。CI 在打包后于每个矩阵目标上运行它。

## Known Limitations and Deferred Work

- **v1 未签名**：没有代码签名或公证；用户首次打开应用时 macOS Gatekeeper 和 Windows SmartScreen 会显示警告。CI 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 和 `mac.identity: null`；签名可之后通过 secrets 添加。
- **无自动更新**：未接入 electron-updater；选择 zip 产物形态是为将来支持它。
- **无 macOS x64 安装包**：GitHub 已于 2025 年 12 月退役 macos-13（Intel）runner；CI 矩阵构建 macos-arm64 和 windows-x64。
- **abort 路径的监听器残留**：中止的 fetch 会在传输 API 变更之前留下渲染进程传输层的流监听器（已记录的 follow-up）。
- **agent presets 未组合**：会话创建的 preset 平面没有接入桌面配置。
