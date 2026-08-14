/**
 * Desktop preload bridge: the contextIsolated window.dsh surface. Most
 * methods are one ipcRenderer round trip to the main process — fetch requests
 * over 'dsh:fetch' with the body streamed back over 'dsh:stream' events,
 * bundle reads over 'dsh:load-bundle', and the boot graph over
 * 'dsh:boot-manifest'; `booted` is a one-way smoke signal (send, no reply).
 * Nothing else is exposed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcFetchRequest, IpcFetchResponse } from '../ipc/handler.ts'
import { parseIpcStreamEvent, type IpcStreamEvent } from '../ipc/framing.ts'

export interface DesktopBridge {
  fetchRequest(req: IpcFetchRequest): Promise<IpcFetchResponse>
  onStream(callback: (event: IpcStreamEvent) => void): () => void
  loadBundle(url: string): Promise<string>
  bootManifest(): Promise<unknown>
  /**
   * Smoke signal: the renderer reports the booted roster size and whether the
   * shell settled without a failure report, after AppWebEntry.run() returns.
   */
  booted(entries: number, ok: boolean): void
}

const bridge: DesktopBridge = {
  fetchRequest: req => ipcRenderer.invoke('dsh:fetch', req),
  onStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => {
      // The framing validator keeps one malformed payload from breaking the
      // whole shared 'dsh:stream' channel (a raw JSON.parse would throw inside
      // the listener and abort every other listener on the channel).
      try {
        callback(parseIpcStreamEvent(payload))
      } catch {
        // A payload the validator rejects cannot belong to any well-formed
        // stream; dropping it keeps the channel healthy.
      }
    }
    ipcRenderer.on('dsh:stream', listener)
    return () => ipcRenderer.removeListener('dsh:stream', listener)
  },
  loadBundle: url => ipcRenderer.invoke('dsh:load-bundle', url),
  bootManifest: () => ipcRenderer.invoke('dsh:boot-manifest'),
  booted: (entries, ok) => ipcRenderer.send('dsh:booted', entries, ok),
}

contextBridge.exposeInMainWorld('dsh', bridge)
