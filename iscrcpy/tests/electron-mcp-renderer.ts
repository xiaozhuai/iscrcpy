// Only the board and decoder are simulated; application, preload, MCP bridge,
// AirPlay process, RTP receiver and audio capture are the production code.
const messages: Record<string, unknown>[] = []
const testState = { messages, width: 400, height: 800, lockRequests: 0, failLock: false }
Object.assign(window, { mcpTest: testState })
// Only simulate Chromium's pointer-lock boundary, never capture the real mouse
// from this hidden fixture. The real PreviewSurface/dialog/pause IPC still run.
Object.defineProperty(document, 'pointerLockElement', {
  get: () => document.querySelector('[data-test-pointer-locked]')
})
Object.defineProperty(HTMLElement.prototype, 'requestPointerLock', {
  value: function (this: HTMLElement): Promise<void> {
    testState.lockRequests++
    if (testState.failLock)
      return Promise.reject(new DOMException('Simulated pointer lock cooldown', 'SecurityError'))
    this.setAttribute('data-test-pointer-locked', '')
    queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')))
    return Promise.resolve()
  }
})
Object.defineProperty(document, 'exitPointerLock', {
  value: () => {
    document
      .querySelector('[data-test-pointer-locked]')
      ?.removeAttribute('data-test-pointer-locked')
    document.dispatchEvent(new Event('pointerlockchange'))
  }
})
class Board extends EventTarget {
  static OPEN = 1
  readyState = 0
  constructor() {
    super()
    setTimeout(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }, 0)
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>
    messages.push(message)
    const reply = (value: unknown): void => {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
      )
    }
    if (message.type === 'hello') {
      reply({ type: 'hello', protocol_version: 1, version: 'mcp-test' })
      reply({ type: 'status', usb_connected: true, ble_connected: false })
    } else if (message.type === 'ping') reply({ type: 'pong', seq: message.seq })
  }
  close(): void {
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
}
Object.defineProperty(window, 'WebSocket', { value: Board })
class Decoder {
  state = 'unconfigured'
  decodeQueueSize = 0
  constructor(private options: VideoDecoderInit) {}
  configure(): void {
    this.state = 'configured'
  }
  decode(chunk: EncodedVideoChunk): void {
    const probe = (window as unknown as { mcpTest: { width: number; height: number } }).mcpTest
    const frame = document.createElement('canvas')
    frame.width = probe.width
    frame.height = probe.height
    const context = frame.getContext('2d')!
    context.fillStyle = 'red'
    context.fillRect(0, 0, frame.width, frame.height)
    Object.assign(frame, {
      displayWidth: frame.width,
      displayHeight: frame.height,
      timestamp: chunk.timestamp,
      close: () => {}
    })
    this.options.output(frame as unknown as VideoFrame)
  }
  close(): void {
    this.state = 'closed'
  }
}
Object.defineProperty(window, 'VideoDecoder', { value: Decoder })
void import('../src/renderer/src/main')
