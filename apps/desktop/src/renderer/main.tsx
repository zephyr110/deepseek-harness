/**
 * Desktop renderer entry: prepare the shell's wire contract, then run the
 * shared AppWebEntry. All composition stays in the host graph — this file
 * only supplies the desktop transport (window.dsh bridge) and bundle loading.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
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
  const manifest = await bridge.bootManifest()
  window.__DSH_BOOT__ = manifest

  // The connection client plugin reads __DSH_DESKTOP__.transport at
  // materialization and hands it to IpcApiClient — set it before any
  // bundle can materialize.
  window.__DSH_DESKTOP__ = { transport: createDesktopTransport(bridge) }

  new AppWebEntry(el, {
    loadBundle: async (url) => {
      const source = await bridge.loadBundle(url)
      await evaluateBundle(url, source)
    },
  }).run()
}

/**
 * Evaluate a plugin bundle in the page context. Mirrors the default loader's
 * classic-script semantics (packages/client/modules/src/client/system.ts:
 * async external script) with an inline script — the bundle registers its
 * factory with window.__ModuleLoader__.load when it executes, and the load
 * event fires after the synchronous execution.
 */
function evaluateBundle(url: string, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.async = true
    el.textContent = source
    el.addEventListener('load', () => {
      el.remove()
      resolve()
    }, { once: true })
    el.addEventListener('error', () => {
      el.remove()
      reject(new Error(`desktop renderer: bundle ${url} failed to evaluate`))
    }, { once: true })
    document.head.append(el)
  })
}

void main()
