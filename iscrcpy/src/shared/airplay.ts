export type AirplayPhase = 'stopped' | 'starting' | 'waiting' | 'streaming' | 'error'

export interface AirplayConfig {
  maxFps: number
  audioEnabled: boolean
}

export const DEFAULT_AIRPLAY_CONFIG: AirplayConfig = {
  maxFps: 30,
  audioEnabled: false
}

export function normalizeAirplayConfig(value: unknown): AirplayConfig {
  const record =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const maxFps = Number(record.maxFps)
  return {
    maxFps: maxFps === 15 || maxFps === 30 || maxFps === 60 ? maxFps : 30,
    audioEnabled:
      typeof record.audioEnabled === 'boolean'
        ? record.audioEnabled
        : DEFAULT_AIRPLAY_CONFIG.audioEnabled
  }
}

export interface AirplayState {
  phase: AirplayPhase
  serviceName: string | null
  error: string | null
  pid: number | null
}

export interface AirplayVideoChunk {
  data: Uint8Array
  timestampUs: number
  keyframe: boolean
}
