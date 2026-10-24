import type { AirplayAudioChunk } from '../shared/airplay'
import { parseRtp, rtpDelta, RtpClock, type RtpPacket } from './rtp'

const RATE = 44100
const REORDER_WAIT_MS = 15
const BATCH_FRAMES = 882 // 20 ms; avoid one IPC message per tiny RTP packet.
const MAX_GAP_FRAMES = 4410 // Conceal up to 100 ms of loss with silence.

export class L16RtpReceiver {
  private ssrc: number | null = null
  private nextSequence: number | null = null
  private nextTimestamp: number | null = null
  private pending = new Map<number, { packet: RtpPacket; arrived: number }>()
  private parts: Float32Array[] = []
  private frames = 0
  private batchTimestamp = 0
  private batchStarted = 0

  constructor(private readonly clock: RtpClock) {}

  reset(): void {
    this.ssrc = null
    this.nextSequence = null
    this.nextTimestamp = null
    this.pending.clear()
    this.parts = []
    this.frames = 0
  }

  push(data: Buffer, now = performance.now()): void {
    const packet = parseRtp(data)
    if (!packet || packet.payloadType !== 97 || packet.payload.length % 4 !== 0) return
    if (packet.ssrc !== this.ssrc) {
      this.reset()
      this.ssrc = packet.ssrc
      this.nextSequence = packet.sequence
    }
    const forward = (packet.sequence - this.nextSequence!) & 0xffff
    if (forward >= 0x8000 || this.pending.has(packet.sequence)) return
    if (this.pending.size >= 64) this.pending.clear()
    this.pending.set(packet.sequence, { packet, arrived: now })
  }

  drain(now = performance.now()): AirplayAudioChunk[] {
    const chunks: AirplayAudioChunk[] = []
    while (this.pending.size) {
      let entry = this.pending.get(this.nextSequence!)
      if (!entry) {
        const entries = [...this.pending.values()]
        const oldest = Math.min(...entries.map((item) => item.arrived))
        if (now - oldest < REORDER_WAIT_MS) break
        entry = entries.reduce((a, b) =>
          ((a.packet.sequence - this.nextSequence!) & 0xffff) <
          ((b.packet.sequence - this.nextSequence!) & 0xffff)
            ? a
            : b
        )
        this.nextSequence = entry.packet.sequence
      }
      const { packet, arrived } = entry
      this.pending.delete(packet.sequence)
      this.nextSequence = (packet.sequence + 1) & 0xffff
      let gap = this.nextTimestamp === null ? 0 : rtpDelta(packet.timestamp, this.nextTimestamp)
      // Timestamp jumps (seek/flush) must not allocate an unbounded silence buffer.
      if (Math.abs(gap) > MAX_GAP_FRAMES) {
        this.parts = []
        this.frames = 0
        this.nextTimestamp = null
        gap = 0
      }
      const packetFrames = packet.payload.length / 4
      const skip = Math.max(0, -gap)
      if (skip >= packetFrames) continue
      if (!this.frames) {
        this.batchTimestamp = this.nextTimestamp ?? packet.timestamp
        this.batchStarted = arrived
      }
      if (gap > 0) {
        this.parts.push(new Float32Array(gap * 2))
        this.frames += gap
      }
      const samples = new Float32Array((packetFrames - skip) * 2)
      for (let index = 0; index < samples.length; index++) {
        samples[index] = packet.payload.readInt16BE(skip * 4 + index * 2) / 32768
      }
      this.parts.push(samples)
      this.frames += samples.length / 2
      this.nextTimestamp = (packet.timestamp + packetFrames) >>> 0
      if (this.frames >= BATCH_FRAMES) chunks.push(this.finish())
    }
    if (this.frames && now - this.batchStarted >= 20) chunks.push(this.finish())
    return chunks
  }

  private finish(): AirplayAudioChunk {
    const samples = new Float32Array(this.frames * 2)
    let offset = 0
    for (const part of this.parts) {
      samples.set(part, offset)
      offset += part.length
    }
    const chunk: AirplayAudioChunk = {
      samples,
      timestampUs: this.clock.timeUs(this.ssrc!, this.batchTimestamp),
      sampleRate: RATE,
      channels: 2,
      streamId: this.ssrc!
    }
    this.parts = []
    this.frames = 0
    return chunk
  }
}
