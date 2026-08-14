/**
 * Desktop boot manifest: the client roster the renderer boots against — the
 * same wire graph the webserver injects as window.__DSH_BOOT__ (WebBootGraph),
 * built from the collected web client bundles (no HTTP involved). Rows carry
 * the dsh.client metadata the webserver graph carries: `immediately` prefetch
 * marks (the stage-one tier that pre-registers every factory before entry
 * creation — without it a bundle's synchronous require of a peer client half,
 * e.g. locale requiring @deepseek-ai/dsh-client-runtime/client, hits an
 * unregistered factory) and `inject` edges (informational in the graph).
 *
 * The scan targets a bundle root, not the workspace: collect-bundles.mjs
 * freezes one <package>/client.js per web client plugin under
 * apps/desktop/dist/bundles plus a roster.json carrying the metadata, which is
 * what electron-builder packs into the asar — inside the archive no URL can
 * normalize back to the repository root, so scanning the workspace package
 * tree there would come back empty. Callers pass an explicit root (the main
 * entry injects app.getAppPath()/dist/bundles when packaged,
 * apps/desktop/dist/bundles in dev); the default serves tests and direct
 * callers.
 */
import { readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

const defaultBundleRoot = fileURLToPath(new URL('../../dist/bundles', import.meta.url))

/** One roster row as collect-bundles.mjs writes it (dsh.client metadata plus the build-time bundle rev). */
interface RosterRow {
  id: string
  /** sha1 of the collected bundle, frozen at collect time — the manifest never re-reads bundles for revs. */
  rev: string
  immediately?: boolean
  inject?: string[]
}

/** Read the collected-roster metadata, failing loud when bundles exist but the roster does not. */
function readRoster(root: string): Map<string, RosterRow> {
  const rosterPath = join(root, 'roster.json')
  try {
    const rows = JSON.parse(readFileSync(rosterPath, 'utf8')) as RosterRow[]
    if (!Array.isArray(rows)) throw new Error(`roster.json at ${root} is not an array`)
    return new Map(rows.map(row => [row.id, row]))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`dsh-desktop: cannot read bundle roster ${rosterPath}: ${detail}`, { cause: error })
  }
}

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev), same shortening the webserver graph uses. */
function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

// The bundle tree is frozen at build time and never changes during a run, so
// the scan result is safe to memoize — the boot manifest and every
// load-bundle resolution share one scan instead of re-globbing per call.
const discoveryCache = new Map<string, Array<{ name: string }>>()

/**
 * Scan the collected web client bundle directories under a bundle root.
 * @param root - bundle root holding one <package>/client.js per collected
 * bundle (collect-bundles.mjs output), scoped names nested under their scope.
 * @returns discovered bundle package names.
 */
export function discoverClientBundleDirs(root = defaultBundleRoot): Array<{ name: string }> {
  const cached = discoveryCache.get(root)
  if (cached !== undefined) return cached
  const dirs: Array<{ name: string }> = []
  for (const relPath of globSync(['*/*/client.js', '*/client.js'], { cwd: root }).sort()) {
    // dirs use forward slashes even on win32, so the suffix strip is safe.
    dirs.push({ name: relPath.slice(0, -'/client.js'.length) })
  }
  discoveryCache.set(root, dirs)
  return dirs
}

/**
 * Discovered bundle package names (the loader-entry-style roster view).
 * @param root - bundle root holding the collected web client bundles.
 * @returns web client plugin package names.
 */
export function discoverClientPlugins(root = defaultBundleRoot): string[] {
  return discoverClientBundleDirs(root).map(entry => entry.name)
}

/**
 * Build the desktop boot graph: one wire entry per collected client bundle,
 * urls shaped `/plugins/<id>/client.js?rev=<rev>` exactly like the webserver
 * graph, with the roster's frozen rev and immediately/inject metadata on each
 * row — nothing here re-reads the bundles, so repeated calls (each window
 * boot) cost one small roster read.
 * @param root - bundle root holding the collected web client bundles.
 * @returns the wire graph the renderer boots against.
 * @throws when the root has no collected bundles — collect-bundles.mjs is a
 * fixed build step, so an empty root is a packaging accident that must fail
 * loud instead of booting a plugin-less shell.
 */
export function buildBootManifest(root = defaultBundleRoot): WebBootGraph {
  const discovered = discoverClientBundleDirs(root)
  if (discovered.length === 0) {
    throw new Error(`dsh-desktop: no collected client bundles under ${root} — run collect-bundles.mjs (part of the app build)`)
  }
  const roster = readRoster(root)
  const entries: WebBootEntry[] = []
  for (const { name } of discovered) {
    const row = roster.get(name)
    if (row === undefined) {
      throw new Error(`dsh-desktop: collected bundle "${name}" missing from roster.json under ${root}`)
    }
    // Same optional-field shape the webserver graph carries (graphRow):
    // inject when the declaration has edges, immediately only when true.
    entries.push({
      id: name,
      url: `/plugins/${name}/client.js?rev=${row.rev}`,
      rev: row.rev,
      ...(row.inject !== undefined ? { inject: row.inject } : {}),
      ...(row.immediately === true ? { immediately: true } : {}),
    })
  }
  return { rev: shortHash(JSON.stringify(entries)), entries }
}

/**
 * Resolve one web client plugin id to its collected bundle path — the inverse
 * of the manifest url's pathname (`/plugins/<id>/client.js`). The
 * dsh:load-bundle handler maps bundle urls through this same scan so the
 * roster and the resolver can never disagree.
 * @param packageName - web client plugin package name.
 * @param root - bundle root holding the collected web client bundles.
 * @returns the absolute path of the package's collected client.js.
 * @throws when the id is not a discovered web client bundle package.
 */
export function clientBundlePathOf(packageName: string, root = defaultBundleRoot): string {
  const candidate = join(root, packageName, 'client.js')
  // A scoped name nests under its scope (@deepseek-ai/<name>/client.js); the
  // manifest's buildBootManifest discovery is the authoritative roster, so a
  // path outside the scan cannot resolve even if it exists on disk.
  const discovered = discoverClientBundleDirs(root).some(entry => entry.name === packageName)
  if (!discovered) {
    throw new Error(`dsh-desktop: no collected web client bundle "${packageName}" under ${root}`)
  }
  return candidate
}
