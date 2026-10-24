import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { McpState, McpRequest, McpReply, McpConfiguration } from '../shared/mcp'
import type {
  AirplayAudioChunk,
  AirplayConfig,
  AirplayState,
  AirplayVideoChunk
} from '../shared/airplay'

// Custom APIs for renderer
const api = {
  mcp: {
    getState: (): Promise<McpState> => ipcRenderer.invoke('mcp:state'),
    setPaused: (paused: boolean): Promise<McpState> => ipcRenderer.invoke('mcp:set-paused', paused),
    pauseForTakeover: (): Promise<McpState> => ipcRenderer.invoke('mcp:manual-takeover'),
    configure: (value: McpConfiguration): Promise<McpState> =>
      ipcRenderer.invoke('mcp:configure', value),
    ready: (): void => ipcRenderer.send('mcp:ready'),
    reply: (value: McpReply): void => ipcRenderer.send('mcp:reply', value),
    onState: (listener: (state: McpState) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: McpState): void => listener(state)
      ipcRenderer.on('mcp:state', wrapped)
      return () => ipcRenderer.removeListener('mcp:state', wrapped)
    },
    onRequest: (listener: (request: McpRequest) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, request: McpRequest): void =>
        listener(request)
      ipcRenderer.on('mcp:request', wrapped)
      return () => ipcRenderer.removeListener('mcp:request', wrapped)
    },
    onCancel: (listener: (id: string) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, id: string): void => listener(id)
      ipcRenderer.on('mcp:cancel', wrapped)
      return () => ipcRenderer.removeListener('mcp:cancel', wrapped)
    }
  },
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
    restart: (config?: AirplayConfig): Promise<AirplayState> =>
      ipcRenderer.invoke('airplay:restart', config),
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
    onAudio: (listener: (chunk: AirplayAudioChunk) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, chunk: AirplayAudioChunk): void =>
        listener(chunk)
      ipcRenderer.on('airplay:audio', wrapped)
      return () => ipcRenderer.removeListener('airplay:audio', wrapped)
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
