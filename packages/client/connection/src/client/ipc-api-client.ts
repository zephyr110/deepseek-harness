/**
 * Electron IPC fetch carrier: the desktop transport aspect. `doFetch` runs the
 * injected transport, reassembles the streamed body into a WHATWG Response so
 * the AbstractApiClient base keeps every protocol invariant (rpcId minting,
 * envelope zod parsing, SSE framing). No electron import — the transport is
 * injected (the preload bridge supplies it in the desktop renderer). The
 * browser-safe contract imports follow the package convention (./api.ts, never
 * the apiproxy package root).
 */
import { AbstractApiClient } from './api.ts'

/** One streamed body chunk event from the main process. */
export interface IpcStreamChunkEvent { requestId: string; kind: 'chunk'; data: string }
/** Terminal event: the streamed body is complete. */
export interface IpcStreamEndEvent { requestId: string; kind: 'end' }
/** Terminal event: the main process aborted the stream with a message. */
export interface IpcStreamErrorEvent { requestId: string; kind: 'error'; message: string }
/** Body stream events the desktop transport replays, in order. */
export type IpcStreamEvent = IpcStreamChunkEvent | IpcStreamEndEvent | IpcStreamErrorEvent

/**
 * The Electron IPC channel behind IpcApiClient: a fetch-shaped request with a
 * streamed body delivered as ordered events. The renderer preload bridge (Task
 * 5) installs an implementation on `window.__DSH_DESKTOP__`.
 */
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

/**
 * Desktop fetch carrier: `doFetch` runs the injected transport and reassembles
 * its streamed body into a WHATWG Response, so the base class handles every
 * protocol invariant unchanged (unary POST, SSE GET streams, respond).
 */
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
    let response: Awaited<ReturnType<DesktopIpcTransport['request']>>
    try {
      response = await this.transport.request({
        url: input.href,
        init: {
          headers,
          ...init?.method === undefined ? {} : { method: init.method },
          ...body === undefined ? {} : { body },
        },
      })
    } catch (error) {
      // The base carrier surfaces transport throws to callers (postJson already
      // wraps non-2xx statuses); label the IPC hop so its failures are not
      // mistaken for upstream or server errors.
      throw new Error('ipc fetch failed', { cause: error })
    }
    const responseHeaders = new Headers(response.headers)
    const eventBuffer: IpcStreamEvent[] = []
    const iterator = response.events()[Symbol.asyncIterator]()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (eventBuffer.length > 0) {
            // The length guard above makes the shift's undefined impossible.
            const event = eventBuffer.shift() as IpcStreamEvent
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
