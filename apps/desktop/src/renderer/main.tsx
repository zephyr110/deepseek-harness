/**
 * Desktop renderer entry: prepare the shell's wire contract, then run the
 * shared AppWebEntry. All composition stays in the host graph — this file
 * only supplies the desktop transport (window.dsh bridge) and bundle loading.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { DesktopBridge } from '../preload/index.ts'
import type { DesktopIpcTransport } from '@deepseek-ai/dsh-client-connection/client'
import { createDesktopTransport } from './transport.ts'

declare global {
  interface Window {
    dsh?: DesktopBridge
    __DSH_BOOT__?: unknown
    __DSH_DESKTOP__?: { transport: DesktopIpcTransport }
  }
}

async function main(): Promise<void> {
  const el = document.getElementById('root')
  if (el === null) throw new Error('desktop renderer: missing #root')
  const bridge = window.dsh
  if (bridge === undefined) throw new Error('desktop renderer: window.dsh bridge missing')

  // The boot graph rides the same wire shape the webserver injects
  // ({ rev, entries }), so AppWebEntry's parseBootManifest accepts it.
  const manifest = await bridge.bootManifest() as WebBootGraph
  window.__DSH_BOOT__ = manifest

  // The connection client plugin reads __DSH_DESKTOP__.transport at
  // materialization and hands it to IpcApiClient — set it before any
  // bundle can materialize.
  window.__DSH_DESKTOP__ = { transport: createDesktopTransport(bridge) }

  const entry = new AppWebEntry(el, {
    loadBundle: async (url) => {
      const source = await bridge.loadBundle(url)
      await evaluateBundle(url, source)
    },
  })
  await entry.run()
  // Smoke signal: sent after the boot chain settled. The second argument
  // carries the shell's own failure report, so a boot that settled on the
  // error page (e.g. an entry failed to activate) reports failure instead of
  // a false OK. The packaged --smoke-test run waits for this signal, so a
  // white or dead renderer (boot never reaching AppWebEntry.run, e.g. missing
  // script assets) times out instead of passing on did-finish-load.
  bridge.booted(manifest.entries.length, entry.getError() === undefined)
}

/**
 * Evaluate a plugin bundle in the page context. Mirrors the default loader's
 * classic-script semantics (packages/client/modules/src/client/system.ts:
 * async external script) with an inline script: the bundle registers its
 * factory with window.__ModuleLoader__.load synchronously during the script's
 * execution, which happens synchronously on append. Completion is therefore
 * the append itself — modern Chromium fires the load event only for fetched
 * scripts, not inline ones, so waiting on it would hang every bundle load.
 * The loader's arrive() step still fails loud when the factory did not
 * register (bundle syntax/runtime failure).
 */
function evaluateBundle(_url: string, source: string): Promise<void> {
  const el = document.createElement('script')
  el.textContent = source
  document.head.append(el)
  return Promise.resolve()
}

void main().catch((error: unknown) => {
  // Boot failures before AppWebEntry.run (missing bridge, manifest/loadBundle
  // rejections) would otherwise be a silent white window; surface them in the
  // root element so the user sees the failure instead of nothing.
  const el = document.getElementById('root')
  if (el !== null) {
    el.textContent = `DeepSeek Harness failed to start: ${error instanceof Error ? error.message : String(error)}`
  } else {
    console.error(error)
  }
})
