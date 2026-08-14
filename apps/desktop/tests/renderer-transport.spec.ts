/**
 * Renderer transport: the window.dsh bridge assembled into the
 * DesktopIpcTransport the connection client's IpcApiClient consumes. The
 * bridge stand-in captures requests and exposes a push for main-process stream
 * events, so ordering (subscribe-before-invoke), filtering (by requestId), and
 * termination (after end/error) are all deterministic.
 */
import { describe, expect, it } from 'vitest'
import type { IpcFetchRequest, IpcFetchResponse } from '../src/ipc/handler.ts'
import type { IpcStreamEvent } from '../src/ipc/framing.ts'
import type { DesktopBridge } from '../src/preload/index.ts'
import { createDesktopTransport } from '../src/renderer/transport.ts'

interface StubBridge {
  bridge: DesktopBridge
  requests: IpcFetchRequest[]
  push(event: IpcStreamEvent): void
  unsubscribeCount: () => number
}

/** DesktopBridge stand-in; `fetchRequest` can be swapped per test for ordering control. */
function stubBridge(): StubBridge {
  const requests: IpcFetchRequest[] = []
  let listener: ((event: IpcStreamEvent) => void) | undefined
  let unsubscribed = 0
  return {
    bridge: {
      async fetchRequest(request: IpcFetchRequest): Promise<IpcFetchResponse> {
        requests.push(request)
        return { status: 200, headers: { 'content-type': 'application/json' }, streamId: `stream-${request.requestId}` }
      },
      onStream(callback) {
        listener = callback
        return () => { unsubscribed += 1 }
      },
      loadBundle: async () => { throw new Error('unused in transport tests') },
      bootManifest: async () => ({}),
    },
    requests,
    push(event) { listener?.(event) },
    unsubscribeCount: () => unsubscribed,
  }
}

describe('desktop renderer transport', () => {
  it('streams ordered body events for the request and terminates after end', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x', init: { method: 'POST' } })
    const requestId = requests[0]?.requestId
    expect(requestId).toMatch(/[0-9a-f-]{36}/)
    expect(response.status).toBe(200)
    expect(response.headers).toEqual({ 'content-type': 'application/json' })
    push({ requestId: requestId!, kind: 'chunk', data: 'one' })
    push({ requestId: requestId!, kind: 'chunk', data: 'two' })
    push({ requestId: requestId!, kind: 'end' })
    const iterator = response.events()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'chunk', data: 'one' } })
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'chunk', data: 'two' } })
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'end' } })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(unsubscribeCount()).toBe(1)
  })

  it('forwards the request envelope with a minted requestId', async () => {
    const { bridge, requests } = stubBridge()
    const transport = createDesktopTransport(bridge)
    await transport.request({
      url: 'http://dsh.internal/api/x',
      init: { method: 'POST', headers: { 'x-test': '1' }, body: '{"a":1}' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'http://dsh.internal/api/x',
      init: { method: 'POST', headers: { 'x-test': '1' }, body: '{"a":1}' },
    })
  })

  it('queues events pushed before the fetch response resolves (subscribe-before-invoke)', async () => {
    const stub = stubBridge()
    // A fast body is fully read (and streamed) before the renderer's invoke
    // resolves: the main side replays buffered events into the channel before
    // the reply, so the listener must already be registered.
    stub.bridge.fetchRequest = async (request: IpcFetchRequest): Promise<IpcFetchResponse> => {
      stub.requests.push(request)
      const result: IpcFetchResponse = { status: 200, headers: {}, streamId: `stream-${request.requestId}` }
      stub.push({ requestId: request.requestId, kind: 'chunk', data: 'early' })
      return result
    }
    const transport = createDesktopTransport(stub.bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    await expect(response.events()[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: false, value: { requestId: stub.requests[0]?.requestId, kind: 'chunk', data: 'early' } })
  })

  it('ignores stream events from other requests', async () => {
    const { bridge, requests, push } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    push({ requestId: 'other-request', kind: 'chunk', data: 'foreign' })
    push({ requestId, kind: 'chunk', data: 'mine' })
    await expect(response.events()[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: false, value: { requestId, kind: 'chunk', data: 'mine' } })
  })

  it('terminates after an error event and unsubscribes', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    push({ requestId, kind: 'error', message: 'stream broke' })
    const iterator = response.events()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'error', message: 'stream broke' } })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(unsubscribeCount()).toBe(1)
  })

  it('unsubscribes when the fetch request fails', async () => {
    const stub = stubBridge()
    stub.bridge.fetchRequest = async () => { throw new Error('bridge down') }
    const transport = createDesktopTransport(stub.bridge)
    await expect(transport.request({ url: 'http://dsh.internal/api/x' })).rejects.toThrow('bridge down')
    expect(stub.unsubscribeCount()).toBe(1)
  })

  it('releases the listener on end without the consumer resuming (IpcApiClient pull loop)', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    push({ requestId, kind: 'chunk', data: 'body' })
    push({ requestId, kind: 'end' })
    const iterator = response.events()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'chunk', data: 'body' } })
    // IpcApiClient's pull loop stops resuming the generator after end
    // (controller.close() + return): the listener must already be gone.
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'end' } })
    expect(unsubscribeCount()).toBe(1)
    // With the listener removed, late pushes no longer accumulate in the mailbox.
    push({ requestId, kind: 'chunk', data: 'after-end' })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(unsubscribeCount()).toBe(1)
  })

  it('releases the listener on error without the consumer resuming the generator', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    push({ requestId, kind: 'error', message: 'stream broke' })
    const iterator = response.events()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'error', message: 'stream broke' } })
    // No further next(): the pull loop's controller.error() path never resumes.
    expect(unsubscribeCount()).toBe(1)
  })

  it('unsubscribes via finally when the consumer cancels a yielded stream', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    push({ requestId, kind: 'chunk', data: 'one' })
    const iterator: AsyncIterator<IpcStreamEvent, void, undefined> = response.events()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { requestId, kind: 'chunk', data: 'one' } })
    expect(unsubscribeCount()).toBe(0)
    // Yield-suspended (no pending poll): return() resumes the generator body
    // straight into the finally.
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    expect(unsubscribeCount()).toBe(1)
  })

  it('unsubscribes once the pending poll settles when the consumer cancels an empty mailbox', async () => {
    const { bridge, requests, push, unsubscribeCount } = stubBridge()
    const transport = createDesktopTransport(bridge)
    const response = await transport.request({ url: 'http://dsh.internal/api/x' })
    const requestId = requests[0]!.requestId
    const iterator: AsyncIterator<IpcStreamEvent, void, undefined> = response.events()[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 20))
    // IpcApiClient cancels while its pull is awaiting the mailbox: the
    // return() is queued behind the pending next() (async-generator FIFO), so
    // the finally runs only once the next event settles that poll.
    const cancelled = iterator.return?.()
    push({ requestId, kind: 'end' })
    await expect(pending).resolves.toEqual({ done: false, value: { requestId, kind: 'end' } })
    await expect(cancelled).resolves.toEqual({ done: true, value: undefined })
    expect(unsubscribeCount()).toBe(1)
  })
})
