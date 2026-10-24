import type { AirplayAudioChunk } from '../../shared/airplay'

const BUFFER_SECONDS = 0.08
const MAX_AHEAD_SECONDS = 0.3

// AudioBufferSourceNode performs native 44.1 kHz -> output-device resampling.
// Small scheduled buffers avoid an extra codec, native addon or worklet bundle.
export class AudioPlayout {
  private context: AudioContext | null = null
  private output: GainNode | null = null
  private muted = false
  private sources = new Set<AudioBufferSourceNode>()
  private streamId: number | null = null
  private anchor: { mediaUs: number; contextTime: number } | null = null
  private endTime = 0
  private mediaEndUs = 0
  private resuming = false
  private logged = false

  constructor(
    private readonly report: (message: string) => void,
    private readonly createContext: () => AudioContext = () =>
      new AudioContext({ latencyHint: 'interactive' })
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted
    // Keep queued PCM and the presentation clock running; only silence the output.
    if (this.output) this.output.gain.value = muted ? 0 : 1
  }

  resume(): void {
    const context = this.context
    if (!context || context.state === 'running' || context.state === 'closed' || this.resuming)
      return
    this.resuming = true
    void context
      .resume()
      .catch((error: unknown) => {
        this.report('AudioContext resume failed: ' + String(error))
      })
      .finally(() => {
        this.resuming = false
      })
  }

  push(chunk: AirplayAudioChunk): void {
    if (
      chunk.sampleRate !== 44100 ||
      chunk.channels !== 2 ||
      !Number.isFinite(chunk.timestampUs) ||
      !chunk.samples.length ||
      chunk.samples.length % 2 ||
      chunk.samples.length > 44100
    )
      return
    try {
      this.context ??= this.createContext()
      const context = this.context
      if (context.state !== 'running') {
        // Never accumulate stale sound while autoplay is suspended. The window
        // allows receiver autoplay; a user gesture also retries resume.
        this.resume()
        return
      }
      if (!this.output) {
        this.output = context.createGain()
        this.output.gain.value = this.muted ? 0 : 1
        this.output.connect(context.destination)
      }
      if (this.streamId !== chunk.streamId) {
        this.reset()
        this.streamId = chunk.streamId
      }
      const now = context.currentTime
      const frames = chunk.samples.length / 2
      const duration = frames / chunk.sampleRate
      if (this.anchor && Math.abs(chunk.timestampUs - this.mediaEndUs) > 100_000) this.resetQueue()
      if (!this.anchor)
        this.anchor = { mediaUs: chunk.timestampUs, contextTime: now + BUFFER_SECONDS }
      let when = this.anchor.contextTime + (chunk.timestampUs - this.anchor.mediaUs) / 1_000_000
      if (when < now - 0.04 || when > now + MAX_AHEAD_SECONDS || this.sources.size >= 32) {
        this.resetQueue()
        this.anchor = { mediaUs: chunk.timestampUs, contextTime: now + BUFFER_SECONDS }
        when = this.anchor.contextTime
      }
      // RTP timestamp quantization must not leave sub-sample holes between buffers.
      if (this.endTime && Math.abs(when - this.endTime) < 0.002) when = this.endTime
      const buffer = context.createBuffer(2, frames, chunk.sampleRate)
      for (let channel = 0; channel < 2; channel++) {
        const output = buffer.getChannelData(channel)
        for (let frame = 0; frame < frames; frame++)
          output[frame] = chunk.samples[frame * 2 + channel]
      }
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.output)
      source.onended = () => {
        source.disconnect()
        this.sources.delete(source)
      }
      this.sources.add(source)
      source.start(Math.max(now, when), Math.max(0, now - when))
      this.endTime = when + duration
      this.mediaEndUs = chunk.timestampUs + duration * 1_000_000
      if (!this.logged) {
        this.logged = true
        this.report(
          'Audio playback started: L16 stereo 44100 Hz -> ' +
            context.sampleRate +
            ' Hz output, 80 ms buffer'
        )
      }
    } catch (error) {
      this.reset()
      this.report('Audio playback failed: ' + String(error))
    }
  }

  // VideoDecoder preserves the RTCP-derived media timestamp. Follow the audio
  // device's presentation clock, including its output latency, when audio exists.
  videoDelayMs(timestampUs: number): number | null {
    const context = this.context
    const anchor = this.anchor
    if (
      !context ||
      !anchor ||
      context.state !== 'running' ||
      this.endTime < context.currentTime - 0.1
    )
      return null
    const time = anchor.contextTime + (timestampUs - anchor.mediaUs) / 1_000_000
    const stamp = context.getOutputTimestamp?.()
    const delay =
      stamp &&
      stamp.performanceTime !== undefined &&
      stamp.contextTime !== undefined &&
      stamp.performanceTime > 0
        ? stamp.performanceTime + (time - stamp.contextTime) * 1000 - performance.now()
        : (time - context.currentTime + (context.outputLatency || context.baseLatency || 0)) * 1000
    return delay > 300 || delay < -500 ? null : delay
  }

  reset(): void {
    this.resetQueue()
    this.streamId = null
    this.logged = false
  }

  private resetQueue(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* Already ended. */
      }
      source.disconnect()
    }
    this.sources.clear()
    this.anchor = null
    this.endTime = 0
    this.mediaEndUs = 0
  }

  dispose(): void {
    this.reset()
    this.output?.disconnect()
    this.output = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close()
  }
}
