/**
 * Desktop boot manifest provider: the renderer's window.__DSH_BOOT__ wire
 * graph, built from the collected web client bundles (collect-bundles.mjs
 * freezes one <package>/client.js per web client plugin under
 * dist/bundles). Every test builds its own fixture bundle root in a temporary
 * directory — the packaged app passes an explicit root (app.asar/dist/bundles)
 * and dev passes apps/desktop/dist/bundles, so an explicit fixture root
 * exercises the same scan without depending on repository build artifacts
 * (the CI coverage lane has no build step) or on a packaged app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import { buildBootManifest, clientBundlePathOf, discoverClientPlugins } from '../src/main/manifest.ts'

// Alphabetical: the manifest scan sorts bundle paths, so fixture assertions
// compare against the same order.
const FIXTURE_PACKAGES = ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-modules']

const roots: string[] = []

/** A bundle root fixture: one client.js per package, scoped names nested like dist/bundles. */
function fixtureBundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundles-'))
  roots.push(root)
  for (const name of FIXTURE_PACKAGES) {
    const target = join(root, name, 'client.js')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `window.__ModuleLoader__.load(${JSON.stringify(name)}, () => {})\n`)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop boot manifest', () => {
  it('discovers the web client plugin roster from a bundle root', () => {
    const root = fixtureBundleRoot()
    expect(discoverClientPlugins(root)).toEqual(FIXTURE_PACKAGES)
  })

  it('builds the wire graph with rev-carrying urls that map back to readable bundles', () => {
    const root = fixtureBundleRoot()
    const manifest = buildBootManifest(root)
    expect(manifest.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(manifest.entries.length).toBe(FIXTURE_PACKAGES.length)
    for (const row of manifest.entries) {
      expect(FIXTURE_PACKAGES).toContain(row.id)
      expect(row.rev).toMatch(/^[0-9a-f]{12}$/)
      // Same url shape the webserver graph carries; the load-bundle handler
      // parses the pathname (query ignored), so the query must never leak
      // into the id resolution.
      expect(row.url).toBe(`/plugins/${row.id}/client.js?rev=${row.rev}`)
      expect(new URL(row.url, 'http://dsh.internal').pathname).toBe(`/plugins/${row.id}/client.js`)
      expect(clientBundlePathOf(row.id, root)).toBe(join(root, row.id, 'client.js'))
    }
  })

  it('scans a packaged-style root (nested scoped dirs, explicit root injection)', () => {
    // Mirrors the packaged layout: electron-builder packs dist/bundles/**/*,
    // and the main process injects join(app.getAppPath(), 'dist/bundles').
    const root = fixtureBundleRoot()
    const manifest = buildBootManifest(root)
    expect(manifest.entries.map(row => row.id)).toEqual(FIXTURE_PACKAGES)
    for (const id of FIXTURE_PACKAGES) {
      expect(clientBundlePathOf(id, root)).toBe(join(root, id, 'client.js'))
    }
  })

  it('round-trips through the web shell boot parser (wire shape compatibility)', () => {
    const root = fixtureBundleRoot()
    const manifest = parseBootManifest(buildBootManifest(root))
    expect(manifest.modules.map(row => row.id)).toEqual(manifest.plugins.map(row => row.id))
    expect(manifest.rev).toBe(buildBootManifest(root).rev)
  })

  it('rejects unknown plugin ids when resolving bundle paths', () => {
    const root = fixtureBundleRoot()
    expect(() => clientBundlePathOf('@deepseek-ai/not-a-web-plugin', root)).toThrow(/not-a-web-plugin/)
  })

  it('is empty on a bundle root with no collected bundles', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundles-'))
    roots.push(root)
    expect(discoverClientPlugins(root)).toEqual([])
    expect(buildBootManifest(root).entries).toEqual([])
  })
})
