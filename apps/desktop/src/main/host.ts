/**
 * Desktop host boot: the harness plugin graph without any HTTP carriage.
 * Reuses dsh-app-boot's loader pipeline; the ApiProxy gateway plugin provides
 * ctx.apiProxy (transport-agnostic). Electron-free so the boot path is
 * testable under plain node. Persistence redirection happens BEFORE this
 * runs: the caller (electron main) sets process.env.DSH_HOME so dshHomePath
 * resolves under Electron's userData (see DSH_HOME_ENV in dsh-home-paths).
 */
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const CONFIG_URL = new URL('../../cordis.yml', import.meta.url)

// The desktop config's base layer (the `include: [@deepseek-ai/dsh-base]`
// rows of the plan) is applied the same way the profile loader applies a
// bundle layer: as boot patches over the desktop's own rows — the Loader's
// entry-list dialect has no include directive. `hmr` is disabled here for
// the same reason the web surface disables it: its module-reload lifecycle
// is untested on long-lived surfaces.
const BASE_PATCH_PATH = fileURLToPath(new URL(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')))
const HOST_PATCHES = [
  ...loadOverlayPatches('dsh-desktop', BASE_PATCH_PATH),
  { id: 'hmr', disabled: true },
]

export interface DesktopHost {
  ctx: unknown
  /** The in-process WHATWG fetch face over ctx.apiProxy. */
  fetch: { fetch: typeof fetch }
  /**
   * Tear down the plugin tree. The electron entry calls this on quit so
   * in-flight projections and session writes flush instead of dying
   * mid-write; idempotent (the cordis root fiber disposal is single-shot).
   */
  dispose(): Promise<void>
}

export async function startDesktopHost(): Promise<DesktopHost> {
  const ctx = await boot('dsh-desktop', fileURLToPath(CONFIG_URL), HOST_PATCHES)
  const apiProxy = (ctx as { apiProxy?: unknown }).apiProxy
  if (apiProxy === undefined) throw new Error('dsh-desktop: ctx.apiProxy missing after boot')
  return {
    ctx,
    fetch: toFetchHandler(apiProxy as never),
    dispose: async () => {
      await (ctx as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose()
    },
  }
}
