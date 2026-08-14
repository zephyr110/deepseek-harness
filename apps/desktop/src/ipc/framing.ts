/**
 * Wire framing for the IPC fetch bridge. Events are JSON strings carried by
 * `webContents.send('dsh:stream', ...)`. The event types come from the
 * connection package — the same union the renderer-side consumer (IpcApiClient)
 * narrows — so the wire contract has one definition instead of two copies that
 * can drift apart. The variant interfaces are re-exported so the preload
 * sender side can construct events; parsing narrows through the union.
 */
import type { IpcStreamEvent } from '@deepseek-ai/dsh-client-connection/client'
export type { IpcStreamChunkEvent, IpcStreamEndEvent, IpcStreamErrorEvent, IpcStreamEvent } from '@deepseek-ai/dsh-client-connection/client'

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
