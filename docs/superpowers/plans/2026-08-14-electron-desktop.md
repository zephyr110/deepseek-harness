# Electron Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Electron desktop app (`apps/desktop`) for macOS (arm64) and Windows (x64) that embeds the harness host in-process, reuses the web client shell over an IPC fetch carrier, and is packaged into installers (mac dmg+zip, win NSIS) by a GitHub Actions workflow.

**Architecture:** The Electron main process boots the host plugin graph with `dsh-app-boot.boot()` (base profile + a desktop cordis patch, no webserver), exposes `ctx.apiProxy` through an `ipcMain` fetch bridge backed by `toFetchHandler(ctx.apiProxy)`. The renderer runs the existing `AppWebEntry` shell with a `loadBundle` seam over IPC and an `IpcApiClient` (`AbstractApiClient` subclass) instead of `WebApiClient`. The four-quadrant RPC protocol is untouched — only the transport aspect changes. electron-builder packages the app; a workflow matrix builds and releases installers.

**Tech Stack:** Electron 43 (bundled Node 24.18, satisfies `node: ^22.19.0 || >=24.0.0`), pnpm 11.7 workspaces, TypeScript 6, Vite 6 (renderer), tsdown (main/preload), electron-builder, vitest, GitHub Actions.

## Global Constraints

- ESM everywhere; local relative imports use `.ts` extensions; no CJS exports in packages the dsh CLI source-launch reaches (repo convention).
- Node `^22.19.0 || >=24.0.0`; Electron `^43`.
- Every package is `@deepseek-ai/dsh-<name>`; the app is `@deepseek-ai/dsh-desktop` (private).
- Host/client group packages (`packages/host/*`, `packages/client/*`) need explicit tsconfig `paths` entries resolved to `src` (naming rule), including `/client` subpaths.
- `DSH_TELEMETRY_DISABLED=1` on CI (repo convention: CI never reports to the production telemetry endpoint).
- Unsigned builds: `CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity: null`.
- Commit messages in English, conventional style (e.g. `feat(desktop): ...`).
- Tests: vitest; behavior-first; non-trivial changes include an Agent Note + README in the same PR.
- `pnpm run build:lib` must have run before desktop build steps that consume workspace `lib/` outputs (electron-builder packs built `lib/` closures, not `src/`).

---

### Task 1: apps/desktop scaffold — package, tsconfig, minimal Electron shell

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsdown.config.ts`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/main.tsx` (placeholder shell — real boot lands in Task 5)
- Create: `apps/desktop/src/main/index.ts` (placeholder — host wiring lands in Task 4)
- Create: `apps/desktop/src/preload/index.ts` (placeholder — real bridge lands in Task 5)
- Modify: `pnpm-workspace.yaml` (add `apps/desktop` — verify whether `apps/*` glob already covers it; add if not)

**Interfaces:**
- Produces: `@deepseek-ai/dsh-desktop` workspace with scripts `build` (tsdown main+preload, vite renderer), `dev`, `start` (`electron .`); Electron main entry `dist/main/index.js`, preload `dist/preload/index.cjs`, renderer `dist/renderer/index.html`.

- [ ] **Step 1: Write the package manifest**

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

Note: `dependencies` grows in Task 4 (host plugin packages needed at runtime, resolved via the base profile bundles). electron-builder packs `dependencies`; renderer-only packages stay dev.

- [ ] **Step 2: Write tsconfig**

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

(Add explicit `paths` entries for every `packages/host/*` and `packages/client/*` dependency the app imports — copy the pattern from `apps/web/tsconfig.json`; at this point: `@deepseek-ai/dsh-client-web`, `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-modules`, `@deepseek-ai/dsh-host-apiproxy`, `@deepseek-ai/dsh-app-boot`.)

- [ ] **Step 3: Write tsdown config (main + preload)**

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

- [ ] **Step 4: Write vite config (renderer)**

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

- [ ] **Step 5: Placeholder entry files (real logic lands in later tasks)**

`apps/desktop/src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>DeepSeek Harness</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```

`apps/desktop/src/renderer/main.tsx` (placeholder — replaced in Task 5):

```tsx
import { createRoot } from 'react-dom/client'

const el = document.getElementById('root')
if (el === null) throw new Error('desktop renderer: missing #root')
createRoot(el).render(<div>DeepSeek Harness desktop</div>)
```

`apps/desktop/src/main/index.ts` (placeholder — replaced in Task 4/5):

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

`apps/desktop/src/preload/index.ts` (placeholder):

```ts
// Task 5 replaces this with the contextBridge surface.
export {}
```

- [ ] **Step 6: Install and typecheck**

Run: `cd /Users/zephyr/code/deepseek-harness && pnpm install --filter @deepseek-ai/dsh-desktop`
Run: `pnpm --filter @deepseek-ai/dsh-desktop exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Build all three faces**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Expected: `dist/main/index.js`, `dist/preload/index.cjs`, `dist/renderer/index.html` exist.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(desktop): scaffold apps/desktop with electron main, preload, renderer"
```

---

### Task 2: IPC fetch bridge core — main-process framing (Electron-free, vitest)

**Files:**
- Create: `apps/desktop/src/ipc/framing.ts` — request/stream frame types and serialization helpers (pure, no electron import)
- Create: `apps/desktop/src/ipc/handler.ts` — `createIpcFetchHandler(fetchFn)` returns `{ handleRequest, streamSubscribers }`: runs the WHATWG fetch, resolves `{status, headers, streamId}`, pushes body chunks to subscribers, error propagation
- Test: `apps/desktop/tests/ipc-framing.spec.ts`
- Test: `apps/desktop/tests/ipc-handler.spec.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface IpcFetchRequest { requestId: string; url: string; init?: { method?: string; headers?: Record<string,string>; body?: string } }`
  - `type IpcStreamEvent = { requestId: string; kind: 'chunk'; data: string } | { requestId: string; kind: 'end' } | { requestId: string; kind: 'error'; message: string }`
  - `createIpcFetchHandler(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): { handleRequest(req: IpcFetchRequest): Promise<{ status: number; headers: Record<string,string>; streamId: string }>; subscribe(streamId: string, cb: (ev: IpcStreamEvent) => void): () => void; cleanup(): void }`
  - Task 4 wires it: `createIpcFetchHandler((url, init) => toFetchHandler(api).fetch(new URL(url), init))`.

- [ ] **Step 1: Write the failing framing test**

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-framing.spec.ts`
Expected: FAIL — `parseIpcStreamEvent`/`serializeIpcStreamEvent` not defined.

- [ ] **Step 3: Implement framing**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-framing.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test (streaming behavior against a real SSE source)**

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

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-handler.spec.ts`
Expected: FAIL — `createIpcFetchHandler` not defined.

- [ ] **Step 7: Implement the handler**

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

Note: a body may have finished before the renderer subscribes (small unary responses). The `end`-before-subscribe case is handled in Task 3's client: the client caches buffered events until `subscribe` — see the client-side `eventBuffer` in Task 3.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-handler.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/ipc apps/desktop/tests
git commit -m "feat(desktop): ipc fetch bridge core with streaming framing"
```

---

### Task 3: IpcApiClient in client-connection + seam

**Files:**
- Create: `packages/client/connection/src/client/ipc-api-client.ts` — `IpcApiClient extends AbstractApiClient`; `doFetch` runs an injected `ipcFetch` and reassembles the streamed body into a `Response` with a `ReadableStream`
- Modify: `packages/client/connection/src/client/index.ts` — seam: pick `IpcApiClient` when the desktop bridge is present
- Modify: `packages/client/connection/src/client/index.ts` — export the new carrier types
- Test: `packages/client/connection/tests/ipc-api-client.spec.ts`

**Interfaces:**
- Consumes: `AbstractApiClient`, `toFetchHandler` (apiproxy), `IpcStreamEvent` framing types from Task 2 (imported from `@deepseek-ai/dsh-desktop`? NO — connection cannot depend on the app; the framing types are duplicated minimal (JSON shape) and the transport is injected).
- Produces:
  - `export interface DesktopIpcTransport { request(req: { url: string; init?: { method?: string; headers?: Record<string,string>; body?: string } }): Promise<{ status: number; headers: Record<string,string>; events(): AsyncIterable<IpcStreamEvent> }> }`
  - `export class IpcApiClient extends AbstractApiClient { constructor(transport: DesktopIpcTransport) }`
  - `declare global { interface Window { __DSH_DESKTOP__?: { transport: DesktopIpcTransport } } }`
  - `apply()` selects: `const api: IApiClient = fixtureClient ?? (desktopTransport ? new IpcApiClient(desktopTransport) : new WebApiClient())`

The renderer entry (Task 5) sets `window.__DSH_DESKTOP__ = { transport }` before `AppWebEntry.run()`; the transport wraps the preload `window.dsh` bridge. Because `IpcApiClient` sits in the connection package (not the app), it imports **no electron** — the transport is injected.

- [ ] **Step 1: Write the failing client test (protocol-level, against the real in-process handler)**

The connection package must not import the app (`apps/desktop`) — dependency direction is apps → packages. The transport helper below therefore stands in for the IPC channel: it runs the real `toFetchHandler` fetch face (same one the desktop main process uses) and delivers the body as a single chunk, which still exercises the full `AbstractApiClient` protocol (envelope zod parsing, SSE `\n\n` framing decode, rpcId echo) on the client side. The multi-chunk streaming path is covered by Task 2's handler test.

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/client/connection/tests/ipc-api-client.spec.ts`
Expected: FAIL — `IpcApiClient` not defined. (If `openHost`/`openMux` are not public on `IApiClient`, drop the second test and assert the unary round trip only — check `AbstractApiClient`'s stream surface during implementation.)

- [ ] **Step 3: Implement IpcApiClient**

`packages/client/connection/src/client/ipc-api-client.ts`:

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

- [ ] **Step 4: Wire the seam in the connection plugin**

In `packages/client/connection/src/client/index.ts`, before `const api: IApiClient = ...`:

```ts
declare global {
  interface Window {
    /** Present in the Electron desktop renderer; selects the IPC carrier. */
    __DSH_DESKTOP__?: { transport: DesktopIpcTransport }
  }
}
```

and change the selection line:

```ts
  const desktopTransport = typeof window !== 'undefined' ? window.__DSH_DESKTOP__?.transport : undefined
  const api: IApiClient = fixtureClient ?? (desktopTransport !== undefined ? new IpcApiClient(desktopTransport) : new WebApiClient())
```

Add the export in the same file's re-export block:

```ts
export { IpcApiClient, type DesktopIpcTransport, type IpcStreamEvent } from './ipc-api-client.ts'
```

- [ ] **Step 5: Run the connection package tests**

Run: `pnpm exec vitest run packages/client/connection/tests/ipc-api-client.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the client aggregate**

Run: `pnpm exec tsc -b tsconfig.client.json --pretty false`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/connection/src/client/ipc-api-client.ts packages/client/connection/src/client/index.ts packages/client/connection/tests/ipc-api-client.spec.ts
git commit -m "feat(client-connection): ipc fetch carrier with desktop seam"
```

---

### Task 4: Main-process host boot + IPC bridge wiring

**Files:**
- Create: `apps/desktop/cordis.yml` — desktop config: include the base plugin graph (same rows as the `web` profile minus webserver-only rows)
- Create: `apps/desktop/src/main/host.ts` — `startDesktopHost()`: `boot('dsh-desktop', ...)` + returns `{ ctx, fetch }`; no electron import (unit-testable)
- Create: `apps/desktop/src/main/ipc-bridge.ts` — `registerIpcFetchBridge(webContentsGetter, fetchFn)`; wires `ipcMain.handle('dsh:fetch', ...)` and pushes stream events via `webContents.send`
- Modify: `apps/desktop/src/main/index.ts` — real `app.whenReady()` flow: boot host, register bridge, create window, `--smoke-test` fast path
- Test: `apps/desktop/tests/host-boot.spec.ts` — keyless boot smoke (policy: boot through the Loader, mock only external services)
- Test: `apps/desktop/tests/ipc-bridge.spec.ts` — bridge framing with a fake `ipcMain`/`webContents` pair

**Interfaces:**
- Consumes: `boot()` from `@deepseek-ai/dsh-app-boot` (`boot(binName, absoluteConfigPath, patches?, prepare?, bareModuleBaseUrl?) => Promise<Context>`), `createApiProxy` + `toFetchHandler` from `@deepseek-ai/dsh-host-apiproxy`, Task 2's `createIpcFetchHandler`. Persistence redirection: `DSH_HOME` env (`DSH_HOME_ENV` in `@deepseek-ai/dsh-home-paths`, read with highest precedence by `resolveDshHome`) — the desktop main sets `process.env.DSH_HOME` before boot so `dshHomePath('storages')` and friends land under Electron's userData.
- Produces:
  - `export async function startDesktopHost(): Promise<{ ctx: Context; fetch: { fetch: typeof fetch } }>`
  - `export function registerIpcFetchBridge(getSender: () => { send(channel: string, payload: unknown): void }, fetchFn: IpcFetchFn, ipcHandle: (channel: string, handler: (event: unknown, req: IpcFetchRequest) => Promise<IpcFetchResponse>) => void): () => void`

- [ ] **Step 1: Write the desktop cordis config**

`apps/desktop/cordis.yml` — mirror the `web` profile's base rows (see `packages/boot/app-boot/src/profile.ts` `web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`); desktop substitutes its own surface, so it includes base rows only and its own host rows:

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

Verify against `packages/bundle/web-app/cordis.patch.yml` and `packages/bundle/base/cordis.patch.yml` during implementation: keep every host row the web profile has that does not depend on `webServer` (rows like `code-runtime`, `session-query-sqlite`, `tools` mode are inherited from base). Drop `hmr` (the `disabled: true` row from web-app patch can be copied) and any `webStartup`/`webRuntime` rows.

- [ ] **Step 2: Write the failing host boot test (keyless)**

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

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/tests/host-boot.spec.ts`
Expected: FAIL — `startDesktopHost` not defined.

- [ ] **Step 4: Implement startDesktopHost**

`apps/desktop/src/main/host.ts`:

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

Note: `apiProxy` is a declaration-merged `ctx` property (`packages/host/apiproxy/src/index.ts` provides `ctx.apiProxy`); the test asserts the default `DSH_HOME` resolution only. In the electron entry (Step 10), set `process.env.DSH_HOME = join(app.getPath('userData'), 'dsh')` before calling `startDesktopHost()`.

- [ ] **Step 5: Run host boot test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/tests/host-boot.spec.ts`
Expected: PASS (boots the full tree; base bundles must be built: run `pnpm run build:lib` first if it fails on missing `lib/`).

- [ ] **Step 6: Write the failing bridge test (fake ipc pair)**

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

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-bridge.spec.ts`
Expected: FAIL — `registerIpcFetchBridge` not defined.

- [ ] **Step 8: Implement the bridge**

`apps/desktop/src/main/ipc-bridge.ts`:

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

- [ ] **Step 9: Run bridge test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/tests/ipc-bridge.spec.ts`
Expected: PASS.

- [ ] **Step 10: Real main-process entry with smoke-test fast path**

Replace the placeholder `apps/desktop/src/main/index.ts`:

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

- [ ] **Step 11: Build and commit**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Expected: builds clean.
Run: `pnpm exec vitest run apps/desktop/tests`
Expected: all pass.

```bash
git add apps/desktop/cordis.yml apps/desktop/src/main
git commit -m "feat(desktop): host boot and ipc bridge wiring in main process"
```

---

### Task 5: Preload bridge + renderer boot

**Files:**
- Create: `apps/desktop/src/preload/index.ts` (real implementation)
- Create: `apps/desktop/src/renderer/main.tsx` (real implementation)
- Modify: `apps/desktop/src/preload/index.ts` → exposes `window.dsh`:
  - `window.dsh.fetchRequest(req)` — `ipcRenderer.invoke('dsh:fetch', req)` returns `{status, headers, streamId}`-shaped envelope (actually the `IpcFetchResponse` from Task 2)
  - `window.dsh.onStream(callback)` — subscribes to `dsh:stream` events
  - `window.dsh.loadBundle(url)` — reads a bundle file from disk via the main process (`ipcRenderer.invoke('dsh:load-bundle', url)`)
- Modify: `apps/desktop/src/main/index.ts` — register `dsh:load-bundle` handler (reads the bundle file; resolution maps `/plugins/<id>/client.js`-style URLs to the built `lib/client.js` under the workspace package dirs)
- Modify: `packages/client/web/src/boot.tsx`? — NO: `AppWebEntry` already accepts `BootSeams` with `loadBundle`; no package change needed.

**Interfaces:**
- Consumes: `AppWebEntry(el, seams)` from `@deepseek-ai/dsh-client-web`; `BootSeams = { loadBundle(url: string): Promise<void> }`; `parseBootManifest` shape (`BootManifest` with `modules`/`plugins` rows, each `{ id, url, rev, immediately? }`).
- Produces:
  - `window.__DSH_BOOT__: BootManifest` set by the renderer entry from a `dsh:boot-manifest` invoke.
  - `window.dsh` bridge with `fetchRequest`, `onStream`, `loadBundle`.
  - Renderer `main.tsx`: fetch manifest → build `IpcApiClient` transport over `window.dsh` → set `window.__DSH_DESKTOP__` → set `window.__DSH_BOOT__` → `new AppWebEntry(el, { loadBundle }).run()`.

- [ ] **Step 1: Implement the preload bridge**

`apps/desktop/src/preload/index.ts`:

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

- [ ] **Step 2: Register the two new main-process handlers**

In `apps/desktop/src/main/index.ts`, inside `whenReady`:

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

- [ ] **Step 3: Implement the manifest provider**

Create `apps/desktop/src/main/manifest.ts`:

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

Wire it in `index.ts`:

```ts
ipcMain.handle('dsh:boot-manifest', async (): Promise<unknown> => buildBootManifest())
```

- [ ] **Step 4: Implement the renderer entry**

`apps/desktop/src/renderer/main.tsx`:

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

- [ ] **Step 5: Update the placeholder smoke-test reference and build**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Expected: builds clean (renderer typechecks against the new bridge types).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/preload apps/desktop/src/renderer apps/desktop/src/main/manifest.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): preload bridge and renderer boot over the shell"
```

---

### Task 6: electron-builder packaging config + icon

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/icon.png` (generated; electron-builder converts to icns/ico automatically)
- Create: `apps/desktop/scripts/generate-icon.mjs` (dependency-free PNG encoder using node zlib)
- Modify: `apps/desktop/package.json` — add `dist` scripts, `build.extraResources`? (see yml), `postinstall` electron-builder install-app-deps

**Interfaces:**
- Produces: `electron-builder` config producing `dist-installers/` with `dmg` + `zip` (mac) and NSIS `exe` (win); icon files; packaging smoke target `dist-installers/<app>-unpacked` via `--dir`.

- [ ] **Step 1: Write electron-builder.yml**

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

Note: `files` must also include the deployed node_modules closure — in CI, build the closure with `pnpm --filter @deepseek-ai/dsh-desktop deploy dist-app/prod` first, then add `dist-app/prod/**/*` to `files` (verify electron-builder includes node_modules automatically when present in `files`; adjust `files` accordingly during implementation). Workspace symlinks in node_modules are resolved by the deploy step.

- [ ] **Step 2: Write the icon generator (dependency-free)**

`apps/desktop/scripts/generate-icon.mjs` — a minimal PNG writer using node `zlib` (no canvas dependency): render a 1024×1024 RGBA buffer with a simple two-tone rounded square + "D" block letter approximation, then `zlib.deflateSync` the raw scanlines into a PNG with IDAT. Output `apps/desktop/build/icon.png`.

- [ ] **Step 3: Generate and verify the icon**

Run: `node apps/desktop/scripts/generate-icon.mjs`
Run: `file apps/desktop/build/icon.png`
Expected: `PNG image data, 1024 x 1024`.

- [ ] **Step 4: Local packaging check (macOS)**

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Run: `cd apps/desktop && pnpm exec electron-builder --dir --mac`
Expected: `dist-installers/mac*/DeepSeek Harness.app` exists (unpacked, unsigned).

- [ ] **Step 5: Smoke-test the packaged app**

Run: `"dist-installers/mac-arm64/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --smoke-test`
Expected: prints `dsh-desktop smoke OK` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/build apps/desktop/scripts apps/desktop/package.json
git commit -m "build(desktop): electron-builder packaging config and icon"
```

---

### Task 7: GitHub Actions workflow — build and release installers

**Files:**
- Create: `.github/workflows/desktop-release.yml`

**Interfaces:**
- Consumes: Task 6's electron-builder config; the repo's established CI patterns (`actions/checkout@v6`, `pnpm/action-setup@v4`, `actions/setup-node@v6` with node 24 + pnpm cache, `pnpm install --frozen-lockfile`, `DSH_TELEMETRY_DISABLED=1`).

- [ ] **Step 1: Write the workflow**

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
          - target: macos-x64
            runner: macos-13
            args: '--mac --x64=true --arm64=false'
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
              APP="apps/desktop/dist-installers/mac*/DeepSeek Harness.app"
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

Note: if the `macos-13` runner has been retired by GitHub when this lands, drop the `macos-x64` matrix row (keep arm64 + Windows) and note it in the PR.

- [ ] **Step 2: Validate the workflow syntax**

Run: `npx action-validator .github/workflows/desktop-release.yml` (or `python -c` YAML parse fallback if action-validator is unavailable)
Expected: valid.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/desktop-release.yml
git commit -m "ci(desktop): build and release workflow for desktop installers"
```

---

### Task 8: Agent Note + README

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md` (+ `.zh.md`)
- Create: `apps/desktop/README.md` (+ `.zh.md` per repo bilingual convention)
- Modify: `docs/superpowers/specs/2026-08-14-electron-desktop-design.md` (status → implemented, link the note)

**Interfaces:**
- Consumes: the shipped code from Tasks 1–7; the Agent Note format rules (`verify-agent-note-format` gates structure).

- [ ] **Step 1: Write the Agent Note**

`.agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md` — decisions: IPC fetch carrier as the transport aspect (`doFetch` subclass, protocol untouched); main-process host via `dsh-app-boot.boot()` without webserver; `ctx.apiProxy` face (`toFetchHandler`); `client-connection` seam (`window.__DSH_DESKTOP__`); manifest + bundle loading over IPC; unsigned packaging v1. Follow the format of `2026-07-19-gui-layering-and-rpc-protocol.md` (problem → decision → consequences). Write the `.zh.md` mirror.

- [ ] **Step 2: Write the app README**

`apps/desktop/README.md` — what it is, architecture (3 processes + IPC bridge), build instructions (`pnpm run build:lib`, desktop build, `--dir` packaging), smoke test, signing status, known limitations (unsigned Gatekeeper/SmartScreen, no auto-update yet). `.zh.md` mirror per repo bilingual policy.

- [ ] **Step 3: Update the spec status**

In `docs/superpowers/specs/2026-08-14-electron-desktop-design.md`, change `Status: approved` to `Status: implemented` and add a link to the Agent Note.

- [ ] **Step 4: Verify gates**

Run: `pnpm exec tsx scripts/verify-agent-note-format.ts` (or the repo's agent-note verification script)
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add .agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.md .agents/notes/implemented/architecture/2026-08-14-electron-desktop-shell.zh.md apps/desktop/README.md apps/desktop/README.zh.md docs/superpowers/specs/2026-08-14-electron-desktop-design.md
git commit -m "docs(desktop): agent note and README for the electron desktop shell"
```

---

## Self-Review Notes

- **Spec coverage:** every spec section maps to a task — form/IPC carrier → Tasks 2–5; host assembly without webserver → Task 4; packaging (dmg/zip/NSIS, unsigned, node-pty rebuild via npmRebuild) → Task 6; GitHub Actions matrix + dispatch/tag triggers + telemetry env → Task 7; Agent Note + README → Task 8; tsconfig paths rule → Task 1; out-of-scope items (signing, auto-update, Linux) are documented in Task 8's README.
- **Environment facts verified during planning (not placeholders):** `defaultLoadBundle` = classic async script element (Task 5 mirrors it with inline script); `DSH_HOME_ENV`/`resolveDshHome` precedence (Task 4 redirects via env before boot); `boot()` returns `Context` with `ctx.apiProxy` provided by the apiproxy gateway; `loadBundle(url: string) => Promise<void>` seam; connection package must not import the app (Task 3 transport helper stands in for the channel).
- **Deferred environment fact:** `macos-13` runner availability for the x64 macOS matrix row (workflow comment documents the drop-it fallback).
