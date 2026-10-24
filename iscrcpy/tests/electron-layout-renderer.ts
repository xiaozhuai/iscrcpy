// Mount the real application with isolated devices/media; never contact hardware
// or read/write the developer's saved settings during layout regression tests.
import type { AirplayState, AirplayVideoChunk } from '../src/shared/airplay'

const states = new Set<(state: AirplayState) => void>()
const videos = new Set<(chunk: AirplayVideoChunk) => void>()
const probe = { starts: 0, stops: 0, decoders: 0, width: 120, height: 260 }
const state: AirplayState = {
  phase: 'waiting',
  serviceName: 'Layout Test',
  pid: 123,
  error: null
}
const listen = <T>(
  listeners: Set<(value: T) => void>,
  callback: (value: T) => void
): (() => void) => {
  listeners.add(callback)
  return () => listeners.delete(callback)
}
const noop = (): void => {}
const api: Window['api'] = {
  discoverDevices: async () => [],
  storage: {
    load: async () => ({
      devices: {
        groups: [],
        devices: ['portrait', 'other'].map((id) => ({
          id,
          name: id,
          host: 'layout-test.invalid',
          port: 2786,
          groupId: null,
          airplay: { maxFps: 30, audioEnabled: true }
        }))
      },
      settings: { version: 1, locale: 'zh-CN', autoReconnect: false }
    }),
    saveDevices: async () => {},
    saveSettings: async () => {}
  },
  airplay: {
    start: async () => {
      probe.starts++
      states.forEach((callback) => callback(state))
      return state
    },
    stop: async () => {
      probe.stops++
      states.forEach((callback) => callback({ ...state, phase: 'stopped', pid: null }))
    },
    restart: async () => state,
    onState: (callback) => listen(states, callback),
    onVideo: (callback) => listen(videos, callback),
    onAudio: () => noop,
    onLog: () => noop,
    reportLog: noop
  }
}
Object.defineProperty(window, 'api', { value: api })

class DeviceSocket extends EventTarget {
  static OPEN = 1
  readyState = 0
  constructor() {
    super()
    window.setTimeout(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }, 0)
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as { type: string; seq?: number }
    const reply =
      message.type === 'hello'
        ? { type: 'hello', protocol_version: 1, version: 'test' }
        : message.type === 'ping'
          ? { type: 'pong', seq: message.seq }
          : null
    if (reply) {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) }))
      )
    }
  }
  close(): void {
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
}
Object.defineProperty(window, 'WebSocket', { value: DeviceSocket })

// Layout tests control decoded dimensions, not codec correctness (covered by the
// existing real WebCodecs/RTP smoke test). A canvas is a valid drawImage source.
class LayoutDecoder {
  state = 'unconfigured'
  decodeQueueSize = 0
  constructor(private options: VideoDecoderInit) {
    probe.decoders++
  }
  configure(): void {
    this.state = 'configured'
  }
  decode(chunk: EncodedVideoChunk): void {
    const frame = document.createElement('canvas')
    frame.width = probe.width
    frame.height = probe.height
    Object.assign(frame, {
      displayWidth: probe.width,
      displayHeight: probe.height,
      timestamp: chunk.timestamp,
      close: noop
    })
    this.options.output(frame as unknown as VideoFrame)
  }
  close(): void {
    this.state = 'closed'
  }
}
Object.defineProperty(window, 'VideoDecoder', { value: LayoutDecoder })
Object.assign(window, {
  layoutTest: {
    probe,
    rotate: (width: number, height: number): void => {
      probe.width = width
      probe.height = height
      videos.forEach((callback) =>
        callback({
          streamId: 1,
          timestampUs: 0,
          keyframe: true,
          data: new Uint8Array([0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 1, 0x65, 0x80])
        })
      )
    }
  }
})
void import('../src/renderer/src/main')
