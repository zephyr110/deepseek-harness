import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import { startDesktopHost } from './host.ts'
import { registerIpcFetchBridge } from './ipc-bridge.ts'
import { buildBootManifest, clientBundlePathOf } from './manifest.ts'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'

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

/** --smoke-test: boot the host, open a window, then exit 0 (CI packaging smoke). */
const SMOKE = process.argv.includes('--smoke-test')

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
  // id may carry a scope slash) to the built bundle under the plugin
  // package's lib/client.js. Same prefix/suffix strip the webserver route
  // applies.
  ipcMain.handle('dsh:load-bundle', async (_event, url: string): Promise<string> => {
    const pathname = new URL(url, 'http://dsh.internal').pathname
    const prefix = '/plugins/'
    const suffix = '/client.js'
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
      throw new Error(`dsh-desktop: unsupported bundle url ${url}`)
    }
    const packageName = decodeURIComponent(pathname.slice(prefix.length, -suffix.length))
    return readFile(clientBundlePathOf(packageName), 'utf8')
  })

  // dsh:boot-manifest — the host graph's client roster, the same wire shape
  // the webserver injects, produced from the built bundle directories.
  ipcMain.handle('dsh:boot-manifest', async (): Promise<unknown> => buildBootManifest())

  const win = await createMainWindow()
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      console.log('dsh-desktop smoke OK')
      void app.quit()
    })
  }
})
