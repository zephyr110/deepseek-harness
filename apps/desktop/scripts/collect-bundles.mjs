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
 *
 * Besides the bundles, the script writes `dist/bundles/roster.json`: the
 * per-package `dsh.client` metadata (immediately prefetch marks and inject
 * edges) the renderer boot needs. The webserver graph carries these fields on
 * every row; without them the desktop shell prefetches nothing, so a bundle's
 * synchronous require of a peer client half (e.g. locale requiring
 * runtime/client) fails because the dependency was never loaded. The roster
 * freezes the metadata next to the bundles so the packaged app never needs to
 * resolve workspace package.json files.
 */
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The script lives at apps/desktop/scripts/, one level under the app dir.
const bundleRoot = fileURLToPath(new URL('../dist/bundles', import.meta.url))

// Client surfaces the desktop does not mount. The web surface composes
// directory picking through directory-picker-auto, which resolves ONE backend
// kind and mounts that kind's client surface as a Loader entry; browse and
// native both register the same conversation.hero.workspace.directoryFlow and
// sidebar.workspaces.directoryFlow slots at the same priority, so mounting
// both is a hard slot clash. The desktop host mounts the native backend (with
// the apiproxy host.pickDirectory face), so the native surface is the one
// desktop surface; browse (a browser-embedded dialog for hosts without a
// native picker) is excluded.
const EXCLUDED_CLIENT_PACKAGES = new Set(['@deepseek-ai/dsh-client-ui-directory-picker-browse'])

/** Narrow an unknown parsed JSON value to the scan-relevant declaration. */
function parseDshClient(value) {
  if (typeof value !== 'object' || value === null) return {}
  return value
}

/** One roster row: the dsh.client metadata frozen next to the bundles. */
function rosterRow(name, declaration) {
  const row = { id: name }
  if (Array.isArray(declaration.inject)) row.inject = declaration.inject
  if (declaration.immediately === true) row.immediately = true
  return row
}

const collected = new Set()
const roster = []
for (const manifestPath of globSync('packages/*/*/package.json', { cwd: repoRoot }).sort()) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf8'))
  } catch (error) {
    throw new Error(`collect-bundles: cannot read ${join(repoRoot, manifestPath)}: ${error.message}`)
  }
  const declaration = parseDshClient(manifest?.dsh?.client)
  if (declaration.platform !== 'web') continue
  const name = manifest?.name
  if (typeof name !== 'string') {
    throw new Error(`collect-bundles: ${manifestPath} declares dsh.client.platform=web without a name`)
  }
  if (EXCLUDED_CLIENT_PACKAGES.has(name)) continue
  const source = join(repoRoot, dirname(manifestPath), 'lib', 'client.js')
  if (!existsSync(source)) {
    throw new Error(`collect-bundles: ${name} is a web client plugin but ${source} is missing — run build:lib first`)
  }
  const target = join(bundleRoot, name, 'client.js')
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  collected.add(name)
  roster.push(rosterRow(name, declaration))
}

// Prune stale collected bundles: a package that stopped declaring a web client
// must not linger in the roster the packaged app scans.
for (const stale of globSync(['*/*/client.js', '*/client.js'], { cwd: bundleRoot })) {
  const name = stale.slice(0, -'/client.js'.length)
  if (!collected.has(name)) {
    rmSync(join(bundleRoot, dirname(stale)), { recursive: true, force: true })
  }
}

// The roster is the metadata source of truth for the boot manifest; write it
// last so a failed collection never leaves a stale roster behind.
writeFileSync(join(bundleRoot, 'roster.json'), `${JSON.stringify(roster, null, 2)}\n`)

console.log(`collect-bundles: ${collected.size} web client bundle(s) collected into ${bundleRoot}`)
