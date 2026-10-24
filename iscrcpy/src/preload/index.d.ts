import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AirplayAudioChunk,
  AirplayConfig,
  AirplayState,
  AirplayVideoChunk
} from '../shared/airplay'
import type { DiscoveredDevice } from './index'
import type { McpState, McpRequest, McpReply, McpConfiguration } from '../shared/mcp'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      mcp: {
        getState: () => Promise<McpState>
        setPaused: (paused: boolean) => Promise<McpState>
        pauseForTakeover: () => Promise<McpState>
        configure: (value: McpConfiguration) => Promise<McpState>
        ready: () => void
        reply: (value: McpReply) => void
        onState: (listener: (state: McpState) => void) => () => void
        onRequest: (listener: (request: McpRequest) => void) => () => void
        onCancel: (listener: (id: string) => void) => () => void
      }
      discoverDevices: () => Promise<DiscoveredDevice[]>
      storage: {
        load: () => Promise<{ devices: unknown | null; settings: unknown | null }>
        saveDevices: (value: unknown) => Promise<void>
        saveSettings: (value: unknown) => Promise<void>
      }
      airplay: {
        start: (deviceName: string, config: AirplayConfig) => Promise<AirplayState>
        stop: () => Promise<void>
        restart: (config?: AirplayConfig) => Promise<AirplayState>
        onState: (listener: (state: AirplayState) => void) => () => void
        onVideo: (listener: (chunk: AirplayVideoChunk) => void) => () => void
        onAudio: (listener: (chunk: AirplayAudioChunk) => void) => () => void
        onLog: (listener: (message: string) => void) => () => void
        reportLog: (message: string) => void
      }
    }
  }
}
