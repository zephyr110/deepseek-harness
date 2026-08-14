import { describe, expect, it } from 'vitest'
import type { IpcFetchRequest, IpcFetchResponse } from '../src/ipc/handler.ts'
import { registerIpcFetchBridge } from '../src/main/ipc-bridge.ts'

describe('ipc bridge', () => {
  it('registers the dsh:fetch handler and pushes stream events to the sender', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const ipcHandlers = new Map<string, (event: unknown, req: IpcFetchRequest) => Promise<IpcFetchResponse>>()
    const sender = () => ({ send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } })
    const disposed = registerIpcFetchBridge(sender, async () => new Response('ok', { status: 200 }), (channel, handler) => { ipcHandlers.set(channel, handler) })
    const handler = ipcHandlers.get('dsh:fetch')
    expect(handler).toBeDefined()
    const result = await handler!({}, { requestId: 'r1', url: 'http://dsh.internal/api/host.describe', init: { method: 'POST' } })
    expect(result).toMatchObject({ status: 200 })
    expect(sent.some(m => m.channel === 'dsh:stream')).toBe(true)
    disposed()
  })
})
