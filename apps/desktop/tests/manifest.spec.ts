/**
 * Desktop boot manifest provider: the renderer's window.__DSH_BOOT__ wire
 * graph, built from the collected web client bundles (collect-bundles.mjs
 * freezes one <package>/client.js per web client plugin under
 * dist/bundles, plus roster.json carrying each bundle's frozen rev and the
 * dsh.client metadata). Every test builds its own fixture bundle root in a
 * temporary directory — the packaged app passes an explicit root
 * (app.asar/dist/bundles) and dev passes apps/desktop/dist/bundles, so an
 * explicit fixture root exercises the same scan without depending on
 * repository build artifacts (the CI coverage lane has no build step) or on
 * a packaged app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import { buildBootManifest, clientBundlePathOf, discoverClientPlugins } from '../src/main/manifest.ts'

// Alphabetical: the manifest scan sorts bundle paths, so fixture assertions
// compare against the same order. connection carries a prefetch mark and an
// inject edge (like the real dsh.client declarations); modules declares
// neither (its real declaration is immediately: true, but the fixture keeps
// one row plain so the optional-field shape is pinned both ways).
const FIXTURE_PACKAGES = ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-modules']

/** sha1 short hash, same shortening collect-bundles applies at build time. */
function fixtureRev(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12)
}

const roots: string[] = []

/** A bundle root fixture: one client.js per package plus the roster, scoped names nested like dist/bundles. */
function fixtureBundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundles-'))
  roots.push(root)
  const roster = FIXTURE_PACKAGES.map((name) => {
    const content = `window.__ModuleLoader__.load(${JSON.stringify(name)}, () => {})\n`
    const target = join(root, name, 'client.js')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    return {
      id: name,
      rev: fixtureRev(content),
      ...(name === '@deepseek-ai/dsh-client-connection'
        ? { immediately: true, inject: ['@deepseek-ai/dsh-api-remotes'] }
        : {}),
    }
  })
  writeFileSync(join(root, 'roster.json'), `${JSON.stringify(roster)}\n`)
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

  it('builds the wire graph with the frozen roster revs and rev-carrying urls', () => {
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

  it('carries the roster immediately marks and inject edges like the webserver graph', () => {
    const root = fixtureBundleRoot()
    const manifest = buildBootManifest(root)
    const connection = manifest.entries.find(row => row.id === '@deepseek-ai/dsh-client-connection')
    expect(connection).toBeDefined()
    expect(connection!.immediately).toBe(true)
    expect(connection!.inject).toEqual(['@deepseek-ai/dsh-api-remotes'])
    const modules = manifest.entries.find(row => row.id === '@deepseek-ai/dsh-client-modules')
    expect(modules).toBeDefined()
    // inject appears only when the declaration has edges (the webserver
    // graphRow omits it otherwise); the prefetch mark only when set.
    expect(modules!.inject).toBeUndefined()
    expect(modules!.immediately).toBeUndefined()
    // The renderer's stage-one prefetch tier keys on the mark (the plugins
    // view, per the shell boot kernel): every immediately row must appear
    // there.
    const parsed = parseBootManifest(manifest)
    const prefetchIds = parsed.plugins.filter(row => row.immediately).map(row => row.id)
    expect(prefetchIds).toEqual(['@deepseek-ai/dsh-client-connection'])
  })

  it('fails loud when bundles exist but the roster is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundles-'))
    roots.push(root)
    const target = join(root, '@deepseek-ai/dsh-client-connection', 'client.js')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'window.__ModuleLoader__.load("x", () => {})\n')
    expect(() => buildBootManifest(root)).toThrow(/roster\.json/)
  })

  it('fails loud on a bundle root with no collected bundles', () => {
    // collect-bundles.mjs is a fixed build step, so an empty root is a
    // packaging accident — the boot must not silently produce a plugin-less
    // shell.
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundles-'))
    roots.push(root)
    expect(discoverClientPlugins(root)).toEqual([])
    expect(() => buildBootManifest(root)).toThrow(/no collected client bundles/)
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
    const manifest = buildBootManifest(root)
    const parsed = parseBootManifest(manifest)
    expect(parsed.modules.map(row => row.id)).toEqual(parsed.plugins.map(row => row.id))
    expect(parsed.rev).toBe(manifest.rev)
  })

  it('rejects unknown plugin ids when resolving bundle paths', () => {
    const root = fixtureBundleRoot()
    expect(() => clientBundlePathOf('@deepseek-ai/not-a-web-plugin', root)).toThrow(/not-a-web-plugin/)
  })
})
