import { constants } from 'fs'
import { access, mkdir, readFile, writeFile } from 'fs/promises'
import { randomBytes } from 'crypto'
import { dirname, join, resolve } from 'path'
import { normalizeAirplayConfig, type AirplayConfig } from '../shared/airplay'

export function airplayDisplayName(deviceName: string): string {
  const clean = [...deviceName]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c !== '\x7f')
    .join('')
    .trim()
  let name = 'iscrcpy for '
  for (const character of clean || 'iPhone') {
    if (Buffer.byteLength(name + character) > 63) break
    name += character
  }
  return name
}

export interface AirplayPorts {
  videoPort: number
  audioPort?: number
  deviceId: string
  keyfile: string
}

export function buildAirplayArguments(
  serviceName: string,
  value: AirplayConfig,
  ports: AirplayPorts
): string[] {
  const config = normalizeAirplayConfig(value)
  const args = [
    '--name',
    serviceName,
    '--host',
    '127.0.0.1',
    '--video-port',
    String(ports.videoPort),
    '--fps',
    String(config.maxFps),
    '--device-id',
    ports.deviceId,
    '--keyfile',
    ports.keyfile
  ]
  if (config.audioEnabled && ports.audioPort) args.push('--audio-port', String(ports.audioPort))
  else args.push('--no-audio')
  // H.264 only: the desktop's WebCodecs path does not support HEVC/PT 98.
  return args
}

export function runtimeCandidates(options: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
  arch?: string
  override?: string
}): string[] {
  const { appPath, resourcesPath, packaged, override } = options
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const binary = platform === 'win32' ? 'uxplay-mini.exe' : 'uxplay-mini'
  if (packaged) return [join(resourcesPath, 'uxplay-mini', binary)]
  if (override) return [resolve(override)]
  const resourcePlatform = { darwin: 'mac', win32: 'win' }[platform] ?? platform
  return [join(appPath, 'resources', 'uxplay-mini', `${resourcePlatform}-${arch}`, binary)]
}

export async function findRuntime(
  options: Parameters<typeof runtimeCandidates>[0]
): Promise<string> {
  for (const binary of runtimeCandidates(options)) {
    try {
      await access(binary, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
      return binary
    } catch {
      /* Try the next independent runtime location. */
    }
  }
  throw new Error(
    'uxplay-mini is missing. Run pnpm run runtime:prepare to download a Release, ' +
      'or set UXPLAY_MINI_BINARY for local development.'
  )
}

export async function receiverIdentity(
  userData: string
): Promise<{ deviceId: string; keyfile: string }> {
  const directory = join(userData, 'airplay')
  const file = join(directory, 'device-id')
  await mkdir(directory, { recursive: true })
  let deviceId: string
  try {
    deviceId = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const bytes = randomBytes(6)
    bytes[0] = (bytes[0] | 2) & 0xfe // locally administered unicast address
    deviceId = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':')
    try {
      await writeFile(file, deviceId + '\n', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      deviceId = (await readFile(file, 'utf8')).trim()
    }
  }
  if (!/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(deviceId))
    throw new Error('Invalid saved AirPlay device ID')
  return { deviceId, keyfile: join(dirname(file), 'pairing.key') }
}
