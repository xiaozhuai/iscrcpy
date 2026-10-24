// Real Electron/preload/hook/WebCodecs/Web Audio + real supervised mini process.
// Synthetic media is sent through the exact loopback sockets used in production.
require('./register-ts.cjs')
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createSocket } = require('node:dgram')
const { writeFile, rm } = require('node:fs/promises')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { AirplayService } = require('../src/main/airplay.ts')
// The default Electron launcher otherwise quits as soon as our hidden window is
// destroyed, before async cleanup can report a failed assertion.
app.on('window-all-closed', () => {})
let finished = false
app.on('before-quit', (event) => {
  if (!finished) event.preventDefault()
})
const watchdog = setTimeout(() => {
  console.error('Electron smoke test exceeded 30 seconds')
  app.exit(1)
}, 30000)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, description, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(25)
  }
  throw new Error('Timed out: ' + description)
}

function rtp(pt, seq, ts, ssrc, payload, marker = true) {
  const packet = Buffer.alloc(12)
  packet[0] = 0x80
  packet[1] = pt | (marker ? 128 : 0)
  packet.writeUInt16BE(seq & 65535, 2)
  packet.writeUInt32BE(ts >>> 0, 4)
  packet.writeUInt32BE(ssrc, 8)
  return Buffer.concat([packet, payload])
}

function report(ssrc, timestamp, unixMs) {
  const packet = Buffer.alloc(28)
  packet[0] = 0x80
  packet[1] = 200
  packet.writeUInt16BE(6, 2)
  packet.writeUInt32BE(ssrc, 4)
  packet.writeUInt32BE(Math.floor(unixMs / 1000) + 2208988800, 8)
  packet.writeUInt32BE(Math.floor(((unixMs % 1000) / 1000) * 0x100000000), 12)
  packet.writeUInt32BE(timestamp, 16)
  return packet
}

async function run() {
  const project = resolve(__dirname, '..')
  const directory = mkdtempSync(join(tmpdir(), 'iscrcpy-electron-'))
  mkdirSync(join(directory, 'user-data'), { recursive: true })
  app.setPath('userData', join(directory, 'user-data'))
  // app.getAppPath() points at tests/ when launched with this entry point.
  const { findRuntime } = require('../src/main/uxplayRuntime.ts')
  process.env.UXPLAY_MINI_BINARY ||= await findRuntime({
    appPath: project,
    resourcesPath: '',
    packaged: false
  })
  const service = new AirplayService()
  let window
  const sender = createSocket('udp4')
  const logs = []
  try {
    const { build } = await import('vite')
    await build({
      configFile: false,
      root: project,
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: {
          entry: join(__dirname, 'electron-renderer.ts'),
          formats: ['es'],
          fileName: () => 'probe.mjs'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><div id="root"></div><script type="module" src="./probe.mjs"></script>'
    )
    await app.whenReady()
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(project, 'out/preload/index.js'),
        sandbox: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
        offscreen: true,
        partition: 'iscrcpy-smoke'
      }
    })
    window.webContents.on('console-message', ({ message }) => {
      if (typeof message === 'string' && /error/i.test(message)) console.log('Renderer:', message)
    })
    ipcMain.on('airplay:renderer-log', (_event, message) => logs.push(message))
    ipcMain.handle('airplay:restart', (_event, config) => service.restart(config))
    // Observe real outbound IPC without replacing it.
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => {
      if (channel === 'airplay:log') logs.push(args[0])
      return send(channel, ...args)
    }
    await window.loadURL(pathToFileURL(join(directory, 'index.html')).href)
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js('!!window.mirrorProbe'), 'renderer hook mounted')
    console.log('SMOKE: renderer hook and real preload mounted')
    // Monitor audio in a real AnalyserNode but mute the final output during tests.
    await js(`(() => {
      const Native = window.AudioContext
      window.audioPeaks = []
      window.playoutGains = []
      window.decodedFrames = 0
      const NativeDecoder = window.VideoDecoder
      window.VideoDecoder = class extends NativeDecoder {
        constructor(options) { super({ ...options, output: frame => {
          window.decodedFrames++; options.output(frame)
        } }) }
      }
      window.AudioContext = class extends Native {
        constructor(options) {
          super(options)
          const analyser = this.createAnalyser()
          const mute = this.createGain(); mute.gain.value = 0
          analyser.connect(mute); mute.connect(this.destination)
          // Observe the actual production output gain, not a bypass around it.
          const factory = this.createGain.bind(this)
          this.createGain = () => {
            const gain = factory()
            const connect = gain.connect.bind(gain)
            gain.connect = (destination, ...args) =>
              connect(destination === this.destination ? analyser : destination, ...args)
            window.playoutGains.push(gain)
            return gain
          }
          const timer = setInterval(() => {
            const data = new Float32Array(analyser.fftSize)
            analyser.getFloatTimeDomainData(data)
            window.audioPeaks.push(Math.max(...data.map(Math.abs)))
            if (this.state === 'closed') clearInterval(timer)
          }, 5)
        }
      }
    })()`)
    const start = await service.start(
      'Automated Test',
      { maxFps: 30, audioEnabled: true },
      window.webContents
    )
    assert.notEqual(start.phase, 'error', start.error)
    await until(() => logs.some((line) => /listening on TCP/.test(line)), 'real mini TCP startup')
    console.log('SMOKE: supervised mini is listening')
    const pid = service.getState().pid
    assert.ok(pid > 0)
    const videoPort = Number(
      logs.find((line) => line.startsWith('Video RTP/RTCP')).match(/:(\d+)/)[1]
    )
    const audioPort = Number(
      logs.find((line) => line.startsWith('Audio L16 RTP/RTCP')).match(/:(\d+)/)[1]
    )
    // A valid H.264 keyframe generated by the same Chromium WebCodecs stack.
    const encoded = Buffer.from(
      await js(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 64, 64)
      let bytes
      const encoder = new VideoEncoder({ output: chunk => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); bytes = Array.from(data)
      }, error: error => { throw error } })
      encoder.configure({ codec: 'avc1.42001f', width: 64, height: 64, bitrate: 100000,
        framerate: 30, avc: { format: 'annexb' } })
      const frame = new VideoFrame(canvas, { timestamp: 0 })
      encoder.encode(frame, { keyFrame: true }); frame.close()
      await encoder.flush(); encoder.close(); return bytes
    })()`)
    )
    console.log('SMOKE: encoded a valid H264 test frame (' + encoded.length + ' bytes)')
    const nals = []
    let begin = -1
    for (let index = 0; index + 3 < encoded.length; index++) {
      let length = 0
      if (encoded[index] === 0 && encoded[index + 1] === 0) {
        if (encoded[index + 2] === 1) length = 3
        else if (encoded[index + 2] === 0 && encoded[index + 3] === 1) length = 4
      }
      if (length) {
        if (begin >= 0) nals.push(encoded.subarray(begin, index))
        begin = index + length
        index += length - 1
      }
    }
    if (begin >= 0) nals.push(encoded.subarray(begin))
    assert.ok(nals.some((nal) => (nal[0] & 31) === 5))
    const base = Date.now()
    sender.send(report(1, 90000, base), videoPort + 1, '127.0.0.1')
    sender.send(report(2, 44100, base), audioPort + 1, '127.0.0.1')
    let sequence = 0
    let videoSequence = 0
    const sendAudio = (tick) => {
      const samples = Buffer.alloc(882 * 4)
      for (let frame = 0; frame < 882; frame++) {
        const value = Math.round(
          16000 * Math.sin(((tick * 882 + frame) * 2 * Math.PI * 440) / 44100)
        )
        samples.writeInt16BE(value, frame * 4)
        samples.writeInt16BE(value, frame * 4 + 2)
      }
      // Split exactly as mini's L16 packetizer does, at stereo sample boundaries.
      for (let frame = 0; frame < 882; frame += 297) {
        sender.send(
          rtp(
            97,
            sequence++,
            44100 + tick * 882 + frame,
            2,
            samples.subarray(frame * 4, Math.min(frame + 297, 882) * 4)
          ),
          audioPort,
          '127.0.0.1'
        )
      }
    }
    for (let tick = 0; tick < 25; tick++) {
      sendAudio(tick)
      if (tick >= 5 && tick % 2 === 1) {
        nals.forEach((nal, index) =>
          sender.send(
            rtp(96, videoSequence++, 90000 + tick * 1800, 1, nal, index === nals.length - 1),
            videoPort,
            '127.0.0.1'
          )
        )
      }
      await sleep(20)
    }
    console.log(
      'SMOKE: media diagnostics:',
      await js(
        '({ peak: Math.max(...window.audioPeaks), decoded: window.decodedFrames, probe: window.mirrorProbe })'
      )
    )
    await until(
      async () => (await js('window.mirrorProbe')).hasVideo,
      'actual H264 decoded to canvas'
    )
    const probe = await js('window.mirrorProbe')
    assert.equal(probe.error, null)
    assert.deepEqual(probe.size, { width: 64, height: 64 })
    assert.ok(
      await js('Math.max(...window.audioPeaks) > 0.1'),
      'PCM reached a real Web Audio output graph'
    )
    const pixel = await js(
      'Array.from(document.getElementById("preview").getContext("2d").getImageData(32,32,1,1).data)'
    )
    assert.ok(pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40)
    // Toggle only the local output while RTP continues. Do not restart mini or the decoder.
    await js('window.setAudioMuted(true)')
    await until(() => js('window.mirrorProbe.muted'), 'local mute applied')
    assert.equal(await js('window.playoutGains[0].gain.value'), 0)
    await js('window.audioPeaks = []')
    for (let tick = 25; tick < 37; tick++) {
      sendAudio(tick)
      await sleep(20)
    }
    assert.ok(
      await js(
        'window.audioPeaks.length >= 10 && Math.max(...window.audioPeaks.slice(-10)) < 0.001'
      ),
      'muting silenced already queued and incoming PCM at the real output graph'
    )
    assert.equal(service.getState().pid, pid)
    assert.equal(service.config.audioEnabled, true)
    assert.equal(service.sockets.length, 2)
    assert.equal(await js('window.mirrorProbe.hasVideo'), true)
    await js('window.setAudioMuted(false); window.audioPeaks = []')
    await until(async () => !(await js('window.mirrorProbe.muted')), 'local unmute applied')
    for (let tick = 37; tick < 49; tick++) {
      sendAudio(tick)
      await sleep(20)
    }
    assert.ok(
      await js('Math.max(...window.audioPeaks) > 0.1'),
      'unmute restored current live sound'
    )
    assert.equal(await js('window.playoutGains.length'), 1)
    assert.equal(service.getState().pid, pid)
    // A static image must not restart the receiver or stop an audio-only session.
    await sleep(1700)
    assert.equal(service.getState().pid, pid)
    assert.equal(service.getState().phase, 'streaming')
    await js('window.api.airplay.restart({ maxFps: 60, audioEnabled: false })')
    await until(
      () => service.getState().pid && service.getState().pid !== pid,
      'video-only restart'
    )
    assert.equal(service.sockets.length, 1)
    assert.equal(service.config.maxFps, 60)
    await service.stop()
    assert.equal(service.getState().phase, 'stopped')
    assert.equal(service.sockets.length, 0)
    assert.throws(() => process.kill(pid, 0))
    const binary = process.env.UXPLAY_MINI_BINARY
    process.env.UXPLAY_MINI_BINARY = join(directory, 'missing-mini')
    const missing = await service.start(
      'Automated Test',
      { audioEnabled: true },
      window.webContents
    )
    assert.equal(missing.phase, 'error')
    assert.equal(service.sockets.length, 0)
    process.env.UXPLAY_MINI_BINARY = binary
    await Promise.all([
      service.start('Automated Test', { maxFps: 30, audioEnabled: true }, window.webContents),
      service.stop(),
      service.start('Automated Test', { maxFps: 60, audioEnabled: false }, window.webContents)
    ])
    await until(() => service.getState().pid, 'serialized start/stop/start')
    const finalPid = service.getState().pid
    assert.equal(service.sockets.length, 1)
    process.kill(finalPid, 'SIGTERM')
    await until(() => service.getState().phase === 'error', 'unexpected receiver exit cleanup')
    assert.equal(service.sockets.length, 0)
    assert.equal(service.mediaTimer, null)
    console.log(
      'PASS: real mini lifecycle; Electron IPC; H264 decode/canvas; L16 Web Audio output; live local mute/unmute without receiver restart; idle stability; settings; missing binary; concurrent restart; exit cleanup'
    )
  } catch (error) {
    console.error('FAIL:', error)
    console.error('Recent receiver/renderer logs:', logs.slice(-20))
    throw error
  } finally {
    await service.stop()
    service.dispose()
    sender.close()
    window?.destroy()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

run().then(
  () => {
    finished = true
    clearTimeout(watchdog)
    app.exit(0)
  },
  (error) => {
    finished = true
    clearTimeout(watchdog)
    console.error(error)
    app.exit(1)
  }
)
