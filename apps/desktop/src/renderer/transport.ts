/**
 * Desktop renderer transport: assembles the window.dsh bridge into the
 * DesktopIpcTransport the connection client's IpcApiClient consumes (via
 * window.__DSH_DESKTOP__). Pure bridge composition — no electron or DOM
 * imports — so the ordering and termination rules are unit-testable.
 *
 * Ordering: the stream listener is registered BEFORE fetchRequest, because
 * the main process replays a fully-read body into the 'dsh:stream' channel
 * before the invoke reply (the ipc-bridge buffers for exactly this window);
 * a listener installed after the reply resolves would drop those events.
 * Events carry the requestId the transport minted (the handler echoes it),
 * not the streamId, so filtering compares against the minted requestId.
 * Termination: the events iterator unsubscribes before yielding the end/error
 * event and stops after it, so a response releases its listener even when the
 * consumer (IpcApiClient's pull loop) stops resuming the generator at a
 * terminal event instead of driving it to completion.
 */
import type { DesktopBridge } from '../preload/index.ts'
import type { IpcFetchRequest } from '../ipc/handler.ts'
import type { IpcStreamEvent } from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopIpcTransport } from '@deepseek-ai/dsh-client-connection/client'

/** Poll interval between listener-queue drains while a stream stays open. */
const POLL_INTERVAL_MS = 5

/**
 * Build the desktop IPC transport over the preload bridge.
 * @param bridge - the window.dsh contextBridge surface.
 * @returns the transport the renderer hands to IpcApiClient.
 */
export function createDesktopTransport(bridge: Pick<DesktopBridge, 'fetchRequest' | 'onStream'>): DesktopIpcTransport {
  return {
    async request(req) {
      const requestId = crypto.randomUUID()
      const events: IpcStreamEvent[] = []
      const removeListener = bridge.onStream((event) => {
        // Stream events echo the requestId the transport minted; events from
        // other in-flight requests are ignored by this stream's mailbox.
        if (event.requestId === requestId) events.push(event)
      })
      // Idempotent: the generator unsubscribes before yielding a terminal
      // event (consumers stop resuming the generator there, so the finally
      // would never run) and again in the finally as the return()/GC fallback.
      let unsubscribed = false
      const unsubscribe = (): void => {
        if (unsubscribed) return
        unsubscribed = true
        removeListener()
      }
      let response: Awaited<ReturnType<DesktopBridge['fetchRequest']>>
      try {
        response = await bridge.fetchRequest({ requestId, ...req } satisfies IpcFetchRequest)
      } catch (error) {
        unsubscribe()
        throw error
      }
      return {
        status: response.status,
        headers: response.headers,
        events: async function* () {
          try {
            for (;;) {
              const event = events.shift()
              if (event === undefined) {
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
                continue
              }
              if (event.kind === 'end' || event.kind === 'error') {
                unsubscribe()
                yield event
                return
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
}
