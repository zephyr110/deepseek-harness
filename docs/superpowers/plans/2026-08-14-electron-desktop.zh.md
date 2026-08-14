# Electron 桌面应用实现计划

[English](2026-08-14-electron-desktop.md) | 中文

> **面向 agentic workers：** 必选子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 为 macOS（arm64）和 Windows（x64）交付一个 Electron 桌面应用（`apps/desktop`）：在进程内嵌入 harness 宿主，通过 IPC fetch 载体复用 web 客户端壳，并由 GitHub Actions 工作流打包成安装程序（mac dmg+zip，win NSIS）。

**架构：** Electron 主进程用 `dsh-app-boot.boot()` 启动宿主插件图（base profile + 一个桌面 cordis patch，无 webserver），通过以 `toFetchHandler(ctx.apiProxy)` 为后端的 `ipcMain` fetch 桥暴露 `ctx.apiProxy`。渲染进程运行现有的 `AppWebEntry` 壳，`loadBundle` 接缝走 IPC，使用 `IpcApiClient`（`AbstractApiClient` 子类）而非 `WebApiClient`。四象限 RPC 协议不变——只有传输方面改变。electron-builder 打包应用；工作流矩阵构建并发布安装程序。

**技术栈：** Electron 43（内置 Node 24.18，满足 `node: ^22.19.0 || >=24.0.0`）、pnpm 11.7 workspaces、TypeScript 6、Vite 6（渲染进程）、tsdown（主进程/preload）、electron-builder、vitest、GitHub Actions。

## 全局约束

- 处处 ESM；本地相对导入使用 `.ts` 扩展名；dsh CLI 源码启动触达的包中不得有 CJS 导出（仓库约定）。
- Node `^22.19.0 || >=24.0.0`；Electron `^43`。
- 每个包都是 `@deepseek-ai/dsh-<name>`；应用是 `@deepseek-ai/dsh-desktop`（私有）。
- host/client 组包（`packages/host/*`、`packages/client/*`）需要显式 tsconfig `paths` 条目解析到 `src`（命名规则），包括 `/client` 子路径。
- CI 上 `DSH_TELEMETRY_DISABLED=1`（仓库约定：CI 永不向生产遥测端点上报）。
- 未签名构建：`CSC_IDENTITY_AUTO_DISCOVERY=false`、`mac.identity: null`。
- 提交信息用英文，conventional 风格（例如 `feat(desktop): ...`）。
- 测试：vitest；行为优先；非平凡改动在同一 PR 中附带 Agent Note + README。
- 在消费 workspace `lib/` 产物的桌面构建步骤之前必须先运行 `pnpm run build:lib`（electron-builder 打包构建后的 `lib/` 闭包，而非 `src/`）。

---

### Task 1：apps/desktop 脚手架——包、tsconfig、最小 Electron 壳

**文件：**
- 创建：`apps/desktop/package.json`
- 创建：`apps/desktop/tsconfig.json`
- 创建：`apps/desktop/tsdown.config.ts`
- 创建：`apps/desktop/vite.config.ts`
- 创建：`apps/desktop/src/renderer/index.html`
- 创建：`apps/desktop/src/renderer/main.tsx`（占位壳——真正的启动在 Task 5）
- 创建：`apps/desktop/src/main/index.ts`（占位——宿主接线在 Task 4）
- 创建：`apps/desktop/src/preload/index.ts`（占位——真正的桥在 Task 5）
- 修改：`pnpm-workspace.yaml`（添加 `apps/desktop`——核实 `apps/*` glob 是否已覆盖；未覆盖则添加）

**接口：**
- 产出：`@deepseek-ai/dsh-desktop` workspace，脚本 `build`（tsdown 主进程+preload，vite 渲染进程）、`dev`、`start`（`electron .`）；Electron 主入口 `dist/main/index.js`、preload `dist/preload/index.cjs`、渲染进程 `dist/renderer/index.html`。

- [ ] **步骤 1：写包 manifest**

```json
{
  "name": "@deepseek-ai/dsh-desktop",
  "version": "0.1.0-rc.5",
  "private": true,
  "type": "module",
  "description": "Electron desktop application: embedded host + web client shell over an IPC fetch carrier",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "npm run build:main && npm run build:renderer",
    "build:main": "tsdown",
    "build:renderer": "vite build",
    "dev:renderer": "vite",
    "start": "electron ."
  },
  "dependencies": {
    "@deepseek-ai/dsh-app-boot": "workspace:^",
    "@deepseek-ai/dsh-host-apiproxy": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-client-web": "workspace:^",
    "@deepseek-ai/dsh-client-connection": "workspace:^",
    "@deepseek-ai/dsh-client-modules": "workspace:^",
    "electron": "^43.0.0",
    "electron-builder": "^26.0.0",
    "typescript": "^6.0.3",
    "vite": "^6.0.0",
    "tsdown": "^0.22.2",
    "@vitejs/plugin-react": "^4.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}
```

注意：`dependencies` 在 Task 4 中增长（运行时需要的宿主插件包，经 base profile bundle 解析）。electron-builder 打包 `dependencies`；仅渲染进程使用的包留在 dev。

- [ ] **步骤 2：写 tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts", "tsdown.config.ts"]
}
```

（为应用导入的每个 `packages/host/*` 和 `packages/client/*` 依赖添加显式 `paths` 条目——复制 `apps/web/tsconfig.json` 的模式；目前是：`@deepseek-ai/dsh-client-web`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-app-boot`。）

- [ ] **步骤 3：写 tsdown 配置（主进程 + preload）**

```ts
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/main/index.ts'],
    outDir: 'dist/main',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    platform: 'node',
  },
  {
    entry: ['src/preload/index.ts'],
    outDir: 'dist/preload',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    platform: 'node',
    // Preload runs sandboxed: CJS, no ESM features.
  },
])
```

- [ ] **步骤 4：写 vite 配置（渲染进程）**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
})
```

- [ ] **步骤 5：占位入口文件（真正的逻辑在后续任务）**

`apps/desktop/src/renderer/index.html`：

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>DeepSeek Harness</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```

`apps/desktop/src/renderer/main.tsx`（占位——在 Task 5 中替换）：

```tsx
import { createRoot } from 'react-dom/client'

const el = document.getElementById('root')
if (el === null) throw new Error('desktop renderer: missing #root')
createRoot(el).render(<div>DeepSeek Harness desktop</div>)
```

`apps/desktop/src/main/index.ts`（占位——在 Task 4/5 中替换）：

```ts
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

export async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  return win
}

// Placeholder: Task 4 replaces this with the real whenReady boot (host start +
// ipc bridge registration + smoke-test fast path).
void app.whenReady().then(() => createMainWindow())
```

`apps/desktop/src/preload/index.ts`（占位）：

```ts
// Task 5 replaces this with the contextBridge surface.
export {}
```

- [ ] **步骤 6：安装并类型检查**

Run: `cd /Users/zephyr/code/deepseek-harness && pnpm install --filter @deepseek-ai/dsh-desktop`

Run: `pnpm --filter @deepseek-ai/dsh-desktop exec tsc --noEmit`

预期：无类型错误。

- [ ] **步骤 7：构建三个面**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`

预期：`dist/main/index.js`、`dist/preload/index.cjs`、`dist/renderer/index.html` 存在。

- [ ] **步骤 8：提交**

```bash
git add apps/desktop pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(desktop): scaffold apps/desktop with electron main, preload, renderer"
```

---

### Task 2：IPC fetch 桥核心——主进程分帧（Electron-free，vitest）

**文件：**
- 创建：`apps/desktop/src/ipc/framing.ts`——请求/流帧类型与序列化辅助（纯逻辑，无 electron 导入）
- 创建：`apps/desktop/src/ipc/handler.ts`——`createIpcFetchHandler(fetchFn)` 返回 `{ handleRequest, streamSubscribers }`：运行 WHATWG fetch，解析 `{status, headers, streamId}`，向订阅者推送 body 块，错误传播
- 测试：`apps/desktop/tests/ipc-framing.spec.ts`
- 测试：`apps/desktop/tests/ipc-handler.spec.ts`

**接口：**
- 消费：无（纯逻辑）。
- 产出：
  - `interface IpcFetchRequest { requestId: string; url: string; init?: { method?: string; headers?: Record<string,string>; body?: string } }`
  - `type IpcStreamEvent = { requestId: string; kind: 'chunk'; data: string } | { requestId: string; kind: 'end' } | { requestId: string; kind: 'error'; message: string }`
  - `createIpcFetchHandler(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): { handleRequest(req: IpcFetchRequest): Promise<{ status: number; headers: Record<string,string>; streamId: string }>; subscribe(streamId: string, cb: (ev: IpcStreamEvent) => void): () => void; cleanup(): void }`
  - Task 4 接线：`createIpcFetchHandler((url, init) => toFetchHandler(api).fetch(new URL(url), init))`。

- [ ] **步骤 1：写失败的 framing 测试**

```ts
import { describe, expect, it } from 'vitest'
import { parseIpcStreamEvent, serializeIpcStreamEvent } from '../src/ipc/framing.ts'

describe('ipc framing', () => {
  it('round-trips chunk, end, and error events', () => {
    const chunk = { requestId: 'r1', kind: 'chunk', data: 'data: {"ok":true}\n\n' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(chunk))).toEqual(chunk)
    const end = { requestId: 'r1', kind: 'end' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(end))).toEqual(end)
    const err = { requestId: 'r1', kind: 'error', message: 'boom' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(err))).toEqual(err)
  })

  it('rejects unknown event shapes', () => {
    expect(() => parseIpcStreamEvent(JSON.stringify({ requestId: 'r1', kind: 'nope' }))).toThrow()
  })
})
```

- [ ] **步骤 2：运行测试验证其失败**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-framing.spec.ts`

预期：FAIL——`parseIpcStreamEvent`/`serializeIpcStreamEvent` 未定义。

- [ ] **步骤 3：实现 framing**

```ts
/** Wire framing for the IPC fetch bridge. Events are JSON strings carried by `webContents.send('dsh:stream', ...)`. */

export interface IpcChunkEvent { requestId: string; kind: 'chunk'; data: string }
export interface IpcEndEvent { requestId: string; kind: 'end' }
export interface IpcErrorEvent { requestId: string; kind: 'error'; message: string }
export type IpcStreamEvent = IpcChunkEvent | IpcEndEvent | IpcErrorEvent

export function serializeIpcStreamEvent(event: IpcStreamEvent): string {
  return JSON.stringify(event)
}

export function parseIpcStreamEvent(raw: string): IpcStreamEvent {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('ipc bridge: non-object stream event')
  const event = parsed as Record<string, unknown>
  if (typeof event.requestId !== 'string') throw new Error('ipc bridge: stream event missing requestId')
  switch (event.kind) {
    case 'chunk':
      if (typeof event.data !== 'string') throw new Error('ipc bridge: chunk event missing data')
      return { requestId: event.requestId, kind: 'chunk', data: event.data }
    case 'end':
      return { requestId: event.requestId, kind: 'end' }
    case 'error':
      if (typeof event.message !== 'string') throw new Error('ipc bridge: error event missing message')
      return { requestId: event.requestId, kind: 'error', message: event.message }
    default:
      throw new Error(`ipc bridge: unknown stream event kind ${String(event.kind)}`)
  }
}
```

- [ ] **步骤 4：运行测试验证其通过**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-framing.spec.ts`

预期：PASS。

- [ ] **步骤 5：写失败的 handler 测试（针对真实 SSE 源的流式行为）**

```ts
import { describe, expect, it } from 'vitest'
import { createIpcFetchHandler } from '../src/ipc/handler.ts'

describe('ipc fetch handler', () => {
  it('resolves headers then streams body chunks to the subscriber', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"t":"a"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"t":"b"}\n\n'))
        controller.close()
      },
    })
    const handler = createIpcFetchHandler(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const events: string[] = []
    const { requestId, status, streamId } = await handler.handleRequest({ requestId: 'r1', url: 'http://dsh.internal/api/events.mux', init: {} })
    handler.subscribe(streamId, (ev) => events.push(ev.kind === 'chunk' ? ev.data : ev.kind))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(status).toBe(200)
    expect(events).toEqual(['data: {"t":"a"}\n\n', 'data: {"t":"b"}\n\n', 'end'])
    handler.cleanup()
  })

  it('propagates fetch rejection as an error event', async () => {
    const handler = createIpcFetchHandler(async () => { throw new Error('host down') })
    await expect(handler.handleRequest({ requestId: 'r1', url: 'http://dsh.internal/x', init: {} })).rejects.toThrow('host down')
    handler.cleanup()
  })
})
```

- [ ] **步骤 6：运行测试验证其失败**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-handler.spec.ts`

预期：FAIL——`createIpcFetchHandler` 未定义。

- [ ] **步骤 7：实现 handler**

```ts
import { randomUUID } from 'node:crypto'
import type { IpcStreamEvent } from './framing.ts'

export interface IpcFetchRequest {
  requestId: string
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

export interface IpcFetchResponse {
  status: number
  headers: Record<string, string>
  streamId: string
}

/** The transport seam: WHATWG fetch bound to the harness in-process handler. */
export type IpcFetchFn = (url: string, init?: RequestInit) => Promise<Response>

interface ActiveStream {
  subscriber: (event: IpcStreamEvent) => void
  ended: boolean
}

/**
 * Main-process side of the IPC fetch bridge (Electron-free). Runs the WHATWG
 * fetch, resolves status/headers immediately, then pushes body chunks to the
 * subscriber registered for the returned streamId.
 */
export function createIpcFetchHandler(fetchFn: IpcFetchFn): {
  handleRequest(request: IpcFetchRequest): Promise<IpcFetchResponse>
  subscribe(streamId: string, callback: (event: IpcStreamEvent) => void): () => void
  cleanup(): void
} {
  const streams = new Map<string, ActiveStream>()
  let disposed = false

  return {
    async handleRequest(request) {
      if (disposed) throw new Error('ipc bridge: handler disposed')
      const init: RequestInit = {
        method: request.init?.method ?? 'GET',
        headers: request.init?.headers,
      }
      if (request.init?.body !== undefined) init.body = request.init.body
      const response = await fetchFn(request.url, init)
      const streamId = randomUUID()
      const stream: ActiveStream = { subscriber: () => {}, ended: false }
      streams.set(streamId, stream)
      const headers: Record<string, string> = {}
      for (const [key, value] of response.headers) headers[key] = value
      const reader = response.body?.getReader()
      if (reader === undefined) {
        stream.subscriber({ requestId: request.requestId, kind: 'end' })
        stream.ended = true
        return { status: response.status, headers, streamId }
      }
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            stream.subscriber({ requestId: request.requestId, kind: 'chunk', data: new TextDecoder().decode(value) })
          }
          stream.subscriber({ requestId: request.requestId, kind: 'end' })
        } catch (error) {
          stream.subscriber({ requestId: request.requestId, kind: 'error', message: error instanceof Error ? error.message : String(error) })
        } finally {
          stream.ended = true
        }
      })()
      return { status: response.status, headers, streamId }
    },

    subscribe(streamId, callback) {
      const stream = streams.get(streamId)
      if (stream === undefined) throw new Error(`ipc bridge: unknown stream ${streamId}`)
      stream.subscriber = (event) => {
        if (stream.ended && event.kind === 'chunk') return
        callback(event)
      }
      return () => {
        if (streams.get(streamId) === stream) streams.delete(streamId)
      }
    },

    cleanup() {
      disposed = true
      streams.clear()
    },
  }
}
```

注意：body 可能在渲染进程订阅之前就已结束（小的 unary 响应）。end-先于-subscribe 的情形在 Task 3 的客户端中处理：客户端缓存缓冲事件直到 `subscribe`——见 Task 3 中的客户端 `eventBuffer`。

- [ ] **步骤 8：运行测试验证其通过**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-handler.spec.ts`

预期：PASS。

- [ ] **步骤 9：提交**

```bash
git add apps/desktop/src/ipc apps/desktop/tests
git commit -m "feat(desktop): ipc fetch bridge core with streaming framing"
```

---

### Task 3：client-connection 中的 IpcApiClient + 接缝

**文件：**
- 创建：`packages/client/connection/src/client/ipc-api-client.ts`——`IpcApiClient extends AbstractApiClient`；`doFetch` 运行注入的 `ipcFetch`，把流式 body 重组为带 `ReadableStream` 的 `Response`
- 修改：`packages/client/connection/src/client/index.ts`——接缝：存在桌面桥时选择 `IpcApiClient`
- 修改：`packages/client/connection/src/client/index.ts`——导出新载体类型
- 测试：`packages/client/connection/tests/ipc-api-client.spec.ts`

**接口：**
- 消费：`AbstractApiClient`、`toFetchHandler`（apiproxy）、Task 2 的 `IpcStreamEvent` 分帧类型（从 `@deepseek-ai/dsh-desktop` 导入？不行——connection 不能依赖应用；分帧类型按最小化（JSON 形状）复制，传输层是注入的）。
- 产出：
  - `export interface DesktopIpcTransport { request(req: { url: string; init?: { method?: string; headers?: Record<string,string>; body?: string } }): Promise<{ status: number; headers: Record<string,string>; events(): AsyncIterable<IpcStreamEvent> }> }`
  - `export class IpcApiClient extends AbstractApiClient { constructor(transport: DesktopIpcTransport) }`
  - `declare global { interface Window { __DSH_DESKTOP__?: { transport: DesktopIpcTransport } } }`
  - `apply()` 选择：`const api: IApiClient = fixtureClient ?? (desktopTransport ? new IpcApiClient(desktopTransport) : new WebApiClient())`

渲染进程入口（Task 5）在 `AppWebEntry.run()` 之前设置 `window.__DSH_DESKTOP__ = { transport }`；传输层包装 preload 的 `window.dsh` 桥。因为 `IpcApiClient` 位于 connection 包（而非应用）中，它**不导入** electron——传输层是注入的。

- [ ] **步骤 1：写失败的客户端测试（协议级，针对真实进程内 handler）**

connection 包不得导入应用（`apps/desktop`）——依赖方向是 apps → packages。因此下面的传输辅助站在 IPC 通道的位置上：它运行真实的 `toFetchHandler` fetch 面（与桌面主进程用的是同一个），把 body 作为单一块交付，仍然在客户端侧完整演练 `AbstractApiClient` 协议（信封 zod 解析、SSE `\n\n` 分帧解码、rpcId 回显）。多块流式路径由 Task 2 的 handler 测试覆盖。

```ts
import { describe, expect, it } from 'vitest'
import { toFetchHandler, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { IpcApiClient, type DesktopIpcTransport, type IpcStreamEvent } from '../src/client/ipc-api-client.ts'

/** A minimal ApiProxy stub with the methods the tests exercise. */
function stubApiProxy(): ApiProxy {
  return {
    sessions: {
      list: async () => ({ rpcId: 'x', result: { ok: true, value: { items: [], nextCursor: undefined } } }),
      create: async () => ({ rpcId: 'x', result: { ok: true, value: { id: 's1' as never, title: 't' } } }),
    },
    host: { describe: async () => ({ rpcId: 'x', result: { ok: true, value: { capabilities: [] } } }) },
  } as unknown as ApiProxy
}

/**
 * Transport stand-in: the same WHATWG fetch face the desktop main process
 * bridges over IPC, delivering the complete body as one chunk event (the IPC
 * channel's multi-chunk stream framing is Task 2's coverage).
 */
function ipcTransport(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): DesktopIpcTransport {
  return {
    async request(req) {
      const response = await fetchFn(req.url, new Request(req.url, {
        method: req.init?.method,
        headers: req.init?.headers,
        body: req.init?.body,
      }))
      const body = await response.text()
      const events: IpcStreamEvent[] = [
        { requestId: 'rid', kind: 'chunk', data: body },
        { requestId: 'rid', kind: 'end' },
      ]
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        events: async function* () { for (const event of events) yield event },
      }
    },
  }
}

describe('IpcApiClient', () => {
  it('runs a unary round trip over the ipc transport against the real handler', async () => {
    const client = new IpcApiClient(ipcTransport(async (url, init) => toFetchHandler(stubApiProxy()).fetch(new URL(url), init)))
    const result = await client.host.describe({})
    expect(result.result.ok).toBe(true)
  })

  it('decodes SSE frames from the ipc stream like the in-process carrier', async () => {
    const client = new IpcApiClient(ipcTransport(async (url, init) => toFetchHandler(stubApiProxy()).fetch(new URL(url), init)))
    const frames = []
    for await (const frame of client.openHost()) {
      frames.push(frame)
      break
    }
    expect(frames.length).toBe(1)
  })
})
```

- [ ] **步骤 2：运行测试验证其失败**

Run: `pnpm exec vitest run packages/client/connection/tests/ipc-api-client.spec.ts`

预期：FAIL——`IpcApiClient` 未定义。（如果 `openHost`/`openMux` 不在 `IApiClient` 上公开，删掉第二个测试，只断言 unary 往返——实现时检查 `AbstractApiClient` 的流表面。）

- [ ] **步骤 3：实现 IpcApiClient**

`packages/client/connection/src/client/ipc-api-client.ts`：

```ts
/**
 * Electron IPC fetch carrier: the desktop transport aspect. `doFetch` runs the
 * injected transport, reassembles the streamed body into a WHATWG Response so
 * the AbstractApiClient base keeps every protocol invariant (rpcId minting,
 * envelope zod parsing, SSE framing). No electron import — the transport is
 * injected (the preload bridge supplies it in the desktop renderer).
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy'

export interface IpcStreamChunkEvent { requestId: string; kind: 'chunk'; data: string }
export interface IpcStreamEndEvent { requestId: string; kind: 'end' }
export interface IpcStreamErrorEvent { requestId: string; kind: 'error'; message: string }
export type IpcStreamEvent = IpcStreamChunkEvent | IpcStreamEndEvent | IpcStreamErrorEvent

export interface DesktopIpcTransport {
  request(req: {
    url: string
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  }): Promise<{
    status: number
    headers: Record<string, string>
    events(): AsyncIterable<IpcStreamEvent>
  }>
}

export class IpcApiClient extends AbstractApiClient {
  private readonly transport: DesktopIpcTransport

  constructor(transport: DesktopIpcTransport) {
    super()
    this.transport = transport
  }

  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const [key, value] of init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)) {
      headers[key] = value
    }
    let body: string | undefined
    if (typeof init?.body === 'string') body = init.body
    else if (init?.body !== undefined) throw new Error('ipc client: non-string request bodies unsupported')
    let response
    try {
      response = await this.transport.request({
        url: input.href,
        init: {
          method: init?.method,
          headers,
          body,
        },
      })
    } catch (error) {
      throw transportError('ipc fetch failed', error instanceof Error ? error : undefined)
    }
    const responseHeaders = new Headers(response.headers)
    const eventBuffer: IpcStreamEvent[] = []
    const ready = response.events()
    const iterator = ready[Symbol.asyncIterator]()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (eventBuffer.length > 0) {
            const event = eventBuffer.shift()!
            if (event.kind === 'chunk') {
              controller.enqueue(new TextEncoder().encode(event.data))
            } else if (event.kind === 'end') {
              controller.close()
            } else {
              controller.error(new Error(event.message))
            }
            return
          }
          const { done, value } = await iterator.next()
          if (done) {
            controller.enqueue(new TextEncoder().encode(''))
            controller.close()
            return
          }
          eventBuffer.push(value)
        }
      },
      cancel() {
        void iterator.return?.()
      },
    })
    return new Response(stream, { status: response.status, headers: responseHeaders })
  }
}
```

- [ ] **步骤 4：在 connection 插件中接线接缝**

在 `packages/client/connection/src/client/index.ts` 中，`const api: IApiClient = ...` 之前：

```ts
declare global {
  interface Window {
    /** Present in the Electron desktop renderer; selects the IPC carrier. */
    __DSH_DESKTOP__?: { transport: DesktopIpcTransport }
  }
}
```

并把选择行改为：

```ts
  const desktopTransport = typeof window !== 'undefined' ? window.__DSH_DESKTOP__?.transport : undefined
  const api: IApiClient = fixtureClient ?? (desktopTransport !== undefined ? new IpcApiClient(desktopTransport) : new WebApiClient())
```

在同一文件的再导出块中添加导出：

```ts
export { IpcApiClient, type DesktopIpcTransport, type IpcStreamEvent } from './ipc-api-client.ts'
```

- [ ] **步骤 5：运行 connection 包测试**

Run: `pnpm exec vitest run packages/client/connection/tests/ipc-api-client.spec.ts`

预期：PASS。

- [ ] **步骤 6：类型检查客户端聚合**

Run: `pnpm exec tsc -b tsconfig.client.json --pretty false`

预期：无错误。

- [ ] **步骤 7：提交**

```bash
git add packages/client/connection/src/client/ipc-api-client.ts packages/client/connection/src/client/index.ts packages/client/connection/tests/ipc-api-client.spec.ts
git commit -m "feat(client-connection): ipc fetch carrier with desktop seam"
```

---

### Task 4：主进程宿主启动 + IPC 桥接线

**文件：**
- 创建：`apps/desktop/cordis.yml`——桌面配置：包含基础插件图（与 `web` profile 相同的行，去掉仅 webserver 的行）
- 创建：`apps/desktop/src/main/host.ts`——`startDesktopHost()`：`boot('dsh-desktop', ...)` + 返回 `{ ctx, fetch }`；无 electron 导入（可单元测试）
- 创建：`apps/desktop/src/main/ipc-bridge.ts`——`registerIpcFetchBridge(webContentsGetter, fetchFn)`；接线 `ipcMain.handle('dsh:fetch', ...)` 并通过 `webContents.send` 推送流事件
- 修改：`apps/desktop/src/main/index.ts`——真正的 `app.whenReady()` 流程：启动宿主、注册桥、创建窗口、`--smoke-test` 快路径
- 测试：`apps/desktop/tests/host-boot.spec.ts`——无 key 启动冒烟（策略：经 Loader 启动，只 mock 外部服务）
- 测试：`apps/desktop/tests/ipc-bridge.spec.ts`——用假的 `ipcMain`/`webContents` 对测桥分帧

**接口：**
- 消费：`@deepseek-ai/dsh-app-boot` 的 `boot()`（`boot(binName, absoluteConfigPath, patches?, prepare?, bareModuleBaseUrl?) => Promise<Context>`）、`@deepseek-ai/dsh-host-apiproxy` 的 `createApiProxy` + `toFetchHandler`、Task 2 的 `createIpcFetchHandler`。持久化重定向：`DSH_HOME` 环境变量（`@deepseek-ai/dsh-home-paths` 的 `DSH_HOME_ENV`，`resolveDshHome` 以最高优先级读取）——桌面主进程在启动前设置 `process.env.DSH_HOME`，使 `dshHomePath('storages')` 等落在 Electron 的 userData 下。
- 产出：
  - `export async function startDesktopHost(): Promise<{ ctx: Context; fetch: { fetch: typeof fetch } }>`
  - `export function registerIpcFetchBridge(getSender: () => { send(channel: string, payload: unknown): void }, fetchFn: IpcFetchFn, ipcHandle: (channel: string, handler: (event: unknown, req: IpcFetchRequest) => Promise<IpcFetchResponse>) => void): () => void`

- [ ] **步骤 1：写桌面 cordis 配置**

`apps/desktop/cordis.yml`——镜像 `web` profile 的基础行（见 `packages/boot/app-boot/src/profile.ts` `web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`）；桌面用自己的表面替代，因此只包含基础行和自己的宿主行：

```yaml
# The dsh-desktop app config: the base harness graph plus desktop host rows.
# Webserver-bound rows from the web profile are deliberately absent — the
# Electron main process carries the client transport over IPC instead.
include:
  - '@deepseek-ai/dsh-base'

plugins:
  - id: storage
    name: '@deepseek-ai/dsh-storage'
  - id: storage-json
    name: '@deepseek-ai/dsh-storage-json'
    config:
      root: !!js dshHomePath('storages')
  - id: storage-domain
    name: '@deepseek-ai/dsh-storage-domain'
    config:
      backend: json
  - id: message-feedback
    name: '@deepseek-ai/dsh-message-feedback'
    config:
      maxNoteBytes: 8192
  - id: session-log-download
    name: '@deepseek-ai/dsh-session-log-export'
  - id: workspace
    name: '@deepseek-ai/dsh-workspace'
  - id: session-projection-cache
    name: '@deepseek-ai/dsh-session-projection-cache'
    config:
      writeEveryEvents: 200
      writeIntervalMs: 5000
  - id: api-proxy
    name: '@deepseek-ai/dsh-host-apiproxy'
```

实现时对照 `packages/bundle/web-app/cordis.patch.yml` 和 `packages/bundle/base/cordis.patch.yml` 核实：保留 web profile 拥有的、不依赖 `webServer` 的每个宿主行（`code-runtime`、`session-query-sqlite`、`tools` mode 等行从 base 继承）。删除 `hmr`（可复制 web-app patch 的 `disabled: true` 行）以及任何 `webStartup`/`webRuntime` 行。

- [ ] **步骤 2：写失败的宿主启动测试（无 key）**

```ts
import { describe, expect, it } from 'vitest'
import { startDesktopHost } from '../src/main/host.ts'

describe('desktop host', () => {
  it('boots the plugin tree and exposes a working fetch face', async () => {
    const { fetch } = await startDesktopHost()
    // Unary round trip through the real in-process wire, no network.
    const response = await fetch.fetch('http://dsh.internal/api/host.describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 't1', type: 'client-request', method: 'host.describe', payload: {} }),
    })
    expect(response.status).toBe(200)
    const envelope = await response.json()
    expect(envelope.type).toBe('server-response')
    expect(envelope.result.ok).toBe(true)
  }, 30_000)
})
```

- [ ] **步骤 3：运行测试验证其失败**

Run: `pnpm exec vitest run apps/desktop/tests/host-boot.spec.ts`

预期：FAIL——`startDesktopHost` 未定义。

- [ ] **步骤 4：实现 startDesktopHost**

`apps/desktop/src/main/host.ts`：

```ts
/**
 * Desktop host boot: the harness plugin graph without any HTTP carriage.
 * Reuses dsh-app-boot's loader pipeline; the ApiProxy gateway plugin provides
 * ctx.apiProxy (transport-agnostic). Electron-free so the boot path is
 * testable under plain node. Persistence redirection happens BEFORE this
 * runs: the caller (electron main) sets process.env.DSH_HOME so dshHomePath
 * resolves under Electron's userData (see DSH_HOME_ENV in dsh-home-paths).
 */
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const CONFIG_URL = new URL('../../cordis.yml', import.meta.url)

export interface DesktopHost {
  ctx: unknown
  /** The in-process WHATWG fetch face over ctx.apiProxy. */
  fetch: { fetch: typeof fetch }
}

export async function startDesktopHost(): Promise<DesktopHost> {
  const ctx = await boot('dsh-desktop', fileURLToPath(CONFIG_URL))
  const apiProxy = (ctx as { apiProxy?: unknown }).apiProxy
  if (apiProxy === undefined) throw new Error('dsh-desktop: ctx.apiProxy missing after boot')
  return { ctx, fetch: toFetchHandler(apiProxy as never) }
}
```

注意：`apiProxy` 是声明合并的 `ctx` 属性（`packages/host/apiproxy/src/index.ts` 提供 `ctx.apiProxy`）；测试只断言默认 `DSH_HOME` 解析。在 electron 入口（步骤 10）中，调用 `startDesktopHost()` 之前设置 `process.env.DSH_HOME = join(app.getPath('userData'), 'dsh')`。

- [ ] **步骤 5：运行宿主启动测试验证其通过**

Run: `pnpm exec vitest run apps/desktop/tests/host-boot.spec.ts`

预期：PASS（启动完整树；base bundle 必须已构建：若因缺 `lib/` 失败，先运行 `pnpm run build:lib`）。

- [ ] **步骤 6：写失败的桥测试（假 ipc 对）**

```ts
import { describe, expect, it } from 'vitest'
import { registerIpcFetchBridge } from '../src/main/ipc-bridge.ts'

describe('ipc bridge', () => {
  it('registers the dsh:fetch handler and pushes stream events to the sender', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const ipcHandlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>()
    const sender = () => ({ send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } })
    const disposed = registerIpcFetchBridge(sender, async (url, init) => new Response('ok', { status: 200 }), (channel, handler) => { ipcHandlers.set(channel, handler) })
    const handler = ipcHandlers.get('dsh:fetch')
    expect(handler).toBeDefined()
    const result = await handler!({}, { requestId: 'r1', url: 'http://dsh.internal/api/host.describe', init: { method: 'POST' } })
    expect(result).toMatchObject({ status: 200 })
    expect(sent.some((m) => m.channel === 'dsh:stream')).toBe(true)
    disposed()
  })
})
```

- [ ] **步骤 7：运行测试验证其失败**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-bridge.spec.ts`

预期：FAIL——`registerIpcFetchBridge` 未定义。

- [ ] **步骤 8：实现桥**

`apps/desktop/src/main/ipc-bridge.ts`：

```ts
/**
 * Electron wiring of the fetch bridge: ipcMain.handle('dsh:fetch') runs the
 * in-process fetch face; body chunks go to the window's webContents over the
 * 'dsh:stream' channel. The ipcMain/webContents seams are injected so tests
 * run without electron.
 */
import { createIpcFetchHandler, type IpcFetchRequest, type IpcFetchResponse, type IpcFetchFn } from '../ipc/handler.ts'
import { serializeIpcStreamEvent } from '../ipc/framing.ts'

export function registerIpcFetchBridge(
  getSender: () => { send(channel: string, payload: unknown): void },
  fetchFn: IpcFetchFn,
  ipcHandle: (channel: string, handler: (event: unknown, request: IpcFetchRequest) => Promise<IpcFetchResponse>) => void,
): () => void {
  const handler = createIpcFetchHandler(fetchFn)
  const handle = async (_event: unknown, request: IpcFetchRequest): Promise<IpcFetchResponse> => {
    const response = await handler.handleRequest(request)
    handler.subscribe(response.streamId, (event) => {
      getSender().send('dsh:stream', serializeIpcStreamEvent(event))
    })
    return response
  }
  ipcHandle('dsh:fetch', handle)
  return () => handler.cleanup()
}
```

- [ ] **步骤 9：运行桥测试验证其通过**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-bridge.spec.ts`

预期：PASS。

- [ ] **步骤 10：带 smoke-test 快路径的真正主进程入口**

替换占位的 `apps/desktop/src/main/index.ts`：

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import { startDesktopHost } from './host.ts'
import { registerIpcFetchBridge } from './ipc-bridge.ts'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  return win
}

/** --smoke-test: boot the host, open a window, then exit 0 (CI packaging smoke). */
const SMOKE = process.argv.includes('--smoke-test')

void app.whenReady().then(async () => {
  // Persistence redirection: dshHomePath resolves $DSH_HOME first, so point
  // session storage at Electron's userData before the host boots.
  process.env[DSH_HOME_ENV] = join(app.getPath('userData'), 'dsh')
  const { fetch } = await startDesktopHost()
  registerIpcFetchBridge(
    () => BrowserWindow.getAllWindows()[0]?.webContents ?? { send() {} },
    (url, init) => fetch.fetch(url, init),
    (channel, handler) => {
      ipcMain.handle(channel, (event, request: IpcFetchRequest): Promise<IpcFetchResponse> => handler(event, request))
    },
  )
  const win = await createMainWindow()
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      console.log('dsh-desktop smoke OK')
      void app.quit()
    })
  }
})
```

- [ ] **步骤 11：构建并提交**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`

预期：构建干净。

Run: `pnpm exec vitest run apps/desktop/tests`

预期：全部通过。

```bash
git add apps/desktop/cordis.yml apps/desktop/src/main
git commit -m "feat(desktop): host boot and ipc bridge wiring in main process"
```

---

### Task 5：preload 桥 + 渲染进程启动

**文件：**
- 创建：`apps/desktop/src/preload/index.ts`（真正实现）
- 创建：`apps/desktop/src/renderer/main.tsx`（真正实现）
- 修改：`apps/desktop/src/preload/index.ts` → 暴露 `window.dsh`：
  - `window.dsh.fetchRequest(req)`——`ipcRenderer.invoke('dsh:fetch', req)` 返回 `{status, headers, streamId}` 形信封（实际是 Task 2 的 `IpcFetchResponse`）
  - `window.dsh.onStream(callback)`——订阅 `dsh:stream` 事件
  - `window.dsh.loadBundle(url)`——经主进程从磁盘读取 bundle 文件（`ipcRenderer.invoke('dsh:load-bundle', url)`）
- 修改：`apps/desktop/src/main/index.ts`——注册 `dsh:load-bundle` handler（读取 bundle 文件；解析把 `/plugins/<id>/client.js` 风格 url 映射到 bundle 根目录 `apps/desktop/dist/bundles` 下收集的 bundle，而不是 workspace 包——asar 无法回退解析到仓库根）
- 修改：`packages/client/web/src/boot.tsx`？——不：`AppWebEntry` 已接受带 `loadBundle` 的 `BootSeams`；无需包改动。

**接口：**
- 消费：`@deepseek-ai/dsh-client-web` 的 `AppWebEntry(el, seams)`；`BootSeams = { loadBundle(url: string): Promise<void> }`；`parseBootManifest` 形状（`BootManifest`，含 `modules`/`plugins` 行，每行 `{ id, url, rev, immediately? }`）。
- 产出：
  - 渲染进程入口通过 `dsh:boot-manifest` invoke 设置 `window.__DSH_BOOT__: BootManifest`。
  - `window.dsh` 桥，含 `fetchRequest`、`onStream`、`loadBundle`。
  - 渲染进程 `main.tsx`：拉取 manifest → 基于 `window.dsh` 构建 `IpcApiClient` 传输层 → 设置 `window.__DSH_DESKTOP__` → 设置 `window.__DSH_BOOT__` → `new AppWebEntry(el, { loadBundle }).run()`。

- [ ] **步骤 1：实现 preload 桥**

`apps/desktop/src/preload/index.ts`：

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'
import type { IpcStreamEvent } from '../ipc/framing.ts'

export interface DesktopBridge {
  fetchRequest(req: IpcFetchRequest): Promise<IpcFetchResponse>
  onStream(callback: (event: IpcStreamEvent) => void): () => void
  loadBundle(url: string): Promise<string>
  bootManifest(): Promise<unknown>
}

const bridge: DesktopBridge = {
  fetchRequest: (req) => ipcRenderer.invoke('dsh:fetch', req),
  onStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => {
      callback(JSON.parse(payload) as IpcStreamEvent)
    }
    ipcRenderer.on('dsh:stream', listener)
    return () => ipcRenderer.removeListener('dsh:stream', listener)
  },
  loadBundle: (url) => ipcRenderer.invoke('dsh:load-bundle', url),
  bootManifest: () => ipcRenderer.invoke('dsh:boot-manifest'),
}

contextBridge.exposeInMainWorld('dsh', bridge)
```

- [ ] **步骤 2：注册两个新的主进程 handler**

在 `apps/desktop/src/main/index.ts` 的 `whenReady` 内：

```ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, sep } from 'node:path'

// dsh:load-bundle — map '/plugins/<id>/client.js?rev=…' to the built bundle.
// The built client bundles live under each plugin package's lib/client.js.
ipcMain.handle('dsh:load-bundle', async (_event, url: string): Promise<string> => {
  const parsed = new URL(url, 'http://dsh.internal')
  const match = /^\/plugins\/([^/]+)\/client\.js$/.exec(parsed.pathname)
  if (match === null) throw new Error(`dsh-desktop: unsupported bundle url ${url}`)
  const packageName = decodeURIComponent(match[1])
  const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url))
  const packageDir = resolve(workspaceRoot, 'node_modules', packageName)
  return readFile(resolve(packageDir, 'lib', 'client.js'), 'utf8')
})

// dsh:boot-manifest — the host graph's client roster, same shape the
// webserver injects; produced from the built bundle directories.
ipcMain.handle('dsh:boot-manifest', async (): Promise<unknown> => {
  // Task 5.3 builds this from the built workspace client plugin packages
  // (the same discovery as scripts/dev-web.ts's discoverPluginDirs: every
  // packages/*/*/package.json with dsh.client.platform === 'web').
  throw new Error('dsh-desktop: boot manifest provider not yet wired')
})
```

- [ ] **步骤 3：实现 manifest 提供方**

创建 `apps/desktop/src/main/manifest.ts`：

```ts
/**
 * Desktop boot manifest: the client roster the renderer boots against —
 * structurally the same two-view BootManifest the webserver injects, built
 * from the built workspace plugin packages (no HTTP involved).
 */
import { readFileSync, globSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))

export interface DesktopBootEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

export interface DesktopBootManifest {
  modules: Array<{ id: string; url: string; rev: string }>
  plugins: DesktopBootEntry[]
}

/** Scan built client plugin packages (dsh.client.platform === 'web'), the same discovery dev-web uses. */
export function discoverClientPlugins(root = workspaceRoot): string[] {
  const dirs: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      name?: string
      dsh?: { client?: { platform?: unknown } }
    }
    if (manifest.dsh?.client?.platform === 'web' && manifest.name !== undefined) dirs.push(manifest.name)
  }
  return dirs
}

export function buildBootManifest(root = workspaceRoot): DesktopBootManifest {
  const plugins: DesktopBootEntry[] = []
  const modules: DesktopBootManifest['modules'] = []
  for (const packageName of discoverClientPlugins(root)) {
    const packageDir = join(root, 'node_modules', packageName)
    const bundlePath = join(packageDir, 'lib', 'client.js')
    const content = readFileSync(bundlePath, 'utf8')
    const rev = createHash('sha1').update(content).digest('hex').slice(0, 12)
    const entry: DesktopBootEntry = { id: packageName, url: `/plugins/${packageName}/client.js`, rev }
    plugins.push(entry)
    modules.push({ id: packageName, url: `/plugins/${packageName}/client.js`, rev })
  }
  return { modules, plugins }
}
```

在 `index.ts` 中接线：

```ts
ipcMain.handle('dsh:boot-manifest', async (): Promise<unknown> => buildBootManifest())
```

- [ ] **步骤 4：实现渲染进程入口**

`apps/desktop/src/renderer/main.tsx`：

```tsx
/**
 * Desktop renderer entry: prepare the shell's wire contract, then run the
 * shared AppWebEntry. All composition stays in the host graph — this file
 * only supplies the desktop transport (window.dsh bridge) and bundle loading.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { IpcApiClient, type DesktopIpcTransport, type IpcStreamEvent } from '@deepseek-ai/dsh-client-connection'
import type { DesktopBridge } from '../../preload/index.ts'

declare global {
  interface Window {
    dsh?: DesktopBridge
    __DSH_BOOT__?: unknown
    __DSH_DESKTOP__?: { transport: DesktopIpcTransport }
  }
}

async function main(): Promise<void> {
  const el = document.getElementById('root')
  if (el === null) throw new Error('desktop renderer: missing #root')
  const bridge = window.dsh
  if (bridge === undefined) throw new Error('desktop renderer: window.dsh bridge missing')

  const manifest = await bridge.bootManifest()
  window.__DSH_BOOT__ = manifest

  const transport: DesktopIpcTransport = {
    async request(req) {
      const response = await bridge.fetchRequest({ requestId: crypto.randomUUID(), ...req })
      const events: IpcStreamEvent[] = []
      const unsubscribe = bridge.onStream((event) => {
        if (event.requestId === response.streamId) events.push(event)
      })
      return {
        status: response.status,
        headers: response.headers,
        events: async function* () {
          try {
            while (true) {
              const event = events.shift()
              if (event === undefined) {
                await new Promise((resolve) => setTimeout(resolve, 5))
                continue
              }
              yield event
            }
          } finally {
            unsubscribe()
          }
        },
      }
    },
  }
  window.__DSH_DESKTOP__ = { transport }

  new AppWebEntry(el, {
    loadBundle: async (url) => {
      const source = await bridge.loadBundle(url)
      await evaluateBundle(url, source)
    },
  }).run()
}

/**
 * Evaluate a plugin bundle in the page context. Mirrors the default loader's
 * classic-script semantics (packages/client/modules/src/client/system.ts:
 * async external script) with an inline script — the bundle registers its
 * factory with window.__ModuleLoader__.load when it executes, and the load
 * event fires after the synchronous execution.
 */
function evaluateBundle(url: string, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.async = true
    el.textContent = source
    el.addEventListener('load', () => {
      el.remove()
      resolve()
    }, { once: true })
    el.addEventListener('error', () => {
      el.remove()
      reject(new Error(`desktop renderer: bundle ${url} failed to evaluate`))
    }, { once: true })
    document.head.append(el)
  })
}

void main()
```

- [ ] **步骤 5：更新占位 smoke-test 引用并构建**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`

预期：构建干净（渲染进程针对新桥类型做类型检查）。

- [ ] **步骤 6：提交**

```bash
git add apps/desktop/src/preload apps/desktop/src/renderer apps/desktop/src/main/manifest.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): preload bridge and renderer boot over the shell"
```

---

### Task 6：electron-builder 打包配置 + 图标

**文件：**
- 创建：`apps/desktop/electron-builder.yml`
- 创建：`apps/desktop/build/icon.png`（生成；electron-builder 自动转换为 icns/ico）
- 创建：`apps/desktop/scripts/generate-icon.mjs`（无依赖 PNG 编码器，用 node zlib）
- 修改：`apps/desktop/package.json`——添加 `dist` 脚本、`build.extraResources`？（见 yml）、`postinstall` electron-builder install-app-deps

**接口：**
- 产出：`electron-builder` 配置，在 `dist-installers/` 产出 `dmg` + `zip`（mac）和 NSIS `exe`（win）；图标文件；经 `--dir` 的打包冒烟目标 `dist-installers/<app>-unpacked`。

- [ ] **步骤 1：写 electron-builder.yml**

```yaml
appId: ai.deepseek.dsh
productName: DeepSeek Harness
directories:
  output: dist-installers
  buildResources: build
files:
  - dist/main/**/*
  - dist/preload/**/*
  - dist/renderer/**/*
  - cordis.yml
  - package.json
asar: true
npmRebuild: true
mac:
  category: public.app-category.developer-tools
  identity: null
  target:
    - dmg
    - zip
  icon: build/icon.png
win:
  target:
    - target: nsis
      arch:
        - x64
  icon: build/icon.png
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
electronDownload:
  cache: ~/.cache/electron
```

注意：`files` 还必须包含部署后的 node_modules 闭包——在 CI 中先用 `pnpm --filter @deepseek-ai/dsh-desktop deploy dist-app/prod` 构建闭包，再把 `dist-app/prod/**/*` 加入 `files`（实现时核实当 `files` 中存在 node_modules 时 electron-builder 是否自动包含；必要时相应调整 `files`）。node_modules 中的 workspace 符号链接由 deploy 步骤解析。

- [ ] **步骤 2：写图标生成器（无依赖）**

`apps/desktop/scripts/generate-icon.mjs`——用 node `zlib` 的最小 PNG 写入器（无 canvas 依赖）：渲染一个 1024×1024 RGBA 缓冲，双色圆角方块 + "D" 字形近似，再用 `zlib.deflateSync` 把原始扫描线压缩进带 IDAT 的 PNG。输出 `apps/desktop/build/icon.png`。

- [ ] **步骤 3：生成并核实图标**

Run: `node apps/desktop/scripts/generate-icon.mjs`

Run: `file apps/desktop/build/icon.png`

预期：`PNG image data, 1024 x 1024`。

- [ ] **步骤 4：本地打包检查（macOS）**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`

Run: `cd apps/desktop && pnpm exec electron-builder --dir --mac`

预期：`dist-installers/mac*/DeepSeek Harness.app` 存在（未打包解压、未签名）。

- [ ] **步骤 5：对打包应用做冒烟测试**

Run: `"dist-installers/mac-arm64/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --smoke-test`

预期：打印 `dsh-desktop smoke OK` 并以 0 退出。

- [ ] **步骤 6：提交**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/build apps/desktop/scripts apps/desktop/package.json
git commit -m "build(desktop): electron-builder packaging config and icon"
```

---

### Task 7：GitHub Actions 工作流——构建并发布安装程序

**文件：**
- 创建：`.github/workflows/desktop-release.yml`

**接口：**
- 消费：Task 6 的 electron-builder 配置；仓库既有 CI 模式（`actions/checkout@v6`、`pnpm/action-setup@v4`、`actions/setup-node@v6` 配 node 24 + pnpm 缓存、`pnpm install --frozen-lockfile`、`DSH_TELEMETRY_DISABLED=1`）。

- [ ] **步骤 1：写工作流**

```yaml
name: Desktop release

# Manual dispatch builds installers and uploads artifacts; a desktop-v* tag
# additionally publishes a GitHub Release with the installers as assets.
# Unsigned in v1: CSC_IDENTITY_AUTO_DISCOVERY=false and mac.identity: null.
on:
  workflow_dispatch:
  push:
    tags:
      - 'desktop-v*'

concurrency:
  group: desktop-release-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: write

env:
  DSH_TELEMETRY_DISABLED: '1'
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'

jobs:
  build:
    name: ${{ matrix.target }}
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 60
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: macos-arm64
            runner: macos-latest
            args: '--mac --x64=false --arm64=true'
          - target: windows-x64
            runner: windows-latest
            args: '--win'
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm

      - name: Install (immutable)
        run: pnpm install --frozen-lockfile

      - name: Build libraries
        run: pnpm run build:lib

      - name: Build desktop app
        run: pnpm --filter @deepseek-ai/dsh-desktop run build

      - name: Deploy production dependency closure
        run: pnpm --filter @deepseek-ai/dsh-desktop deploy dist-app/prod

      - name: Package installers
        working-directory: apps/desktop
        run: pnpm exec electron-builder --publish never ${{ matrix.args }}

      - name: Smoke-test packaged app
        shell: bash
        run: |
          case "${{ matrix.target }}" in
            macos-*)
              APP="apps/desktop/dist-installers/mac-arm64/DeepSeek Harness.app"
              "$APP/Contents/MacOS/DeepSeek Harness" --smoke-test
              ;;
            windows-x64)
              "apps/desktop/dist-installers/win-unpacked/DeepSeek Harness.exe" --smoke-test
              ;;
          esac

      - uses: actions/upload-artifact@v7
        with:
          name: dsh-desktop-${{ matrix.target }}
          path: |
            apps/desktop/dist-installers/*.dmg
            apps/desktop/dist-installers/*.zip
            apps/desktop/dist-installers/*.exe
          if-no-files-found: error
          retention-days: 7

  release:
    needs: build
    if: startsWith(github.ref, 'refs/tags/desktop-v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6

      - uses: actions/download-artifact@v8
        with:
          path: dist-installers
          merge-multiple: true

      - name: Publish GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name }}
        run: |
          gh release create "$TAG" \
            dist-installers/*.dmg dist-installers/*.zip dist-installers/*.exe \
            --title "DeepSeek Harness Desktop $TAG" --generate-notes
```

`macos-x64` 矩阵行在落地时已删除：GitHub 已于 2025 年 12 月退役 macos-13（Intel）runner，因此交付的矩阵是 macos-arm64 + windows-x64。

- [ ] **步骤 2：验证工作流语法**

Run: `npx action-validator .github/workflows/desktop-release.yml`（或 action-validator 不可用时用 `python -c` YAML 解析回退）

预期：有效。

- [ ] **步骤 3：提交**

```bash
git add .github/workflows/desktop-release.yml
git commit -m "ci(desktop): build and release workflow for desktop installers"
```

---

### Task 8：Agent Note + README

**文件：**
- 创建：`.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md`（+ `.zh.md`）
- 创建：`apps/desktop/README.md`（+ 按仓库双语约定的 `.zh.md`）
- 修改：`docs/superpowers/specs/2026-08-14-electron-desktop-design.md`（status → implemented，链接笔记）

**接口：**
- 消费：Task 1–7 交付的代码；Agent Note 格式规则（`verify-agent-note-format` 门禁结构）。

- [ ] **步骤 1：写 Agent Note**

`.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md`——决策：IPC fetch 载体作为传输方面（`doFetch` 子类，协议不变）；主进程宿主经 `dsh-app-boot.boot()` 且无 webserver；`ctx.apiProxy` 面（`toFetchHandler`）；`client-connection` 接缝（`window.__DSH_DESKTOP__`）；manifest + bundle 经 IPC 加载；v1 未签名打包。遵循 `2026-07-19-gui-layering-and-rpc-protocol.md` 的格式（问题 → 决策 → 结果）。写 `.zh.md` 镜像。

- [ ] **步骤 2：写应用 README**

`apps/desktop/README.md`——它是什么、架构（3 个进程 + IPC 桥）、构建说明（`pnpm run build:lib`、桌面构建、`--dir` 打包）、冒烟测试、签名状态、已知限制（未签名 Gatekeeper/SmartScreen、尚无自动更新）。按仓库双语政策写 `.zh.md` 镜像。

- [ ] **步骤 3：更新 spec 状态**

在 `docs/superpowers/specs/2026-08-14-electron-desktop-design.md` 中，把 `Status: approved` 改为 `Status: implemented` 并添加指向 Agent Note 的链接。

- [ ] **步骤 4：验证门禁**

Run: `pnpm exec tsx scripts/verify-agent-note-format.ts`（或仓库的 agent-note 验证脚本）

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add .agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md .agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.zh.md apps/desktop/README.md apps/desktop/README.zh.md docs/superpowers/specs/2026-08-14-electron-desktop-design.md
git commit -m "docs(desktop): agent note and README for the electron desktop shell"
```

---

## 自审笔记

- **Spec 覆盖：** 每个 spec 小节都映射到一个任务——形态/IPC 载体 → Task 2–5；无 webserver 的宿主装配 → Task 4；打包（dmg/zip/NSIS、未签名、经 npmRebuild 重建 node-pty）→ Task 6；GitHub Actions 矩阵 + dispatch/标签触发器 + 遥测 env → Task 7；Agent Note + README → Task 8；tsconfig paths 规则 → Task 1；超出范围项（签名、自动更新、Linux）记录在 Task 8 的 README。
- **规划期间核实过的环境事实（非占位）：** `defaultLoadBundle` = 经典 async script 元素（Task 5 用内联脚本镜像它）；`DSH_HOME_ENV`/`resolveDshHome` 优先级（Task 4 在启动前经 env 重定向）；`boot()` 返回带 `ctx.apiProxy` 的 `Context`（由 apiproxy 网关提供）；`loadBundle(url: string) => Promise<void>` 接缝；connection 包不得导入应用（Task 3 的传输辅助站在通道的位置上）。
- **延后的环境事实（落地时已解决）：** x64 macOS 矩阵行已删除——GitHub 已于 2025 年 12 月退役 `macos-13`（Intel）runner；交付的矩阵是 macos-arm64 + windows-x64。
