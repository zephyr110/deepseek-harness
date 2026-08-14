import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

export async function createMainWindow(): Promise<BrowserWindow> {
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

// Placeholder: Task 4 replaces this with the real whenReady boot (host start +
// ipc bridge registration + smoke-test fast path).
void app.whenReady().then(() => createMainWindow())
