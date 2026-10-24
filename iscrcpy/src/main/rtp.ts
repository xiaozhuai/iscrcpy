export interface RtpPacket {
  sequence: number
  timestamp: number
  ssrc: number
  marker: boolean
  payloadType: number
  payload: Buffer
}

export function parseRtp(packet: Buffer): RtpPacket | null {
  if (packet.length < 12 || packet[0] >>> 6 !== 2) return null
  let offset = 12 + (packet[0] & 15) * 4
  if (offset > packet.length) return null
  if (packet[0] & 0x10) {
    if (offset + 4 > packet.length) return null
    offset += 4 + packet.readUInt16BE(offset + 2) * 4
  }
  let end = packet.length
  if (packet[0] & 0x20) {
    const padding = packet[end - 1]
    if (!padding || padding > end - offset) return null
    end -= padding
  }
  if (offset >= end) return null
  return {
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    marker: !!(packet[1] & 0x80),
    payloadType: packet[1] & 0x7f,
    payload: packet.subarray(offset, end)
  }
}

// Signed modular difference handles RTP's 32-bit timestamp wrap.
export function rtpDelta(next: number, previous: number): number {
  return (next - previous) | 0
}

interface ClockAnchor {
  ssrc: number
  timestamp: number
  timeUs: number
  reported: boolean
}

export class RtpClock {
  private anchor: ClockAnchor | null = null

  constructor(private readonly rate: number) {}

  reset(): void {
    this.anchor = null
  }

  hasReport(ssrc: number): boolean {
    return this.anchor?.ssrc === ssrc && this.anchor.reported
  }

  // Accept compound RTCP SR + SDES. Both mini streams use the same NTP clock.
  report(packet: Buffer): void {
    for (let offset = 0; offset + 4 <= packet.length;) {
      if (packet[offset] >>> 6 !== 2) return
      const length = (packet.readUInt16BE(offset + 2) + 1) * 4
      if (offset + length > packet.length) return
      if (packet[offset + 1] === 200 && length >= 28) {
        const seconds = packet.readUInt32BE(offset + 8) - 2208988800
        const fraction = packet.readUInt32BE(offset + 12) / 0x100000000
        this.anchor = {
          ssrc: packet.readUInt32BE(offset + 4),
          timestamp: packet.readUInt32BE(offset + 16),
          timeUs: Math.round((seconds + fraction) * 1_000_000),
          reported: true
        }
      }
      offset += length
    }
  }

  timeUs(ssrc: number, timestamp: number, fallbackUs = Date.now() * 1000): number {
    if (this.anchor?.ssrc !== ssrc) {
      this.anchor = { ssrc, timestamp, timeUs: fallbackUs, reported: false }
    }
    return Math.round(
      this.anchor.timeUs + (rtpDelta(timestamp, this.anchor.timestamp) * 1_000_000) / this.rate
    )
  }
}
