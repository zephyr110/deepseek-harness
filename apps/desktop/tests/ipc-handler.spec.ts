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
    const { status, streamId } = await handler.handleRequest({ requestId: 'r1', url: 'http://dsh.internal/api/events.mux', init: {} })
    handler.subscribe(streamId, ev => events.push(ev.kind === 'chunk' ? ev.data : ev.kind))
    await new Promise(resolve => setTimeout(resolve, 20))
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
