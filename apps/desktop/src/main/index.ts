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

let mainWindow: BrowserWindow | undefined

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
  mainWindow = win
  // Window lifecycle: macOS keeps the process alive after the last window
  // closes (dock apps re-open via activate); the other platforms exit with
  // the last window, and the host tree is disposed on the way out so in-flight
  // projections flush rather than dying mid-write.
  win.on('closed', () => {
    mainWindow = undefined
  })
  return win
}

/**
 * --smoke-test: boot the host, open a window, then exit 0 when the renderer
 * reports it booted cleanly. did-finish-load fires for the HTML document even
 * when the renderer is dead or white, so it is not a boot signal; the
 * preload's 'dsh:booted' fires only after AppWebEntry.run() settles in
 * main.tsx, carrying the roster size and the shell's own failure report — an
 * empty roster (missing bundles) or a settled error page therefore exits 1
 * instead of a false OK. A dead renderer times out after SMOKE_TIMEOUT_MS.
 */
const SMOKE = process.argv.includes('--smoke-test')
const SMOKE_TIMEOUT_MS = 30_000

/** The host tree, disposed on quit so persistence flushes. */
let disposeHost: (() => Promise<void>) | undefined

void app.whenReady().then(async () => {
  try {
    // Persistence redirection: dshHomePath resolves $DSH_HOME first, so point
    // session storage at Electron's userData before the host boots.
    process.env[DSH_HOME_ENV] = join(app.getPath('userData'), 'dsh')
    const host = await startDesktopHost()
    disposeHost = () => host.dispose()
    registerIpcFetchBridge(
      () => {
        const win = BrowserWindow.getAllWindows()[0]
        const contents = win?.webContents
        // A window being torn down has a destroyed webContents; sending into
        // it would throw inside the stream read loop.
        if (contents === undefined || contents.isDestroyed()) return { send() {} }
        return contents
      },
      (url, init) => host.fetch.fetch(url, init),
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
      ipcMain.on('dsh:booted', (_event, entries: number, ok: boolean) => {
        clearTimeout(timeout)
        if (!ok || entries === 0) {
          console.error(`dsh-desktop smoke FAILED: renderer booted with ${entries} entries and ${ok ? 'no' : 'a'} failure report`)
          app.exit(1)
        } else {
          console.log(`dsh-desktop smoke OK (${entries} entries)`)
          void app.quit()
        }
      })
    }
  } catch (error) {
    // A boot failure must not be an invisible unhandled rejection: surface it
    // in the terminal and exit non-zero (smoke included).
    console.error('dsh-desktop failed to start:', error instanceof Error ? error.stack ?? error.message : error)
    app.exit(1)
  }
})

// macOS: the app stays in the dock after the last window closes; re-open a
// window when the dock icon is clicked. On the other platforms, closing the
// last window quits and disposes the host tree.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void app.quit()
})

app.on('activate', () => {
  if (mainWindow === undefined) {
    void createMainWindow().catch((error: unknown) => {
      console.error('dsh-desktop failed to re-open the window:', error instanceof Error ? error.message : error)
    })
  } else {
    mainWindow.show()
  }
})

// Dispose the host tree before the process exits so in-flight projections and
// session writes flush instead of dying mid-write.
app.on('before-quit', () => {
  void disposeHost?.()
})
