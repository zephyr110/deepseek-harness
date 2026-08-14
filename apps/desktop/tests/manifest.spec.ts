/**
 * Desktop boot manifest provider: the renderer's window.__DSH_BOOT__ wire
 * graph, built from the built workspace client plugin packages. Tests run
 * against the real repository (the provider's default scan root), so they
 * double as the load-bundle consistency check: every row url must survive the
 * same pathname parse the main-process dsh:load-bundle handler applies and
 * resolve back to a readable bundle.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import { buildBootManifest, clientBundlePathOf, discoverClientPlugins } from '../src/main/manifest.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('desktop boot manifest', () => {
  it('discovers the web client plugin roster by dsh.client.platform declaration', () => {
    const plugins = discoverClientPlugins()
    expect(plugins.length).toBeGreaterThan(0)
    expect(plugins).toContain('@deepseek-ai/dsh-client-modules')
    expect(plugins).toContain('@deepseek-ai/dsh-client-connection')
    expect([...new Set(plugins)]).toEqual(plugins)
  })

  it('builds the wire graph with rev-carrying urls that map back to readable bundles', () => {
    const manifest = buildBootManifest()
    expect(manifest.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(manifest.entries.length).toBe(discoverClientPlugins().length)
    for (const row of manifest.entries) {
      expect(row.id).toMatch(/^@deepseek-ai\//)
      expect(row.rev).toMatch(/^[0-9a-f]{12}$/)
      // Same url shape the webserver graph carries; the load-bundle handler
      // parses the pathname (query ignored), so the query must never leak
      // into the id resolution.
      expect(row.url).toBe(`/plugins/${row.id}/client.js?rev=${row.rev}`)
      expect(new URL(row.url, 'http://dsh.internal').pathname).toBe(`/plugins/${row.id}/client.js`)
      expect(existsSync(clientBundlePathOf(row.id))).toBe(true)
    }
  })

  it('round-trips through the web shell boot parser (wire shape compatibility)', () => {
    const manifest = parseBootManifest(buildBootManifest())
    expect(manifest.modules.map(row => row.id)).toEqual(manifest.plugins.map(row => row.id))
    expect(manifest.rev).toBe(buildBootManifest().rev)
  })

  it('rejects unknown plugin ids when resolving bundle paths', () => {
    expect(() => clientBundlePathOf('@deepseek-ai/not-a-web-plugin')).toThrow(/not-a-web-plugin/)
  })

  it('scans from an explicit root like dev-web', () => {
    // A fixture-free root sanity check: the function accepts a root override.
    expect(discoverClientPlugins(repoRoot).length).toBeGreaterThan(0)
  })
})
