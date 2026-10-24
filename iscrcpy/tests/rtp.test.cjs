const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createSocket } = require('node:dgram')
const { once } = require('node:events')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { parseRtp, RtpClock } = require('../src/main/rtp.ts')
const { L16RtpReceiver } = require('../src/main/l16Rtp.ts')
const { H264RtpDepacketizer } = require('../src/main/h264Rtp.ts')
const { bindRtpSocketPair } = require('../src/main/rtpSockets.ts')
const {
  airplayDisplayName,
  buildAirplayArguments,
  runtimeCandidates,
  receiverIdentity
} = require('../src/main/uxplayRuntime.ts')

function rtp({
  sequence = 0,
  timestamp = 0,
  ssrc = 1,
  pt = 97,
  marker = true,
  payload = Buffer.alloc(4)
} = {}) {
  const header = Buffer.alloc(12)
  header[0] = 0x80
  header[1] = pt | (marker ? 0x80 : 0)
  header.writeUInt16BE(sequence, 2)
  header.writeUInt32BE(timestamp >>> 0, 4)
  header.writeUInt32BE(ssrc, 8)
  return Buffer.concat([header, payload])
}

function pcm(values) {
  const buffer = Buffer.alloc(values.length * 2)
  values.forEach((value, index) => buffer.writeInt16BE(value, index * 2))
  return buffer
}

function sr(ssrc, timestamp, unixSeconds = 1700000000) {
  const packet = Buffer.alloc(28)
  packet[0] = 0x80
  packet[1] = 200
  packet.writeUInt16BE(6, 2)
  packet.writeUInt32BE(ssrc, 4)
  packet.writeUInt32BE(unixSeconds + 2208988800, 8)
  packet.writeUInt32BE(timestamp >>> 0, 16)
  return packet
}

test('RTP rejects bad versions, truncated extensions and padding', () => {
  assert.equal(parseRtp(Buffer.alloc(4)), null)
  const badVersion = rtp()
  badVersion[0] = 0x40
  assert.equal(parseRtp(badVersion), null)
  const extension = rtp()
  extension[0] = 0x90
  extension.writeUInt16BE(32, 14)
  assert.equal(parseRtp(extension), null)
  const padding = rtp()
  padding[0] = 0xa0
  padding[15] = 0
  assert.equal(parseRtp(padding), null)
  const csrc = rtp()
  csrc[0] = 0x8f
  assert.equal(parseRtp(csrc), null)
})

test('RTP honors CSRC, extension and padding', () => {
  const packet = Buffer.concat([
    rtp().subarray(0, 12),
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(4),
    Buffer.from([1, 2, 3, 4, 0, 2])
  ])
  packet[0] = 0xb1
  assert.deepEqual([...parseRtp(packet).payload], [1, 2, 3, 4])
})

test('RTCP shares NTP time between 90 kHz video and 44.1 kHz audio, including wrap', () => {
  const video = new RtpClock(90000)
  const audio = new RtpClock(44100)
  video.report(sr(1, 0xfffffff0))
  audio.report(sr(2, 100))
  assert.equal(video.timeUs(1, (0xfffffff0 + 90000) >>> 0), 1700000001000000)
  assert.equal(audio.timeUs(2, 44200), 1700000001000000)
  assert.equal(video.hasReport(2), false)
  video.report(Buffer.from([0x80, 200, 0xff, 0xff]))
  assert.equal(video.timeUs(1, 0xfffffff0), 1700000000000000)
})

test('L16 converts signed big-endian stereo to normalized Float32 and flushes short tails', () => {
  const receiver = new L16RtpReceiver(new RtpClock(44100))
  receiver.push(rtp({ payload: pcm([-32768, 32767, -1, 0]) }), 0)
  assert.deepEqual(receiver.drain(0), [])
  const [chunk] = receiver.drain(21)
  assert.deepEqual([...chunk.samples], [-1, 32767 / 32768, -1 / 32768, 0])
  assert.equal(chunk.sampleRate, 44100)
  assert.equal(chunk.channels, 2)
})

test('L16 reorders packets, rejects duplicates and handles sequence/timestamp wrap', () => {
  const receiver = new L16RtpReceiver(new RtpClock(44100))
  receiver.push(rtp({ sequence: 65534, timestamp: 0xfffffffe, payload: pcm([1, 2]) }), 0)
  receiver.drain(0)
  receiver.push(rtp({ sequence: 0, timestamp: 0, payload: pcm([5, 6]) }), 1)
  receiver.push(rtp({ sequence: 65535, timestamp: 0xffffffff, payload: pcm([3, 4]) }), 2)
  receiver.push(rtp({ sequence: 65535, timestamp: 0xffffffff, payload: pcm([99, 99]) }), 2)
  const [chunk] = receiver.drain(22)
  assert.deepEqual(
    [...chunk.samples],
    [1, 2, 3, 4, 5, 6].map((v) => v / 32768)
  )
})

test('L16 conceals bounded loss, rejects malformed packets and resets on a new SSRC', () => {
  const receiver = new L16RtpReceiver(new RtpClock(44100))
  receiver.push(rtp({ sequence: 1, payload: pcm([1, 2]) }), 0)
  receiver.drain(0)
  receiver.push(rtp({ sequence: 3, timestamp: 2, payload: pcm([3, 4]) }), 1)
  const [chunk] = receiver.drain(25)
  assert.deepEqual([...chunk.samples], [1 / 32768, 2 / 32768, 0, 0, 3 / 32768, 4 / 32768])
  receiver.push(rtp({ ssrc: 2, sequence: 300, timestamp: 999, payload: pcm([7, 8]) }), 30)
  receiver.push(rtp({ ssrc: 2, sequence: 301, payload: Buffer.alloc(3) }), 31)
  const [next] = receiver.drain(55)
  assert.equal(next.streamId, 2)
  assert.deepEqual([...next.samples], [7 / 32768, 8 / 32768])
})

test('L16 seek does not allocate an enormous silence buffer', () => {
  const receiver = new L16RtpReceiver(new RtpClock(44100))
  receiver.push(rtp(), 0)
  receiver.drain(0)
  receiver.push(rtp({ sequence: 1, timestamp: 100000000 }), 1)
  assert.equal(receiver.drain(30)[0].samples.length, 2)
})

test('H264 reconstructs FU-A and retains media timestamps', () => {
  const dep = new H264RtpDepacketizer()
  assert.deepEqual(
    dep.push(
      rtp({ pt: 96, marker: false, timestamp: 123, payload: Buffer.from([0x7c, 0x85, 1, 2]) })
    ),
    []
  )
  const [unit] = dep.push(
    rtp({ pt: 96, sequence: 1, timestamp: 123, payload: Buffer.from([0x7c, 0x45, 3, 4]) })
  )
  assert.deepEqual([...unit.data], [0, 0, 0, 1, 0x65, 1, 2, 3, 4])
  assert.equal(unit.keyframe, true)
  assert.equal(unit.rtpTimestamp, 123)
})

test('H264 drops broken fragments and accepts a fresh SSRC with a lower sequence', () => {
  const dep = new H264RtpDepacketizer()
  dep.push(rtp({ pt: 96, sequence: 500, marker: false, payload: Buffer.from([0x7c, 0x85, 1]) }))
  assert.deepEqual(
    dep.push(rtp({ pt: 96, sequence: 502, payload: Buffer.from([0x7c, 0x45, 2]) })),
    []
  )
  assert.equal(
    dep.push(rtp({ pt: 96, ssrc: 2, sequence: 1, payload: Buffer.from([0x65, 9]) }))[0].ssrc,
    2
  )
  assert.deepEqual(dep.push(rtp({ pt: 98, ssrc: 2, sequence: 2 })), [])
})

test('mini arguments use modern options, audio switch and never enable HEVC', () => {
  const ports = {
    videoPort: 5000,
    audioPort: 5002,
    deviceId: '02:00:00:00:00:01',
    keyfile: 'pairing.key'
  }
  const audio = buildAirplayArguments('test', { maxFps: 60, audioEnabled: true }, ports)
  assert.ok(audio.includes('--audio-port'))
  assert.equal(audio.includes('--h265'), false)
  assert.equal(audio.includes('-vrtp'), false)
  assert.equal(audio.includes('-nohold'), false)
  assert.equal(audio[audio.indexOf('--fps') + 1], '60')
  assert.ok(buildAirplayArguments('test', { audioEnabled: false }, ports).includes('--no-audio'))
})

test('receiver name fits Bonjour/mini 63 UTF-8 bytes without broken characters', () => {
  const name = airplayDisplayName('\n手机'.repeat(100))
  assert.ok(Buffer.byteLength(name) <= 63)
  assert.equal(name.includes('\n'), false)
  assert.equal(name.includes('\ufffd'), false)
})

test('packaged runtime cannot fall back to a developer path or environment override', () => {
  const paths = runtimeCandidates({
    appPath: '/app',
    resourcesPath: '/resources',
    packaged: true,
    override: '/dev/untrusted',
    platform: 'darwin'
  })
  assert.deepEqual(paths, ['/resources/uxplay-mini/uxplay-mini'])
  const development = runtimeCandidates({
    appPath: '/work/iscrcpy/iscrcpy',
    resourcesPath: '',
    packaged: false,
    platform: 'win32',
    arch: 'x64'
  })
  assert.deepEqual(development, [
    '/work/iscrcpy/iscrcpy/resources/uxplay-mini/win-x64/uxplay-mini.exe'
  ])
})

test('pairing identity persists and different installations get different IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iscrcpy-identity-'))
  try {
    const first = await receiverIdentity(join(directory, 'a'))
    assert.deepEqual(first, await receiverIdentity(join(directory, 'a')))
    assert.notEqual(first.deviceId, (await receiverIdentity(join(directory, 'b'))).deviceId)
    assert.equal(
      (await readFile(join(directory, 'a/airplay/device-id'), 'utf8')).trim(),
      first.deviceId
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('both localhost RTP/RTCP sockets are reserved and receive datagrams', async () => {
  const pair = await bindRtpSocketPair()
  const sender = createSocket('udp4')
  try {
    assert.equal(pair.rtcp.address().port, pair.port + 1)
    assert.equal(pair.rtp.address().address, '127.0.0.1')
    const rtpMessage = once(pair.rtp, 'message')
    const rtcpMessage = once(pair.rtcp, 'message')
    sender.send('rtp', pair.port, '127.0.0.1')
    sender.send('rtcp', pair.port + 1, '127.0.0.1')
    assert.equal((await rtpMessage)[0].toString(), 'rtp')
    assert.equal((await rtcpMessage)[0].toString(), 'rtcp')
  } finally {
    sender.close()
    pair.close()
  }
})

const fixturePlatform =
  { darwin: 'macos', win32: 'windows-static' }[process.platform] || process.platform
const fixture =
  process.env.UXPLAY_MINI_UDP_SENDER ||
  resolve(
    __dirname,
    '../../../uxplay-mini/build/binary',
    process.arch + '-' + fixturePlatform + '-release',
    process.platform === 'win32' ? 'udp_sender.exe' : 'udp_sender'
  )
test(
  'real C++ mini RTP sender: byte-exact H264, L16 and shared RTCP clock',
  { skip: !existsSync(fixture), timeout: 5000 },
  async () => {
    const video = await bindRtpSocketPair()
    const audio = await bindRtpSocketPair()
    const dep = new H264RtpDepacketizer()
    const videoClock = new RtpClock(90000)
    const audioClock = new RtpClock(44100)
    const receiver = new L16RtpReceiver(audioClock)
    const units = []
    video.rtp.on('message', (data) => units.push(...dep.push(data)))
    video.rtcp.on('message', (data) => videoClock.report(data))
    audio.rtp.on('message', (data) => receiver.push(data, 0))
    audio.rtcp.on('message', (data) => audioClock.report(data))
    try {
      const child = spawn(fixture, [String(video.port), String(audio.port)])
      const [code] = await once(child, 'exit')
      assert.equal(code, 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(units.length, 1)
      assert.deepEqual(
        units[0].data,
        Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(2000, 0xab)])
      )
      assert.equal(videoClock.timeUs(units[0].ssrc, units[0].rtpTimestamp), 1700000000000000)
      const chunks = receiver.drain(100)
      const samples = chunks.flatMap((chunk) => [...chunk.samples])
      assert.deepEqual(
        samples,
        Array.from({ length: 2000 }, (_, i) => (i - 1000) / 32768)
      )
      assert.equal(chunks[0].timestampUs, 1700000000000000)
    } finally {
      video.close()
      audio.close()
    }
  }
)
