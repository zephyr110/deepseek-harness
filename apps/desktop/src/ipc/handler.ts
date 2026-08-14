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
  /** Events emitted before `subscribe` installs the real subscriber; replayed on subscribe. */
  buffered: IpcStreamEvent[]
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
      const init: RequestInit = { method: request.init?.method ?? 'GET' }
      if (request.init?.headers !== undefined) init.headers = request.init.headers
      if (request.init?.body !== undefined) init.body = request.init.body
      const response = await fetchFn(request.url, init)
      const streamId = randomUUID()
      const stream: ActiveStream = { buffered: [], subscriber: () => {}, ended: false }
      // The transport subscribes only after handleRequest resolves (the streamId
      // comes from that resolution), so events emitted in the meantime — a small
      // body fully read before the renderer subscribes — must be buffered rather
      // than dropped; `subscribe` replays them.
      stream.subscriber = (event) => { stream.buffered.push(event) }
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
      // Replay buffered events straight to the callback: they are ordered and
      // complete (chunks then end/error), so the live-stream guard below would
      // wrongly drop their chunks once the stream has ended.
      for (const event of stream.buffered) callback(event)
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
