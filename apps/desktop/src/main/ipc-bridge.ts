/**
 * Electron wiring of the fetch bridge: ipcMain.handle('dsh:fetch') runs the
 * in-process fetch face; body chunks go to the window's webContents over the
 * 'dsh:stream' channel. The ipcMain/webContents seams are injected so tests
 * run without electron.
 */
import { createIpcFetchHandler, type IpcFetchRequest, type IpcFetchResponse, type IpcFetchFn } from '../ipc/handler.ts'
import { serializeIpcStreamEvent } from '../ipc/framing.ts'

export function registerIpcFetchBridge(
  getSender: () => { send(channel: string, payload: unknown): void },
  fetchFn: IpcFetchFn,
  ipcHandle: (channel: string, handler: (event: unknown, request: IpcFetchRequest) => Promise<IpcFetchResponse>) => void,
): () => void {
  const handler = createIpcFetchHandler(fetchFn)
  const handle = async (_event: unknown, request: IpcFetchRequest): Promise<IpcFetchResponse> => {
    const response = await handler.handleRequest(request)
    handler.subscribe(response.streamId, (event) => {
      getSender().send('dsh:stream', serializeIpcStreamEvent(event))
    })
    return response
  }
  ipcHandle('dsh:fetch', handle)
  return () => handler.cleanup()
}
