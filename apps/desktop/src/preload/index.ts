/**
 * Desktop preload bridge: the contextIsolated window.dsh surface. Each
 * method is one ipcRenderer round trip to the main process — fetch requests
 * over 'dsh:fetch' with the body streamed back over 'dsh:stream' events,
 * bundle reads over 'dsh:load-bundle', and the boot graph over
 * 'dsh:boot-manifest'. Nothing else is exposed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'
import type { IpcStreamEvent } from '../ipc/framing.ts'

export interface DesktopBridge {
  fetchRequest(req: IpcFetchRequest): Promise<IpcFetchResponse>
  onStream(callback: (event: IpcStreamEvent) => void): () => void
  loadBundle(url: string): Promise<string>
  bootManifest(): Promise<unknown>
}

const bridge: DesktopBridge = {
  fetchRequest: req => ipcRenderer.invoke('dsh:fetch', req),
  onStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => {
      callback(JSON.parse(payload) as IpcStreamEvent)
    }
    ipcRenderer.on('dsh:stream', listener)
    return () => ipcRenderer.removeListener('dsh:stream', listener)
  },
  loadBundle: url => ipcRenderer.invoke('dsh:load-bundle', url),
  bootManifest: () => ipcRenderer.invoke('dsh:boot-manifest'),
}

contextBridge.exposeInMainWorld('dsh', bridge)
