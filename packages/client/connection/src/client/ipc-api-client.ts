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
import { RpcId, serverResponseSchema, type ClientRequest, type RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { assertTarget } from './rpc.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { randomUuid } from './random-uuid.ts'

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
 * 5) installs an implementation on `window.__DSH_DESKTOP__`. `cancel` stops the
 * renderer-side subscription and mailbox when the caller abandons the response
 * (abort, timeout, or a non-2xx status read as failure before the body is
 * consumed) — without it every abandoned request would leak a stream listener.
 */
export interface DesktopIpcTransport {
  request(req: {
    url: string
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  }): Promise<{
    status: number
    headers: Record<string, string>
    events(): AsyncIterable<IpcStreamEvent>
    cancel?(): void
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

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // RequestInit.signal is `AbortSignal | null | undefined`; the transport
    // contract takes `AbortSignal | undefined`, so null normalizes to absent.
    const signal = init?.signal ?? undefined
    if (signal === undefined) return this.runTransport(input, init)
    // Pre-aborted signals reject without touching the transport.
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      // An abort while the transport is in flight rejects the call right away
      // (the base client's timeout merge rides the same AbortSignal, so a hung
      // transport cannot defeat the unary deadline); runTransport cancels the
      // subscription when the transport settles.
      const onAbort = (): void => { reject(abortError(signal)) }
      signal.addEventListener('abort', onAbort, { once: true })
      this.runTransport(input, init, signal)
        .then(resolve, reject)
        .finally(() => { signal.removeEventListener('abort', onAbort) })
    })
  }

  /**
   * The IPC hop itself. The transport has no signal channel, so the caller's
   * signal is enforced here: pre-aborted signals reject without touching the
   * transport, and an abort while the transport is in flight rejects the call
   * and cancels the response subscription (the base client's timeout merge
   * rides the same AbortSignal, so a hung transport cannot defeat the unary
   * deadline). Cancelling the subscription is what stops the abandoned
   * response from leaking its stream listener; the main process keeps
   * streaming until the body ends (no IPC cancel channel), and its own
   * terminal-event cleanup releases the entry when the stream finishes.
   */
  private async runTransport(input: URL, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted === true) throw abortError(signal)
    const headers: Record<string, string> = {}
    for (const [key, value] of init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)) {
      headers[key] = value
    }
    let body: string | undefined
    if (typeof init?.body === 'string') body = init.body
    else if (init?.body !== undefined) throw new Error('ipc client: non-string request bodies unsupported')
    const pending = this.transport.request({
      url: input.href,
      init: {
        headers,
        ...init?.method === undefined ? {} : { method: init.method },
        ...body === undefined ? {} : { body },
      },
    })
    if (signal !== undefined && !signal.aborted) {
      // The doFetch wrapper owns the caller-facing rejection; this listener
      // only cancels the response subscription once the transport settles.
      signal.addEventListener('abort', () => {
        void pending.then((response) => { response.cancel?.() }).catch(() => {})
      }, { once: true })
    }
    let response: Awaited<ReturnType<DesktopIpcTransport['request']>>
    try {
      response = await pending
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      // The base carrier surfaces transport throws to callers (postJson already
      // wraps non-2xx statuses); label the IPC hop so its failures are not
      // mistaken for upstream or server errors.
      throw new Error('ipc fetch failed', { cause: error })
    }
    if (signal?.aborted) {
      response.cancel?.()
      throw abortError(signal)
    }
    const responseHeaders = new Headers(response.headers)
    const iterator = response.events()[Symbol.asyncIterator]()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        switch (value.kind) {
          case 'chunk':
            controller.enqueue(new TextEncoder().encode(value.data))
            return
          case 'end':
            controller.close()
            return
          case 'error':
            controller.error(new Error(value.message))
            return
          default:
            // The closed IpcStreamEvent union: a new member is a wire-contract
            // change and must not silently fall through as an error.
            assertNever(value)
        }
      },
      cancel() {
        void iterator.return?.()
        response.cancel?.()
      },
    })
    return new Response(stream, { status: response.status, headers: responseHeaders })
  }
}

/**
 * IPC-backed generic Connection RPC caller: the desktop twin of
 * createWebConnectionRpc. The web caller posts to the server origin; the
 * desktop renderer has no origin (file://), so the same ClientRequest envelope
 * rides the desktop transport to the in-process host, and the response
 * envelope is validated identically (serverResponseSchema + rpcId echo).
 */
export function createIpcConnectionRpc(transport: DesktopIpcTransport): ClientConnectionRpc {
  return {
    async call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RpcResult<unknown>> {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      if (signal?.aborted === true) throw abortError(signal)
      const response = await transport.request({
        url: `${channel}/${endpoint}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
        },
      })
      if (signal !== undefined) {
        if (signal.aborted) {
          response.cancel?.()
          throw abortError(signal)
        }
        signal.addEventListener('abort', () => { response.cancel?.() }, { once: true })
      }
      if (response.status !== 200) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      let text = ''
      for await (const event of response.events()) {
        if (event.kind === 'chunk') text += event.data
        else if (event.kind === 'error') throw new Error(`transport failure for ${channel}/${endpoint}: ${event.message}`)
      }
      const full = serverResponseSchema.parse(JSON.parse(text))
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/** The closed IpcStreamEvent union ends here: a new member is a compile error. */
function assertNever(value: never): never {
  throw new Error(`ipc client: unknown stream event kind ${JSON.stringify(value)}`)
}

/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}
