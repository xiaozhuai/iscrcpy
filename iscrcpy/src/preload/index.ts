import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AirplayConfig, AirplayState, AirplayVideoChunk } from '../shared/airplay'

// Custom APIs for renderer
const api = {
  discoverDevices: (): Promise<DiscoveredDevice[]> => ipcRenderer.invoke('devices:discover'),
  storage: {
    load: (): Promise<{ devices: unknown | null; settings: unknown | null }> =>
      ipcRenderer.invoke('storage:load'),
    saveDevices: (value: unknown): Promise<void> =>
      ipcRenderer.invoke('storage:save-devices', value),
    saveSettings: (value: unknown): Promise<void> =>
      ipcRenderer.invoke('storage:save-settings', value)
  },
  airplay: {
    start: (deviceName: string, config: AirplayConfig): Promise<AirplayState> =>
      ipcRenderer.invoke('airplay:start', deviceName, config),
    stop: (): Promise<void> => ipcRenderer.invoke('airplay:stop'),
    restart: (): Promise<AirplayState> => ipcRenderer.invoke('airplay:restart'),
    onState: (listener: (state: AirplayState) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: AirplayState): void => {
        listener(state)
      }
      ipcRenderer.on('airplay:state', wrapped)
      return () => ipcRenderer.removeListener('airplay:state', wrapped)
    },
    onVideo: (listener: (chunk: AirplayVideoChunk) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, chunk: AirplayVideoChunk): void => {
        listener(chunk)
      }
      ipcRenderer.on('airplay:video', wrapped)
      return () => ipcRenderer.removeListener('airplay:video', wrapped)
    },
    onLog: (listener: (message: string) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string): void => {
        listener(message)
      }
      ipcRenderer.on('airplay:log', wrapped)
      return () => ipcRenderer.removeListener('airplay:log', wrapped)
    },
    reportLog: (message: string): void => ipcRenderer.send('airplay:renderer-log', message)
  }
}

export interface DiscoveredDevice {
  id: string
  name: string
  hostname: string
  addresses: string[]
  port: number
  firmwareVersion?: string
  protocolVersion?: number
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
