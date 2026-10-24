import type { AirplayAudioChunk } from '../shared/airplay'

export function wav(samples: Float32Array, sampleRate = 44100, channels = 2): Buffer {
  const result = Buffer.alloc(44 + samples.length * 2)
  result.write('RIFF', 0)
  result.writeUInt32LE(result.length - 8, 4)
  result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16)
  result.writeUInt16LE(1, 20)
  result.writeUInt16LE(channels, 22)
  result.writeUInt32LE(sampleRate, 24)
  result.writeUInt32LE(sampleRate * channels * 2, 28)
  result.writeUInt16LE(channels * 2, 32)
  result.writeUInt16LE(16, 34)
  result.write('data', 36)
  result.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0
    result.writeInt16LE(
      Math.round(Math.max(-1, Math.min(32767 / 32768, value)) * 32768),
      44 + i * 2
    )
  }
  return result
}

// No rolling recording: retain PCM only while a user-enabled MCP call requests it.
export class AudioCapture {
  private recording: { push(chunk: AirplayAudioChunk): void; cancel(): void } | null = null
  push(chunk: AirplayAudioChunk): void {
    this.recording?.push(chunk)
  }
  reset(): void {
    this.recording?.cancel()
  }
  record(durationMs: number, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted()
    if (this.recording) return Promise.reject(new Error('An audio capture is already active'))
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 10000)
      return Promise.reject(new Error('Audio duration must be 100..10000 ms'))
    return new Promise((resolve, reject) => {
      const maximum = Math.round((44100 * durationMs) / 1000) * 2
      const samples = new Float32Array(maximum)
      let used = 0,
        stream: number | null = null
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        this.recording = null
        if (error) reject(error)
        else if (!used)
          reject(
            new Error(
              'No iPhone audio received. Enable audio, reconnect AirPlay, and play content on the phone.'
            )
          )
        else resolve(wav(samples.subarray(0, used)))
      }
      const cancel = (): void =>
        finish(new Error('Audio capture cancelled: stream stopped or request aborted'))
      const timer = setTimeout(() => finish(), durationMs + 1500)
      this.recording = {
        cancel,
        push(chunk) {
          if (stream !== null && stream !== chunk.streamId) {
            cancel()
            return
          }
          stream = chunk.streamId
          const count = Math.min(maximum - used, chunk.samples.length)
          samples.set(chunk.samples.subarray(0, count), used)
          used += count
          if (used === maximum) finish()
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
    })
  }
}
