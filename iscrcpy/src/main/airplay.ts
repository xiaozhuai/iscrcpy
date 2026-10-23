import { app, type WebContents } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { createSocket, type Socket } from 'dgram'
import { constants } from 'fs'
import { access, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import {
  normalizeAirplayConfig,
  type AirplayConfig,
  type AirplayState,
  type AirplayVideoChunk
} from '../shared/airplay'
import { H264RtpDepacketizer, type H264AccessUnit } from './h264Rtp'
import { UXPLAY_PID_MARKER, UXPLAY_SUPERVISOR_SOURCE } from './uxplaySupervisor'

// Temporary development path. This will be replaced by a packaged platform runtime.
const UXPLAY_BINARY = '/Users/xiaozhuai/Downloads/uxplay/sidecar/uxplay'
const RECEIVER_NAME_PREFIX = 'iscrcpy for '
const FRAME_IDLE_TIMEOUT_MS = 1500

const initialState: AirplayState = {
  phase: 'stopped',
  serviceName: null,
  error: null,
  pid: null
}

function displayName(deviceName: string): string {
  const sanitized = [...deviceName]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()
    .slice(0, 96)
  return `${RECEIVER_NAME_PREFIX}${sanitized || 'iPhone'}`
}

export function buildAirplayArguments(
  serviceName: string,
  value: AirplayConfig,
  videoPipeline: string
): string[] {
  const config = normalizeAirplayConfig(value)
  const args = ['-n', serviceName, '-nh', '-nohold', '-fps', String(config.maxFps)]
  if (!config.audioEnabled) args.push('-as', '0')
  args.push('-vrtp', videoPipeline)
  return args
}

async function runtimePaths(): Promise<{
  binary: string
  root: string
  gstreamer: string
}> {
  const root = dirname(dirname(UXPLAY_BINARY))
  const gstreamer = join(root, 'gstreamer')
  await access(UXPLAY_BINARY, constants.X_OK)
  await access(join(gstreamer, 'lib', 'gstreamer-1.0'), constants.R_OK)
  return { binary: UXPLAY_BINARY, root, gstreamer }
}

function childEnvironment(root: string): NodeJS.ProcessEnv {
  const gstreamer = join(root, 'gstreamer')
  const bin = join(gstreamer, 'bin')
  const lib = join(gstreamer, 'lib')
  const plugins = join(lib, 'gstreamer-1.0')
  const scanner = join(gstreamer, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [bin, process.env.PATH].filter(Boolean).join(':'),
    DYLD_LIBRARY_PATH: [lib, bin].join(':'),
    GST_PLUGIN_PATH_1_0: plugins,
    GST_PLUGIN_PATH: plugins,
    GST_PLUGIN_SYSTEM_PATH_1_0: '',
    GST_PLUGIN_SYSTEM_PATH: '',
    GST_PLUGIN_SCANNER_1_0: scanner,
    GST_PLUGIN_SCANNER: scanner,
    GST_REGISTRY_1_0: join(app.getPath('userData'), 'cache', 'uxplay-gst-registry.bin')
  }
  delete env.DYLD_INSERT_LIBRARIES
  return env
}

export class AirplayService {
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private target: WebContents | null = null
  private depacketizer = new H264RtpDepacketizer()
  private state: AirplayState = initialState
  private frameIdleTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private lastOutput = ''
  private generation = 0
  private uxplayPid: number | null = null
  private outputBuffer = ''
  private outputFlushTimer: NodeJS.Timeout | null = null
  private receivedRtp = false
  private receivedVideo = false
  private deviceName = ''
  private config: AirplayConfig | null = null

  getState(): AirplayState {
    return this.state
  }

  reportRendererLog(message: string): void {
    this.emitOutput(`[Renderer] ${message}`)
  }

  async restart(): Promise<AirplayState> {
    const target = this.target
    const config = this.config
    if (!target || target.isDestroyed() || !this.deviceName || !config) return this.state
    this.emitOutput('Restarting AirPlay receiver on request')
    return this.start(this.deviceName, config, target)
  }

  async start(
    deviceName: string,
    config: AirplayConfig,
    target: WebContents
  ): Promise<AirplayState> {
    await this.stop(false)
    this.deviceName = deviceName
    this.config = normalizeAirplayConfig(config)
    const generation = ++this.generation
    this.target = target
    this.lastOutput = ''
    this.clearOutput()
    this.uxplayPid = null
    this.receivedRtp = false
    this.receivedVideo = false
    this.depacketizer.reset()
    this.setState({
      phase: 'starting',
      serviceName: displayName(deviceName),
      error: null,
      pid: null
    })

    if (process.platform !== 'darwin') {
      return this.fail('The temporary UxPlay runtime is only available on macOS')
    }

    let paths: Awaited<ReturnType<typeof runtimePaths>>
    try {
      paths = await runtimePaths()
      await mkdir(dirname(join(app.getPath('userData'), 'cache', 'registry')), {
        recursive: true
      })
    } catch (error) {
      return this.fail(`UxPlay runtime is unavailable: ${String(error)}`)
    }
    if (generation !== this.generation) return this.state

    const socket = await this.bindRtpSocket()
    if (generation !== this.generation) {
      socket?.close()
      return this.state
    }
    if (!socket) return this.fail('Could not bind the local AirPlay RTP receiver')
    this.socket = socket

    const rtpPort = socket.address().port
    this.emitOutput(`RTP receiver listening on 127.0.0.1:${rtpPort}`)
    const pipeline =
      `config-interval=1 pt=96 ! ` + `udpsink host=127.0.0.1 port=${rtpPort} sync=false async=false`
    const args = buildAirplayArguments(this.state.serviceName!, config, pipeline)

    let child: ChildProcess
    try {
      child = spawn(process.execPath, ['-e', UXPLAY_SUPERVISOR_SOURCE, paths.binary, ...args], {
        env: { ...childEnvironment(paths.root), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      this.closeSocket()
      return this.fail(`Could not launch UxPlay: ${String(error)}`)
    }
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.captureOutput(chunk))
    child.stderr?.on('data', (chunk: string) => this.captureOutput(chunk))

    const spawned = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true))
      child.once('error', (error) => {
        this.captureOutput(error.message)
        resolve(false)
      })
    })
    if (!spawned || this.child !== child) {
      this.stopChild(child)
      this.closeSocket()
      return this.fail(`Could not launch UxPlay${this.lastOutput ? `: ${this.lastOutput}` : ''}`)
    }
    if (generation !== this.generation) {
      this.stopChild(child)
      this.closeSocket()
      return this.state
    }
    this.emitOutput(`UxPlay started as "${this.state.serviceName}"`)

    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      const orphanedUxplayPid = this.uxplayPid
      this.uxplayPid = null
      if (orphanedUxplayPid) {
        this.signalProcessTree(orphanedUxplayPid, 'SIGTERM')
        const forceTimer = setTimeout(
          () => this.signalProcessTree(orphanedUxplayPid, 'SIGKILL'),
          800
        )
        forceTimer.unref()
      }
      this.closeSocket()
      const reason = this.lastOutput || `UxPlay exited (${signal ?? code ?? 'unknown'})`
      this.fail(reason)
    })
    child.once('error', (error) => {
      if (this.child !== child) return
      this.captureOutput(error.message)
    })

    this.setState({ phase: 'waiting', error: null })
    return this.state
  }

  async stop(notify = true): Promise<void> {
    this.generation++
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.frameIdleTimer) clearTimeout(this.frameIdleTimer)
    this.frameIdleTimer = null
    this.clearOutput()
    this.depacketizer.reset()
    this.closeSocket()

    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        child.once('exit', finish)
        child.kill('SIGTERM')
        const timer = setTimeout(() => {
          if (settled) return
          this.killUxplay('SIGKILL')
          if (child.exitCode === null) child.kill('SIGKILL')
          finish()
        }, 800)
        timer.unref()
      })
    }

    if (notify && this.target) {
      this.setState({ phase: 'stopped', serviceName: null, error: null, pid: null })
    } else {
      this.state = initialState
    }
  }

  dispose(): void {
    this.generation++
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.frameIdleTimer) clearTimeout(this.frameIdleTimer)
    this.frameIdleTimer = null
    this.clearOutput()
    this.closeSocket()
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill('SIGTERM')
    this.killUxplay('SIGKILL')
  }

  private bindRtpSocket(): Promise<Socket | null> {
    return new Promise((resolve) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: false })
      const fail = (): void => {
        socket.close()
        resolve(null)
      }
      socket.once('error', fail)
      socket.once('listening', () => {
        socket.off('error', fail)
        socket.on('error', (error) => {
          this.fail(`AirPlay RTP receiver failed: ${error.message}`)
        })
        socket.on('message', (message) => this.receiveRtp(message))
        resolve(socket)
      })
      socket.bind({ address: '127.0.0.1', port: 0, exclusive: true })
    })
  }

  private receiveRtp(packet: Buffer): void {
    if (packet.length < 12 || (packet[1] & 0x7f) !== 96) return
    if (!this.receivedRtp) {
      this.receivedRtp = true
      this.emitOutput('First RTP video packet received')
    }
    const accessUnits = this.depacketizer.push(packet)
    if (accessUnits.length === 0) return
    this.noteVideoActivity()
    for (const accessUnit of accessUnits) {
      this.sendVideo(accessUnit)
    }
  }

  private noteVideoActivity(): void {
    if (this.state.phase !== 'streaming') {
      this.setState({ phase: 'streaming', error: null })
    }
    if (this.frameIdleTimer) clearTimeout(this.frameIdleTimer)
    this.frameIdleTimer = setTimeout(() => {
      this.frameIdleTimer = null
      if (this.state.phase === 'streaming') {
        this.depacketizer.reset()
        this.receivedRtp = false
        this.receivedVideo = false
        this.setState({ phase: 'waiting', error: null })
        this.scheduleRestart()
      }
    }, FRAME_IDLE_TIMEOUT_MS)
  }

  private scheduleRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const generation = this.generation
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const target = this.target
      const config = this.config
      if (
        this.generation !== generation ||
        !target ||
        target.isDestroyed() ||
        !this.deviceName ||
        !config
      ) {
        return
      }
      this.emitOutput('AirPlay mirror session ended; restarting UxPlay')
      void this.start(this.deviceName, config, target)
    }, 100)
  }

  private sendVideo(accessUnit: H264AccessUnit): void {
    const target = this.target
    if (!target || target.isDestroyed()) return
    if (!this.receivedVideo) {
      this.receivedVideo = true
      this.emitOutput(`First ${accessUnit.keyframe ? 'key' : 'delta'} video frame depacketized`)
    }
    const chunk: AirplayVideoChunk = {
      data: new Uint8Array(accessUnit.data),
      timestampUs: accessUnit.timestampUs,
      keyframe: accessUnit.keyframe
    }
    target.send('airplay:video', chunk)
  }

  private captureOutput(chunk: string): void {
    const combined = this.outputBuffer + chunk
    const lines = combined.split(/\r?\n/)
    this.outputBuffer = lines.pop() ?? ''
    for (const line of lines) this.emitOutput(line)
    if (this.outputBuffer && !this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null
        const pending = this.outputBuffer
        this.outputBuffer = ''
        this.emitOutput(pending)
      }, 250)
      this.outputFlushTimer.unref()
    }
  }

  private emitOutput(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith(UXPLAY_PID_MARKER)) {
      const pid = Number(trimmed.slice(UXPLAY_PID_MARKER.length))
      if (Number.isInteger(pid) && pid > 0) {
        this.uxplayPid = pid
        this.setState({ phase: this.state.phase, error: this.state.error, pid })
      }
      return
    }
    this.lastOutput = `${this.lastOutput} ${trimmed}`.trim().slice(-800)
    const target = this.target
    if (target && !target.isDestroyed()) target.send('airplay:log', trimmed)
  }

  private clearOutput(): void {
    if (this.outputFlushTimer) clearTimeout(this.outputFlushTimer)
    this.outputFlushTimer = null
    this.outputBuffer = ''
  }

  private fail(message: string): AirplayState {
    if (this.frameIdleTimer) clearTimeout(this.frameIdleTimer)
    this.frameIdleTimer = null
    this.setState({
      phase: 'error',
      serviceName: this.state.serviceName,
      error: message,
      pid: null
    })
    return this.state
  }

  private setState(
    next: Omit<AirplayState, 'serviceName' | 'pid'> & {
      serviceName?: string | null
      pid?: number | null
    }
  ): void {
    this.state = {
      phase: next.phase,
      serviceName: next.serviceName === undefined ? this.state.serviceName : next.serviceName,
      error: next.error,
      pid: next.pid === undefined ? this.state.pid : next.pid
    }
    const target = this.target
    if (target && !target.isDestroyed()) target.send('airplay:state', this.state)
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // The socket may already be closed after an asynchronous bind error.
      }
    }
  }

  private stopChild(child: ChildProcess): void {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        this.killUxplay('SIGKILL')
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 800)
      timer.unref()
    }
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
        // The supervised process has already exited.
      }
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // The supervised process group has already exited.
      }
    }
  }
}
