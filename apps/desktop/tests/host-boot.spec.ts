import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDesktopHost } from '../src/main/host.ts'

describe('desktop host', () => {
  const homes: string[] = []
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  it('boots the plugin tree and exposes a working fetch face', async () => {
    // Hermetic persistence: dshHomePath resolves $DSH_HOME first (the same
    // redirection the electron main performs), so the booted tree writes into
    // a throwaway home instead of the developer's ~/.dsh.
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-host-'))
    homes.push(home)
    process.env.DSH_HOME = home
    try {
      const { fetch } = await startDesktopHost()
      // Unary round trip through the real in-process wire, no network.
      const response = await fetch.fetch('http://dsh.internal/api/host.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rpcId: 't1', type: 'client-request', method: 'host.describe', payload: {} }),
      })
      expect(response.status).toBe(200)
      const envelope = await response.json()
      expect(envelope.type).toBe('server-response')
      expect(envelope.result.ok).toBe(true)
    } finally {
      delete process.env.DSH_HOME
    }
  }, 30_000)
})
