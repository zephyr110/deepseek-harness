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
 * Termination: the mailbox listener unsubscribes itself the moment it
 * observes a terminal event — independent of whether the events iterator is
 * ever driven (abort, or a non-2xx response whose body the base client never
 * reads, leave the iterator untouched, so the listener cannot rely on it) —
 * and the iterator also unsubscribes before yielding the terminal event.
 * Delivery is push-based: the listener wakes a parked waiter instead of
 * polling, so an idle stream costs nothing and events land without the
 * poll-interval delay.
 */
import type { DesktopBridge } from '../preload/index.ts'
import type { IpcFetchRequest } from '../ipc/handler.ts'
import type { IpcStreamEvent } from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopIpcTransport } from '@deepseek-ai/dsh-client-connection/client'

/** One in-flight stream's mailbox: ordered events plus a parked waiter. */
interface Mailbox {
  events: IpcStreamEvent[]
  wake: (() => void) | undefined
  unsubscribed: boolean
}

/**
 * Build the desktop IPC transport over the preload bridge.
 * @param bridge - the window.dsh contextBridge surface.
 * @returns the transport the renderer hands to IpcApiClient.
 */
export function createDesktopTransport(bridge: Pick<DesktopBridge, 'fetchRequest' | 'onStream'>): DesktopIpcTransport {
  return {
    async request(req) {
      const requestId = crypto.randomUUID()
      const mailbox: Mailbox = { events: [], wake: undefined, unsubscribed: false }
      const removeListener = bridge.onStream((event) => {
        // Only this stream's events reach the mailbox; the requestId filter
        // rides every event from the main process.
        if (event.requestId !== requestId) return
        const terminal = event.kind === 'end' || event.kind === 'error'
        if (terminal && !mailbox.unsubscribed) {
          // Release the listener at the source: consumers that abandon the
          // response (abort, non-2xx read as failure before the body) never
          // drive the iterator, so this is the only cleanup that always runs.
          mailbox.unsubscribed = true
          removeListener()
        }
        mailbox.events.push(event)
        mailbox.wake?.()
      })
      const unsubscribe = (): void => {
        if (mailbox.unsubscribed) return
        mailbox.unsubscribed = true
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
              const event = mailbox.events.shift()
              if (event === undefined) {
                // Park until the listener delivers an event; the wake call
                // resumes this exact iteration.
                await new Promise<void>((resolve) => { mailbox.wake = resolve })
                mailbox.wake = undefined
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
        cancel: () => {
          // Stops the listener and drops the mailbox; the main process keeps
          // streaming until the body ends (no IPC cancel channel), and its
          // terminal-event cleanup releases the entry when the stream finishes.
          unsubscribe()
          mailbox.events.length = 0
        },
      }
    },
  }
}
