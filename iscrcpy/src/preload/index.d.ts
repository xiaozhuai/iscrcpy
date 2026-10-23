import { ElectronAPI } from '@electron-toolkit/preload'
import type { AirplayConfig, AirplayState, AirplayVideoChunk } from '../shared/airplay'
import type { DiscoveredDevice } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      discoverDevices: () => Promise<DiscoveredDevice[]>
      storage: {
        load: () => Promise<{ devices: unknown | null; settings: unknown | null }>
        saveDevices: (value: unknown) => Promise<void>
        saveSettings: (value: unknown) => Promise<void>
      }
      airplay: {
        start: (deviceName: string, config: AirplayConfig) => Promise<AirplayState>
        stop: () => Promise<void>
        restart: () => Promise<AirplayState>
        onState: (listener: (state: AirplayState) => void) => () => void
        onVideo: (listener: (chunk: AirplayVideoChunk) => void) => () => void
        onLog: (listener: (message: string) => void) => () => void
        reportLog: (message: string) => void
      }
    }
  }
}
