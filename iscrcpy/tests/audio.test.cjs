const { test } = require('node:test')
const assert = require('node:assert/strict')
const { AudioPlayout } = require('../src/renderer/src/audioPlayout.ts')

function context() {
  return {
    state: 'running',
    currentTime: 1,
    sampleRate: 48000,
    destination: {},
    outputLatency: 0.01,
    created: [],
    gains: [],
    resume() {
      this.state = 'running'
      return Promise.resolve()
    },
    close() {
      this.state = 'closed'
      return Promise.resolve()
    },
    createBuffer(channels, frames, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames))
      return {
        rate,
        data,
        getChannelData(channel) {
          return data[channel]
        }
      }
    },
    createGain() {
      const node = {
        gain: { value: 1 },
        connect(output) {
          this.output = output
        },
        disconnect() {
          this.disconnected = true
        }
      }
      this.gains.push(node)
      return node
    },
    createBufferSource() {
      const source = {
        connect(output) {
          this.output = output
        },
        disconnect() {
          /* Fake output cleanup. */
        },
        stop() {
          this.stopped = true
        },
        start(when, offset) {
          this.when = when
          this.offset = offset
        }
      }
      this.created.push(source)
      return source
    }
  }
}

function chunk(timestampUs = 1_000_000, streamId = 1) {
  return {
    samples: Float32Array.from([0.5, -0.5, 0.25, -0.25]),
    timestampUs,
    sampleRate: 44100,
    channels: 2,
    streamId
  }
}

test('Web Audio uses stereo 44.1 kHz buffers and short bounded playout delay', () => {
  const ctx = context()
  const audio = new AudioPlayout(
    () => {},
    () => ctx
  )
  audio.push(chunk())
  assert.equal(ctx.created[0].when, 1.08)
  assert.equal(ctx.created[0].buffer.rate, 44100)
  assert.deepEqual([...ctx.created[0].buffer.data[0]], [0.5, 0.25])
  assert.deepEqual([...ctx.created[0].buffer.data[1]], [-0.5, -0.25])
  assert.ok(audio.videoDelayMs(1_000_000) > 80)
  audio.dispose()
  assert.equal(ctx.created[0].stopped, true)
  assert.equal(ctx.state, 'closed')
})

test('new SSRC, seek and a stalled renderer discard old queued sound', () => {
  const ctx = context()
  const audio = new AudioPlayout(
    () => {},
    () => ctx
  )
  audio.push(chunk())
  audio.push(chunk(1_010_000, 2))
  assert.equal(ctx.created[0].stopped, true)
  ctx.currentTime = 4
  audio.push(chunk(1_020_000, 2))
  assert.equal(ctx.created[1].stopped, true)
  assert.equal(ctx.created[2].when, 4.08)
  audio.reset()
  assert.equal(audio.videoDelayMs(1_020_000), null)
})

test('suspended autoplay resumes without accumulating stale PCM', async () => {
  const ctx = context()
  ctx.state = 'suspended'
  const audio = new AudioPlayout(
    () => {},
    () => ctx
  )
  audio.push(chunk())
  assert.equal(ctx.created.length, 0)
  await Promise.resolve()
  audio.push(chunk(2_000_000))
  assert.equal(ctx.created.length, 1)
})

test('invalid audio does not create an output device', () => {
  let created = false
  const audio = new AudioPlayout(
    () => {},
    () => {
      created = true
      return context()
    }
  )
  audio.push({ ...chunk(), sampleRate: 48000 })
  audio.push({ ...chunk(), samples: new Float32Array(3) })
  assert.equal(created, false)
})

test('mute silences playing and queued PCM immediately without stopping the stream or clock', () => {
  const ctx = context()
  const audio = new AudioPlayout(
    () => {},
    () => ctx
  )
  audio.push(chunk())
  const gain = ctx.gains[0]
  const first = ctx.created[0]
  const delay = audio.videoDelayMs(1_000_000)
  assert.equal(gain.output, ctx.destination)
  assert.equal(first.output, gain)
  assert.equal(gain.gain.value, 1)

  audio.setMuted(true)
  assert.equal(gain.gain.value, 0)
  assert.equal(first.stopped, undefined)
  assert.equal(audio.videoDelayMs(1_000_000), delay)
  assert.equal(ctx.state, 'running')

  audio.push(chunk(1_000_000 + 2_000_000 / 44100))
  assert.equal(ctx.created[1].output, gain)
  assert.equal(gain.gain.value, 0)
  const nextWhen = ctx.created[1].when

  audio.setMuted(false)
  assert.equal(gain.gain.value, 1)
  assert.equal(ctx.gains.length, 1)
  assert.equal(ctx.created[1].when, nextWhen)
  assert.equal(ctx.created[1].stopped, undefined)
  assert.equal(audio.videoDelayMs(1_000_000), delay)
  audio.dispose()
  assert.equal(gain.disconnected, true)
})

test('mute before audio arrives and across resets never briefly enables output', () => {
  const ctx = context()
  const audio = new AudioPlayout(
    () => {},
    () => ctx
  )
  audio.setMuted(true)
  assert.equal(ctx.gains.length, 0)
  audio.push(chunk())
  assert.equal(ctx.gains[0].gain.value, 0)
  audio.reset()
  audio.push(chunk(2_000_000, 2))
  assert.equal(ctx.gains.length, 1)
  assert.equal(ctx.gains[0].gain.value, 0)
  audio.setMuted(false)
  assert.equal(ctx.gains[0].gain.value, 1)
  audio.dispose()
})
