/**
 * Desktop boot manifest: the client roster the renderer boots against — the
 * same wire graph the webserver injects as window.__DSH_BOOT__ (WebBootGraph),
 * built from the built workspace plugin packages (no HTTP involved). Rows are
 * limited to id/url/rev like the brief's scan: no inject edges (informational
 * in the web graph) and no immediately prefetch marks (the desktop boots
 * bundle loads through entry creation instead of a stage-one tier).
 */
import { readFileSync, globSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** package.json `dsh.client` declaration fields the scan reads. */
interface DshClientDeclaration {
  platform?: unknown
}

/** Narrow an unknown parsed JSON value to the scan-relevant declaration. */
function parseDshClient(value: unknown): DshClientDeclaration {
  if (typeof value !== 'object' || value === null) return {}
  return value as DshClientDeclaration
}

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev), same shortening the webserver graph uses. */
function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/**
 * Scan built client plugin packages (dsh.client.platform === 'web'), the same
 * discovery dev-web uses.
 * @param root - repository root containing the grouped package directories.
 * @returns discovered plugin package names and their workspace-relative directories.
 */
export function discoverClientPluginDirs(root = workspaceRoot): Array<{ name: string; dir: string }> {
  const dirs: Array<{ name: string; dir: string }> = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      name?: string
      dsh?: { client?: unknown }
    }
    if (parseDshClient(manifest.dsh?.client).platform === 'web' && manifest.name !== undefined) {
      dirs.push({ name: manifest.name, dir: dirname(manifestPath) })
    }
  }
  return dirs
}

/**
 * Discovered plugin package names (the loader-entry-style roster view).
 * @param root - repository root containing the grouped package directories.
 * @returns web client plugin package names.
 */
export function discoverClientPlugins(root = workspaceRoot): string[] {
  return discoverClientPluginDirs(root).map(entry => entry.name)
}

/**
 * Build the desktop boot graph: one wire entry per built client bundle, urls
 * shaped `/plugins/<id>/client.js?rev=<rev>` exactly like the webserver graph.
 * @param root - repository root containing the grouped package directories.
 * @returns the wire graph the renderer boots against.
 */
export function buildBootManifest(root = workspaceRoot): WebBootGraph {
  const entries: WebBootEntry[] = []
  for (const { name, dir } of discoverClientPluginDirs(root)) {
    const bundlePath = join(root, dir, 'lib', 'client.js')
    const rev = shortHash(readFileSync(bundlePath, 'utf8'))
    entries.push({ id: name, url: `/plugins/${name}/client.js?rev=${rev}`, rev })
  }
  return { rev: shortHash(JSON.stringify(entries)), entries }
}

/**
 * Resolve one web client plugin id to its built client bundle path — the
 * inverse of the manifest url's pathname (`/plugins/<id>/client.js`). The
 * dsh:load-bundle handler maps bundle urls through this same scan so the
 * roster and the resolver can never disagree.
 * @param packageName - web client plugin package name.
 * @param root - repository root containing the grouped package directories.
 * @returns the absolute path of the package's built lib/client.js.
 * @throws when the id is not a discovered web client plugin package.
 */
export function clientBundlePathOf(packageName: string, root = workspaceRoot): string {
  const dir = discoverClientPluginDirs(root).find(entry => entry.name === packageName)
  if (dir === undefined) {
    throw new Error(`dsh-desktop: no web client plugin package "${packageName}" under ${root}`)
  }
  return join(root, dir.dir, 'lib', 'client.js')
}
