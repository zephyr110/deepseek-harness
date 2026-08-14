import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import { startDesktopHost } from './host.ts'
import { registerIpcFetchBridge } from './ipc-bridge.ts'
import { buildBootManifest, clientBundlePathOf } from './manifest.ts'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'

// The bundle root the manifest scans: collect-bundles.mjs freezes one
// <package>/client.js per web client plugin under dist/bundles, and
// electron-builder packs that into the asar — the renderer roster and the
// load-bundle resolver must both read this same root. Packaged runs resolve
// from the asar root; dev runs from the app dir (the script runs as part of
// the app build, so dist/bundles exists in both).
const bundleRoot = app.isPackaged
  ? join(app.getAppPath(), 'dist/bundles')
  : fileURLToPath(new URL('../../dist/bundles', import.meta.url))

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  return win
}

/**
 * --smoke-test: boot the host, open a window, then exit 0 when the renderer
 * reports it booted. did-finish-load fires for the HTML document even when the
 * renderer is dead or white, so it is not a boot signal; the preload's
 * 'dsh:booted' fires only after AppWebEntry.run() settles in main.tsx. A dead
 * renderer (e.g. missing bundles) times out after SMOKE_TIMEOUT_MS and exits 1.
 */
const SMOKE = process.argv.includes('--smoke-test')
const SMOKE_TIMEOUT_MS = 30_000

void app.whenReady().then(async () => {
  // Persistence redirection: dshHomePath resolves $DSH_HOME first, so point
  // session storage at Electron's userData before the host boots.
  process.env[DSH_HOME_ENV] = join(app.getPath('userData'), 'dsh')
  const { fetch } = await startDesktopHost()
  registerIpcFetchBridge(
    () => BrowserWindow.getAllWindows()[0]?.webContents ?? { send() {} },
    (url, init) => fetch.fetch(url, init),
    (channel, handler) => {
      ipcMain.handle(channel, (event, request: IpcFetchRequest): Promise<IpcFetchResponse> => handler(event, request))
    },
  )
  // dsh:load-bundle — map '/plugins/<id>/client.js?rev=…' (query ignored,
  // id may carry a scope slash) to the collected bundle under the bundle
  // root. Same prefix/suffix strip the webserver route applies.
  ipcMain.handle('dsh:load-bundle', async (_event, url: string): Promise<string> => {
    const pathname = new URL(url, 'http://dsh.internal').pathname
    const prefix = '/plugins/'
    const suffix = '/client.js'
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
      throw new Error(`dsh-desktop: unsupported bundle url ${url}`)
    }
    const packageName = decodeURIComponent(pathname.slice(prefix.length, -suffix.length))
    return readFile(clientBundlePathOf(packageName, bundleRoot), 'utf8')
  })

  // dsh:boot-manifest — the host graph's client roster, the same wire shape
  // the webserver injects, produced from the collected bundle directories.
  ipcMain.handle('dsh:boot-manifest', async (): Promise<unknown> => buildBootManifest(bundleRoot))

  await createMainWindow()
  if (SMOKE) {
    const timeout = setTimeout(() => {
      console.error('dsh-desktop smoke FAILED: renderer booted signal not received within 30s')
      app.exit(1)
    }, SMOKE_TIMEOUT_MS)
    ipcMain.on('dsh:booted', (_event, entries: number) => {
      clearTimeout(timeout)
      console.log(`dsh-desktop smoke OK (${entries} entries)`)
      void app.quit()
    })
  }
})
