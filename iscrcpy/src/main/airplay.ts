import { app, type WebContents } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import {
  normalizeAirplayConfig,
  type AirplayConfig,
  type AirplayState,
  type AirplayVideoChunk
} from '../shared/airplay'
import { H264RtpDepacketizer, type H264AccessUnit } from './h264Rtp'
import { L16RtpReceiver } from './l16Rtp'
import { RtpClock } from './rtp'
import { bindRtpSocketPair, type RtpSocketPair } from './rtpSockets'
import {
  airplayDisplayName,
  buildAirplayArguments,
  findRuntime,
  receiverIdentity
} from './uxplayRuntime'
import { UXPLAY_PID_MARKER, UXPLAY_SUPERVISOR_SOURCE } from './uxplaySupervisor'

const initialState: AirplayState = { phase: 'stopped', serviceName: null, error: null, pid: null }

export class AirplayService {
  private child: ChildProcess | null = null
  private sockets: RtpSocketPair[] = []
  private target: WebContents | null = null
  private depacketizer = new H264RtpDepacketizer()
  private videoClock = new RtpClock(90000)
  private audioClock = new RtpClock(44100)
  private audio = new L16RtpReceiver(this.audioClock)
  private pendingVideo: { unit: H264AccessUnit; arrived: number }[] = []
  private mediaTimer: NodeJS.Timeout | null = null
  private state: AirplayState = initialState
  private lastOutput = ''
  private generation = 0
  private disposed = false
  private operations: Promise<unknown> = Promise.resolve()
  private uxplayPid: number | null = null
  private outputBuffer = ''
  private outputFlushTimer: NodeJS.Timeout | null = null
  private receivedVideo = false
  private receivedAudio = false
  private deviceName = ''
  private config: AirplayConfig | null = null

  getState(): AirplayState {
    return this.state
  }

  reportRendererLog(message: string): void {
    this.emitOutput('[Renderer] ' + message)
  }

  // UI cleanup/start and the restart button may overlap. Serialize ownership
  // changes so an older async bind cannot close a newer receiver's sockets.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.catch(() => undefined)
    return result
  }

  restart(config?: AirplayConfig): Promise<AirplayState> {
    return this.enqueue(async () => {
      const target = this.target
      if (!target || target.isDestroyed() || !this.deviceName || !this.config) return this.state
      return this.startInternal(this.deviceName, config ?? this.config, target)
    })
  }

  start(deviceName: string, config: AirplayConfig, target: WebContents): Promise<AirplayState> {
    return this.enqueue(() => this.startInternal(deviceName, config, target))
  }

  private async startInternal(
    deviceName: string,
    value: AirplayConfig,
    target: WebContents
  ): Promise<AirplayState> {
    await this.stopInternal(false)
    if (this.disposed || target.isDestroyed()) return this.state
    const generation = ++this.generation
    this.deviceName = deviceName
    const config = normalizeAirplayConfig(value)
    this.config = config
    this.target = target
    this.lastOutput = ''
    this.setState({
      phase: 'starting',
      serviceName: airplayDisplayName(deviceName),
      error: null,
      pid: null
    })

    try {
      const binary = await findRuntime({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
        override: process.env.UXPLAY_MINI_BINARY
      })
      const identity = await receiverIdentity(app.getPath('userData'))
      if (generation !== this.generation) return this.state

      const video = await bindRtpSocketPair()
      if (generation !== this.generation) {
        video.close()
        return this.state
      }
      this.sockets.push(video)
      let audio: RtpSocketPair | undefined
      if (config.audioEnabled) {
        audio = await bindRtpSocketPair()
        if (generation !== this.generation) {
          audio.close()
          return this.state
        }
        this.sockets.push(audio)
        audio.rtp.on('message', (data) => this.audio.push(data))
        audio.rtcp.on('message', (data) => this.audioClock.report(data))
      }
      video.rtp.on('message', (data) => {
        for (const unit of this.depacketizer.push(data)) {
          this.pendingVideo.push({ unit, arrived: performance.now() })
        }
        if (this.pendingVideo.length > 12)
          this.pendingVideo.splice(0, this.pendingVideo.length - 12)
      })
      video.rtcp.on('message', (data) => this.videoClock.report(data))
      for (const pair of this.sockets) {
        for (const socket of [pair.rtp, pair.rtcp]) {
          socket.on('error', (error) => {
            if (generation !== this.generation) return
            this.emitOutput('RTP socket error: ' + error.message)
            void this.enqueue(async () => {
              if (generation !== this.generation) return
              await this.stopInternal(false)
              this.fail('AirPlay RTP receiver failed: ' + error.message)
            })
          })
        }
      }
      this.emitOutput(
        'Video RTP/RTCP listening on 127.0.0.1:' + video.port + '/' + (video.port + 1)
      )
      if (audio)
        this.emitOutput(
          'Audio L16 RTP/RTCP listening on 127.0.0.1:' + audio.port + '/' + (audio.port + 1)
        )
      const args = buildAirplayArguments(this.state.serviceName!, config, {
        videoPort: video.port,
        audioPort: audio?.port,
        ...identity
      })
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      delete env.DYLD_INSERT_LIBRARIES
      const child = spawn(process.execPath, ['-e', UXPLAY_SUPERVISOR_SOURCE, binary, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = child
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const capture = (chunk: string): void => {
        if (generation === this.generation) this.captureOutput(chunk)
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
      child.once('exit', (code, signal) => {
        if (this.child !== child) return
        this.child = null
        this.killUxplay('SIGTERM')
        this.closeSockets()
        this.resetMedia()
        this.fail(this.lastOutput || 'uxplay-mini exited (' + (signal ?? code ?? 'unknown') + ')')
      })
      const spawned = await new Promise<boolean>((resolve) => {
        child.once('spawn', () => resolve(true))
        child.once('error', (error) => {
          capture(error.message)
          resolve(false)
        })
      })
      if (generation !== this.generation || this.child !== child) return this.state
      if (!spawned) {
        await this.stopInternal(false)
        return this.fail('Could not launch uxplay-mini: ' + this.lastOutput)
      }
      child.on('error', (error) => capture(error.message))
      this.mediaTimer = setInterval(() => this.flushMedia(), 10)
      this.emitOutput(
        'uxplay-mini started as "' +
          this.state.serviceName +
          '" (H.264' +
          (audio ? ' + L16 audio' : '') +
          ')'
      )
      this.setState({ phase: 'waiting', error: null })
      return this.state
    } catch (error) {
      const serviceName = this.state.serviceName
      await this.stopInternal(false)
      this.setState({ phase: 'error', serviceName, error: String(error), pid: null })
      return this.state
    }
  }

  stop(notify = true): Promise<void> {
    return this.enqueue(() => this.stopInternal(notify))
  }

  private async stopInternal(notify: boolean): Promise<void> {
    this.generation++
    this.clearOutput()
    this.closeSockets()
    this.resetMedia()
    const child = this.child
    const pid = this.uxplayPid
    this.child = null
    this.uxplayPid = null
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (pid) this.signalProcessTree(pid, 'SIGKILL')
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 1200)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.stdin?.end()
        child.kill('SIGTERM')
      })
    } else if (pid) this.signalProcessTree(pid, 'SIGKILL')
    if (notify) this.setState({ ...initialState })
    else this.state = initialState
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.clearOutput()
    this.closeSockets()
    this.resetMedia()
    const child = this.child
    this.child = null
    child?.stdin?.end()
    if (child && child.exitCode === null) child.kill('SIGTERM')
    this.killUxplay('SIGKILL')
  }

  private flushMedia(): void {
    const target = this.target
    if (!target || target.isDestroyed()) return
    const now = performance.now()
    while (this.pendingVideo.length) {
      const { unit, arrived } = this.pendingVideo[0]
      if (!this.videoClock.hasReport(unit.ssrc) && now - arrived < 20) break
      this.pendingVideo.shift()
      if (!this.receivedVideo) {
        this.receivedVideo = true
        this.emitOutput('First H.264 frame depacketized')
      }
      this.noteMediaActivity()
      const chunk: AirplayVideoChunk = {
        data: new Uint8Array(unit.data),
        keyframe: unit.keyframe,
        streamId: unit.ssrc,
        timestampUs: this.videoClock.timeUs(unit.ssrc, unit.rtpTimestamp)
      }
      target.send('airplay:video', chunk)
    }
    for (const chunk of this.audio.drain(now)) {
      if (!this.receivedAudio) {
        this.receivedAudio = true
        this.emitOutput('First L16 audio samples received (44100 Hz, stereo)')
      }
      this.noteMediaActivity()
      target.send('airplay:audio', chunk)
    }
  }

  private noteMediaActivity(): void {
    if (this.state.phase !== 'streaming') this.setState({ phase: 'streaming', error: null })
    // A static screen or paused audio is not a disconnect. mini handles takeover
    // and announces real mirror teardown; never restart it just for frame idleness.
  }

  private resetMedia(): void {
    this.depacketizer.reset()
    this.audio.reset()
    this.videoClock.reset()
    this.audioClock.reset()
    this.pendingVideo = []
    this.receivedAudio = false
    this.receivedVideo = false
  }

  private captureOutput(chunk: string): void {
    const lines = (this.outputBuffer + chunk).split(/\r?\n/)
    this.outputBuffer = lines.pop() ?? ''
    for (const line of lines) this.emitOutput(line)
    if (this.outputBuffer && !this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null
        const pending = this.outputBuffer
        this.outputBuffer = ''
        this.emitOutput(pending)
      }, 250)
    }
  }

  private emitOutput(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith(UXPLAY_PID_MARKER)) {
      const pid = Number(trimmed.slice(UXPLAY_PID_MARKER.length))
      if (Number.isInteger(pid) && pid > 0) {
        this.uxplayPid = pid
        this.setState({ ...this.state, pid })
      }
      return
    }
    if (trimmed === 'Mirror session ended') {
      this.resetMedia()
      this.setState({ phase: 'waiting', error: null })
    }
    this.lastOutput = (this.lastOutput + ' ' + trimmed).trim().slice(-800)
    if (this.target && !this.target.isDestroyed()) this.target.send('airplay:log', trimmed)
  }

  private clearOutput(): void {
    if (this.outputFlushTimer) clearTimeout(this.outputFlushTimer)
    this.outputFlushTimer = null
    this.outputBuffer = ''
  }

  private fail(message: string): AirplayState {
    this.setState({ phase: 'error', error: message, pid: null })
    return this.state
  }

  private setState(
    next: Omit<AirplayState, 'serviceName' | 'pid'> & {
      serviceName?: string | null
      pid?: number | null
    }
  ): void {
    this.state = { ...this.state, ...next }
    if (this.target && !this.target.isDestroyed()) this.target.send('airplay:state', this.state)
  }

  private closeSockets(): void {
    if (this.mediaTimer) clearInterval(this.mediaTimer)
    this.mediaTimer = null
    for (const pair of this.sockets) pair.close()
    this.sockets = []
  }

  private killUxplay(signal: NodeJS.Signals): void {
    const pid = this.uxplayPid
    this.uxplayPid = null
    if (pid) this.signalProcessTree(pid, signal)
  }

  private signalProcessTree(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      } catch {
        /* Already exited. */
      }
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        /* Already exited. */
      }
    }
  }
}
