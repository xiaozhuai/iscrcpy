import type { AirplayConfig } from '../../shared/airplay'

export type Locale = 'zh-CN' | 'zh-TW' | 'en'
export type Target = 'usb_preferred' | 'usb' | 'ble'
export type AddressMode = 'hostname' | 'ip'

export interface DeviceGroup {
  id: string
  name: string
}

export interface Device {
  id: string
  name: string
  groupId: string | null
  host: string
  port: number
  accessToken: string
  airplay: AirplayConfig
}

export interface LibraryState {
  groups: DeviceGroup[]
  devices: Device[]
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
