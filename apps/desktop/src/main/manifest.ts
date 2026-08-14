/**
 * Desktop boot manifest: the client roster the renderer boots against — the
 * same wire graph the webserver injects as window.__DSH_BOOT__ (WebBootGraph),
 * built from the collected web client bundles (no HTTP involved). Rows are
 * limited to id/url/rev like the brief's scan: no inject edges (informational
 * in the web graph) and no immediately prefetch marks (the desktop boots
 * bundle loads through entry creation instead of a stage-one tier).
 *
 * The scan targets a bundle root, not the workspace: collect-bundles.mjs
 * freezes one <package>/client.js per web client plugin under
 * apps/desktop/dist/bundles, which is what electron-builder packs into the
 * asar — inside the archive no URL can normalize back to the repository root,
 * so scanning the workspace package tree there would come back empty. Callers pass an
 * explicit root (the main entry injects app.getAppPath()/dist/bundles when
 * packaged, apps/desktop/dist/bundles in dev); the default serves tests and
 * direct callers.
 */
import { readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

const defaultBundleRoot = fileURLToPath(new URL('../../dist/bundles', import.meta.url))

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev), same shortening the webserver graph uses. */
function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Read one collected bundle, failing loud with the path that was missing. */
function readBundle(bundlePath: string): string {
  try {
    return readFileSync(bundlePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`dsh-desktop: cannot read collected client bundle ${bundlePath}: ${detail}`, { cause: error })
  }
}

/**
 * Scan the collected web client bundle directories under a bundle root.
 * @param root - bundle root holding one <package>/client.js per collected
 * bundle (collect-bundles.mjs output), scoped names nested under their scope.
 * @returns discovered bundle package names.
 */
export function discoverClientBundleDirs(root = defaultBundleRoot): Array<{ name: string }> {
  const dirs: Array<{ name: string }> = []
  for (const relPath of globSync(['*/*/client.js', '*/client.js'], { cwd: root }).sort()) {
    // dirs use forward slashes even on win32, so the suffix strip is safe.
    dirs.push({ name: relPath.slice(0, -'/client.js'.length) })
  }
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
 * graph.
 * @param root - bundle root holding the collected web client bundles.
 * @returns the wire graph the renderer boots against.
 */
export function buildBootManifest(root = defaultBundleRoot): WebBootGraph {
  const entries: WebBootEntry[] = []
  for (const { name } of discoverClientBundleDirs(root)) {
    const rev = shortHash(readBundle(join(root, name, 'client.js')))
    entries.push({ id: name, url: `/plugins/${name}/client.js?rev=${rev}`, rev })
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
  const discovered = discoverClientBundleDirs(root).some(entry => entry.name === packageName)
  if (!discovered) {
    throw new Error(`dsh-desktop: no collected web client bundle "${packageName}" under ${root}`)
  }
  return join(root, packageName, 'client.js')
}
