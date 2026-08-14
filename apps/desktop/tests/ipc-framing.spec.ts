import { describe, expect, it } from 'vitest'
import { parseIpcStreamEvent, serializeIpcStreamEvent } from '../src/ipc/framing.ts'

describe('ipc framing', () => {
  it('round-trips chunk, end, and error events', () => {
    const chunk = { requestId: 'r1', kind: 'chunk', data: 'data: {"ok":true}\n\n' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(chunk))).toEqual(chunk)
    const end = { requestId: 'r1', kind: 'end' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(end))).toEqual(end)
    const err = { requestId: 'r1', kind: 'error', message: 'boom' } as const
    expect(parseIpcStreamEvent(serializeIpcStreamEvent(err))).toEqual(err)
  })

  it('rejects unknown event shapes', () => {
    expect(() => parseIpcStreamEvent(JSON.stringify({ requestId: 'r1', kind: 'nope' }))).toThrow()
  })
})
