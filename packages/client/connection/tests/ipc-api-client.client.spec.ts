/**
 * IpcApiClient: the Electron IPC fetch carrier. The transport stand-in runs the
 * same WHATWG fetch face the desktop main process bridges over IPC (the real
 * toFetchHandler), delivering the body as one chunk event — the IPC channel's
 * own multi-chunk framing is Task 2's coverage.
 */
import { describe, expect, it } from 'vitest'
import { RpcId, toFetchHandler, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import {
  IpcApiClient,
  type DesktopIpcTransport,
  type IpcStreamEvent,
} from '../src/client/ipc-api-client.ts'

/** Minimal ApiProxy stub: echoes rpcIds, serves a schema-valid host.describe value and one host frame. */
function stubApiProxy(): ApiProxy {
  return {
    sessions: {
      list: async (request: { rpcId: RpcId }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
      create: async (request: { rpcId: RpcId }) => ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 's1' as never } } }),
    },
    host: {
      describe: async (request: { rpcId: RpcId }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { version: '0.1.0-rc.5', cwd: '/tmp', attachedSessions: 0, canOpenPath: false } },
      }),
    },
    events: {
      host: async function * () {
        yield { rpcId: RpcId('frame-0'), payload: { type: 'host/session-removed', sessionId: 's1' as never } }
      },
    },
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
        ...req.init?.method === undefined ? {} : { method: req.init.method },
        ...req.init?.headers === undefined ? {} : { headers: req.init.headers },
        ...req.init?.body === undefined ? {} : { body: req.init.body },
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
    const frames: Array<{ rpcId: string }> = []
    for await (const frame of client.events.host({}, new AbortController().signal)) {
      frames.push(frame)
      break
    }
    expect(frames.length).toBe(1)
  })

  it('rejects the call when the ipc transport throws', async () => {
    const client = new IpcApiClient({
      async request() {
        throw new Error('bridge down')
      },
    })
    await expect(client.host.describe({})).rejects.toThrow('ipc fetch failed')
  })

  it('errors the reassembled body when the stream carries an error event', async () => {
    const client = new ExposedIpcClient({
      async request() {
        return {
          status: 200,
          headers: {},
          events: async function* () {
            yield { requestId: 'rid', kind: 'error', message: 'stream broke' }
          },
        }
      },
    })
    const response = await client.send(new URL('http://dsh.internal/api/x'), { method: 'POST' })
    await expect(response.text()).rejects.toThrow('stream broke')
  })

  it('closes the reassembled body when the stream ends without chunks', async () => {
    const client = new ExposedIpcClient({
      async request() {
        return { status: 200, headers: {}, events: async function* () {} }
      },
    })
    const response = await client.send(new URL('http://dsh.internal/api/x'), { method: 'POST' })
    expect(await response.text()).toBe('')
  })

  it('forwards Headers instances and rejects non-string request bodies', async () => {
    const received: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
    const client = new ExposedIpcClient({
      async request(req) {
        received.push(req)
        return { status: 200, headers: {}, events: async function* () {} }
      },
    })
    await client.send(new URL('http://dsh.internal/api/x'), { headers: new Headers({ 'x-test': '1' }) })
    expect(received[0]?.init?.headers).toEqual({ 'x-test': '1' })
    await expect(client.send(new URL('http://dsh.internal/api/x'), { body: new Uint8Array([1]) }))
      .rejects.toThrow('non-string request bodies')
  })

  it('cancels the transport event iterator when the body reader is cancelled', async () => {
    let returned = false
    const client = new ExposedIpcClient({
      async request() {
        return {
          status: 200,
          headers: {},
          events: async function* () {
            try {
              yield { requestId: 'rid', kind: 'chunk', data: 'x' }
              await new Promise<void>(() => undefined) // stream stays open until cancelled
            } finally {
              returned = true
            }
          },
        }
      },
    })
    const response = await client.send(new URL('http://dsh.internal/api/x'), { method: 'POST' })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(returned).toBe(true)
  })

  it('rejects with the abort reason when the signal aborts while the transport is in flight', async () => {
    const client = new ExposedIpcClient({
      async request() {
        await new Promise<void>(() => undefined)
        return { status: 200, headers: {}, events: async function* () {} }
      },
    })
    const controller = new AbortController()
    const pending = client.send(new URL('http://dsh.internal/api/x'), { method: 'POST', signal: controller.signal })
    const expectation = expect(pending).rejects.toThrow('caller cancelled')
    controller.abort('caller cancelled')
    await expectation
  })

  it('rejects pre-aborted signals without touching the transport', async () => {
    let called = false
    const client = new ExposedIpcClient({
      async request() {
        called = true
        return { status: 200, headers: {}, events: async function* () {} }
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(client.send(new URL('http://dsh.internal/api/x'), { signal: controller.signal })).rejects.toThrow()
    expect(called).toBe(false)
  })
})

/** Test seam: doFetch is protected on the carrier; expose it for direct body inspection. */
class ExposedIpcClient extends IpcApiClient {
  public send(input: URL, init?: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }
}
