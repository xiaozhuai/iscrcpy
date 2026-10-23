export interface H264AccessUnit {
  data: Buffer
  timestampUs: number
  keyframe: boolean
}

const MAX_ACCESS_UNIT_BYTES = 4 * 1024 * 1024
const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1])

function withStartCode(nal: Buffer): Buffer {
  return Buffer.concat([ANNEX_B_START_CODE, nal])
}

function nalType(nal: Buffer): number {
  return nal.length > 0 ? nal[0] & 0x1f : 0
}

export class H264RtpDepacketizer {
  private lastSequence: number | null = null
  private currentTimestamp: number | null = null
  private currentNals: Buffer[] = []
  private currentBytes = 0
  private fragment: Buffer | null = null
  private fragmentType: number | null = null
  private discardUntilMarker = false
  private lastTimestampUs = 0
  private sps: Buffer | null = null
  private pps: Buffer | null = null

  reset(): void {
    this.lastSequence = null
    this.lastTimestampUs = 0
    this.discardUntilMarker = false
    this.clearAccessUnit()
    this.sps = null
    this.pps = null
  }

  push(packet: Buffer): H264AccessUnit[] {
    if (packet.length < 12) return []

    const sequence = packet.readUInt16BE(2)
    if (!this.acceptSequence(sequence)) return []

    const timestamp = packet.readUInt32BE(4)
    const completed: H264AccessUnit[] = []
    if (this.currentTimestamp !== null && timestamp !== this.currentTimestamp) {
      const accessUnit = this.completeAccessUnit()
      if (accessUnit) completed.push(accessUnit)
    }

    const payload = this.payload(packet)
    if (!payload || payload.length === 0) return completed
    if (this.discardUntilMarker) {
      if ((packet[1] & 0x80) !== 0) this.discardUntilMarker = false
      return completed
    }

    if (this.currentTimestamp === null) this.currentTimestamp = timestamp
    this.pushH264Payload(payload)

    if ((packet[1] & 0x80) !== 0) {
      this.clearFragment()
      const accessUnit = this.completeAccessUnit()
      if (accessUnit) completed.push(accessUnit)
    }
    return completed
  }

  flush(): H264AccessUnit | null {
    return this.completeAccessUnit()
  }

  private acceptSequence(sequence: number): boolean {
    if (this.lastSequence === null) {
      this.lastSequence = sequence
      return true
    }

    if (sequence === this.lastSequence) return false
    const forward = (sequence - this.lastSequence) & 0xffff
    if (forward > 0x8000) return false

    this.lastSequence = sequence
    if (forward > 1) {
      this.clearAccessUnit()
      this.discardUntilMarker = true
    }
    return true
  }

  private payload(packet: Buffer): Buffer | null {
    const csrcCount = packet[0] & 0x0f
    let offset = 12 + csrcCount * 4
    if ((packet[0] & 0x10) !== 0) {
      if (packet.length < offset + 4) return null
      const extensionWords = packet.readUInt16BE(offset + 2)
      offset += 4 + extensionWords * 4
    }
    let end = packet.length
    if ((packet[0] & 0x20) !== 0) {
      const padding = packet[end - 1]
      if (padding === 0 || padding > end - offset) return null
      end -= padding
    }
    return end > offset ? packet.subarray(offset, end) : null
  }

  private pushH264Payload(payload: Buffer): void {
    const type = payload[0] & 0x1f
    if (type >= 1 && type <= 23) {
      this.addNal(payload)
      return
    }
    if (type === 24) {
      let offset = 1
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.length) {
          this.discardCurrentAccessUnit()
          return
        }
        this.addNal(payload.subarray(offset, offset + size))
        offset += size
      }
      return
    }
    if (type === 28) {
      if (payload.length < 3) {
        this.discardCurrentAccessUnit()
        return
      }
      const fragmentHeader = payload[1]
      const started = (fragmentHeader & 0x80) !== 0
      const ended = (fragmentHeader & 0x40) !== 0
      const actualType = fragmentHeader & 0x1f
      if (started) {
        this.fragment = Buffer.from([(payload[0] & 0xe0) | actualType, ...payload.subarray(2)])
        this.fragmentType = actualType
      } else {
        if (!this.fragment || this.fragmentType !== actualType) {
          this.discardCurrentAccessUnit()
          return
        }
        this.fragment = Buffer.concat([this.fragment, payload.subarray(2)])
      }
      if (this.fragment.length > MAX_ACCESS_UNIT_BYTES) {
        this.discardCurrentAccessUnit()
        return
      }
      if (ended) {
        this.addNal(this.fragment)
        this.clearFragment()
      }
    }
  }

  private addNal(nal: Buffer): void {
    if (nal.length === 0) return
    const type = nalType(nal)
    if (type === 7) {
      this.sps = Buffer.from(nal)
    } else if (type === 8) {
      this.pps = Buffer.from(nal)
    }
    if (type < 1 || type > 23) return

    this.currentBytes += nal.length + ANNEX_B_START_CODE.length
    if (this.currentBytes > MAX_ACCESS_UNIT_BYTES) {
      this.discardCurrentAccessUnit()
      return
    }
    this.currentNals.push(nal)
  }

  private completeAccessUnit(): H264AccessUnit | null {
    const nals = this.currentNals
    const hasVcl = nals.some((nal) => {
      const type = nalType(nal)
      return type >= 1 && type <= 5
    })
    const keyframe = nals.some((nal) => nalType(nal) === 5)
    const normalized =
      keyframe && hasVcl
        ? [
            ...(this.sps && !nals.some((nal) => nalType(nal) === 7) ? [this.sps] : []),
            ...(this.pps && !nals.some((nal) => nalType(nal) === 8) ? [this.pps] : []),
            ...nals
          ]
        : nals

    this.clearAccessUnit()
    if (!hasVcl || normalized.length === 0) return null

    return {
      data: Buffer.concat(normalized.map(withStartCode)),
      timestampUs: this.nextTimestampUs(),
      keyframe
    }
  }

  private nextTimestampUs(): number {
    const now = Number(process.hrtime.bigint() / 1000n)
    this.lastTimestampUs = Math.max(now, this.lastTimestampUs + 1)
    return this.lastTimestampUs
  }

  private discardCurrentAccessUnit(): void {
    this.clearAccessUnit()
    this.discardUntilMarker = true
  }

  private clearAccessUnit(): void {
    this.currentTimestamp = null
    this.currentNals = []
    this.currentBytes = 0
    this.clearFragment()
  }

  private clearFragment(): void {
    this.fragment = null
    this.fragmentType = null
  }
}
