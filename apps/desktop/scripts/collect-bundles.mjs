#!/usr/bin/env node
/**
 * Collect the web client plugin bundles the packaged desktop app boots.
 *
 * The main-process manifest scans a bundle root, not the workspace: inside the
 * asar, `apps/desktop/dist/main/index.js` can no longer normalize a URL to the
 * repository root (it resolves outside the archive, so scanning the workspace
 * package tree comes back empty and the roster would be empty). This script freezes the
 * roster into the build output instead: every workspace package declaring
 * `dsh.client.platform === 'web'` has its built `lib/client.js` copied to
 * `apps/desktop/dist/bundles/<package>/client.js` (scoped names keep their
 * nested directory, e.g. `@deepseek-ai/dsh-client-modules/client.js`), which
 * electron-builder packs into the asar via the `dist/bundles` files glob.
 *
 * Idempotent: re-running overwrites the same files and prunes bundles from
 * packages that no longer declare a web client. Fail-loud: a missing
 * `lib/client.js` is an error — the CI order (build:lib before desktop build)
 * guarantees the source exists, so a silent skip would mask a broken roster.
 */
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The script lives at apps/desktop/scripts/, one level under the app dir.
const bundleRoot = fileURLToPath(new URL('../dist/bundles', import.meta.url))

/** Narrow an unknown parsed JSON value to the scan-relevant declaration. */
function parseDshClient(value) {
  if (typeof value !== 'object' || value === null) return {}
  return value
}

const collected = new Set()
for (const manifestPath of globSync('packages/*/*/package.json', { cwd: repoRoot }).sort()) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf8'))
  } catch (error) {
    throw new Error(`collect-bundles: cannot read ${join(repoRoot, manifestPath)}: ${error.message}`)
  }
  if (parseDshClient(manifest?.dsh?.client).platform !== 'web') continue
  const name = manifest?.name
  if (typeof name !== 'string') {
    throw new Error(`collect-bundles: ${manifestPath} declares dsh.client.platform=web without a name`)
  }
  const source = join(repoRoot, dirname(manifestPath), 'lib', 'client.js')
  if (!existsSync(source)) {
    throw new Error(`collect-bundles: ${name} is a web client plugin but ${source} is missing — run build:lib first`)
  }
  const target = join(bundleRoot, name, 'client.js')
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  collected.add(name)
}

// Prune stale collected bundles: a package that stopped declaring a web client
// must not linger in the roster the packaged app scans.
for (const stale of globSync(['*/*/client.js', '*/client.js'], { cwd: bundleRoot })) {
  const name = stale.slice(0, -'/client.js'.length)
  if (!collected.has(name)) {
    rmSync(join(bundleRoot, dirname(stale)), { recursive: true, force: true })
  }
}

console.log(`collect-bundles: ${collected.size} web client bundle(s) collected into ${bundleRoot}`)
