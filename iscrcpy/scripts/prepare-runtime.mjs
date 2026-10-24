import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MAX_DOWNLOAD_BYTES, NOTICE_FILES, unpackRuntime } from './runtime-archive.mjs'

export const REPOSITORY = 'xiaozhuai/uxplay-mini'
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HASH_PATTERN = /^[a-f0-9]{64}$/
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,100}$/
const METADATA_FILE = 'runtime.json'

function hash(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function runtimeTarget(platform, arch) {
  const platforms = {
    darwin: { resource: 'mac', asset: 'macos', architectures: ['x64', 'arm64', 'universal'] },
    win32: { resource: 'win', asset: 'windows', architectures: ['ia32', 'x64', 'arm64'] },
    linux: { resource: 'linux', asset: 'linux', architectures: ['x64', 'arm64', 'armv7l'] },
    freebsd: { resource: 'freebsd', asset: 'freebsd', architectures: ['x64', 'arm64'] }
  }
  const spec = platforms[platform]
  if (!spec || !spec.architectures.includes(arch))
    throw new Error('Unsupported mini target: ' + platform + '/' + arch)
  return {
    platform,
    arch,
    key: spec.resource + '-' + arch,
    asset: spec.asset,
    binary: platform === 'win32' ? 'uxplay-mini.exe' : 'uxplay-mini'
  }
}

function assetName(tag, target) {
  return 'uxplay-mini-' + tag + '-' + target.asset + '-' + target.arch + '.zip'
}

function validTag(tag) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag))
    throw new Error('Invalid uxplay-mini release tag')
  return tag
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function regularFile(file) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
    throw new Error('Invalid cached runtime file')
  return readFile(file)
}

async function verifiedRuntime(directory, target, version, digest) {
  try {
    if (!(await lstat(directory)).isDirectory()) return null
    const meta = JSON.parse((await regularFile(join(directory, METADATA_FILE))).toString('utf8'))
    if (
      meta.schema !== 1 ||
      meta.repository !== REPOSITORY ||
      meta.platform !== target.platform ||
      meta.arch !== target.arch ||
      typeof meta.version !== 'string' ||
      !TAG_PATTERN.test(meta.version) ||
      (version && meta.version !== version) ||
      !HASH_PATTERN.test(meta.archiveSha256) ||
      (digest && meta.archiveSha256 !== digest) ||
      meta.asset !== assetName(meta.version, target)
    )
      return null
    const names = [target.binary, ...NOTICE_FILES]
    if (!meta.files || Object.keys(meta.files).length !== names.length) return null
    for (const name of names) {
      if (
        !HASH_PATTERN.test(meta.files[name]) ||
        hash(await regularFile(join(directory, name))) !== meta.files[name]
      )
        return null
    }
    if (target.platform !== 'win32') await access(join(directory, target.binary), constants.X_OK)
    return meta
  } catch {
    return null
  }
}

// Publish complete directories only. A failed download/unpack never touches the
// previously staged runtime, and a failed rename restores the previous directory.
async function publish(directory, files, metadata, target) {
  await mkdir(dirname(directory), { recursive: true })
  const temporary = await mkdtemp(join(dirname(directory), '.mini-'))
  const next = join(temporary, 'next')
  const previous = join(temporary, 'previous')
  let moved = false
  let preserveBackup = false
  try {
    await mkdir(next)
    for (const [name, data] of files) await writeFile(join(next, name), data)
    if (target.platform !== 'win32') await chmod(join(next, target.binary), 0o755)
    await writeFile(join(next, METADATA_FILE), JSON.stringify(metadata, null, 2) + '\n')
    try {
      await rename(directory, previous)
      moved = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      await rename(next, directory)
    } catch (error) {
      if (moved) {
        try {
          await rename(previous, directory)
        } catch {
          preserveBackup = true
          throw new Error(
            'Could not restore the previous runtime; backup preserved at ' + previous,
            { cause: error }
          )
        }
      }
      throw error
    }
  } finally {
    // Only our uniquely created temporary directory is eligible for removal.
    if (!preserveBackup)
      await rm(temporary, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
  }
}

async function filesFrom(directory, target, metadata) {
  return new Map(
    await Promise.all(
      [target.binary, ...NOTICE_FILES].map(async (name) => {
        const bytes = await regularFile(join(directory, name))
        if (hash(bytes) !== metadata.files[name])
          throw new Error('Cached runtime changed during staging')
        return [name, bytes]
      })
    )
  )
}

async function atomicJson(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = await mkdtemp(join(dirname(file), '.selection-'))
  try {
    const next = join(temporary, 'selected.json')
    await writeFile(next, JSON.stringify(data) + '\n')
    await rename(next, file)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

// fetch/env/project are injectable for offline tests; production always uses the
// fixed public GitHub repository. No token is persisted or copied into the app.
export function createRuntimeManager({
  projectDir = PROJECT,
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = console.log
} = {}) {
  const releases = new Map()
  const checksums = new Map()
  const inflight = new Map()
  const cacheRoot = join(projectDir, '.cache', 'uxplay-mini', hash(REPOSITORY).slice(0, 16))

  async function request(url, limit, api = false) {
    const headers = {
      'User-Agent': 'iscrcpy-runtime',
      Accept: api ? 'application/vnd.github+json' : 'application/octet-stream'
    }
    if (api) {
      headers['X-GitHub-Api-Version'] = '2026-03-10'
      const token = env.GITHUB_TOKEN || env.GH_TOKEN
      if (token) headers.Authorization = 'Bearer ' + token
    }
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 404)
        throw new Error(
          'GitHub repository/release/asset not found: ' +
            REPOSITORY +
            '. Publish its Release first, or set UXPLAY_MINI_BINARY for local development.'
        )
      throw new Error('GitHub runtime request failed (HTTP ' + response.status + ')')
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > limit) {
      await response.body?.cancel()
      throw new Error('GitHub response exceeds size limit')
    }
    if (!response.body) throw new Error('Empty GitHub response')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > limit) throw new Error('GitHub response exceeds size limit')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, size)
  }

  async function release(version) {
    const key = version || 'latest'
    if (!releases.has(key))
      releases.set(
        key,
        (async () => {
          const endpoint = version ? 'tags/' + encodeURIComponent(validTag(version)) : 'latest'
          const data = JSON.parse(
            (
              await request(
                'https://api.github.com/repos/' + REPOSITORY + '/releases/' + endpoint,
                1024 * 1024,
                true
              )
            ).toString('utf8')
          )
          validTag(data.tag_name)
          if (
            data.draft ||
            (!version && data.prerelease) ||
            (version && data.tag_name !== version) ||
            !Array.isArray(data.assets)
          ) {
            throw new Error('GitHub returned an unexpected uxplay-mini release')
          }
          return data
        })()
      )
    return releases.get(key)
  }

  function asset(data, name) {
    const matches = data.assets.filter((item) => item.name === name && item.state === 'uploaded')
    if (matches.length !== 1)
      throw new Error('Release ' + data.tag_name + ' is missing a unique asset: ' + name)
    const item = matches[0]
    const url = new URL(item.browser_download_url)
    const path = '/' + REPOSITORY + '/releases/download/' + data.tag_name + '/' + name
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      decodeURIComponent(url.pathname) !== path ||
      url.search ||
      url.hash
    )
      throw new Error('Unexpected GitHub asset download URL')
    return item
  }

  async function checksum(data, name) {
    const key = JSON.stringify([data.tag_name, name])
    if (!checksums.has(key))
      checksums.set(
        key,
        (async () => {
          const sidecar = name + '.sha256'
          const item = asset(data, sidecar)
          const content = await request(item.browser_download_url, 4096)
          if (item.digest && item.digest !== 'sha256:' + hash(content))
            throw new Error('SHA-256 sidecar asset digest mismatch: ' + sidecar)
          // Accept a bare hash or standard sha256sum/shasum output. With a
          // filename present, it must identify this ZIP exactly, not another target.
          const match = /^([a-fA-F0-9]{64})(?: [ *]([^\r\n]+))?$/.exec(
            content.toString('utf8').trim()
          )
          if (!match || (match[2] !== undefined && match[2] !== name))
            throw new Error(
              'Invalid SHA-256 sidecar for ' +
                name +
                ': expected one hash with an optional matching ZIP filename'
            )
          return match[1].toLowerCase()
        })()
      )
    return checksums.get(key)
  }

  function cachePath(target, version) {
    return join(cacheRoot, target.key, 'versions', hash(validTag(version)).slice(0, 24))
  }

  async function select(target, directory, metadata) {
    await atomicJson(join(cacheRoot, target.key, 'selected.json'), { version: metadata.version })
    log('Prepared uxplay-mini ' + metadata.version + ' (' + target.key + ')')
    return { source: 'github', binary: join(directory, target.binary), version: metadata.version }
  }

  async function prepareOne({
    platform = process.platform,
    arch = process.arch,
    mode = 'development',
    version = env.UXPLAY_MINI_VERSION
  } = {}) {
    if (!['development', 'update', 'package'].includes(mode))
      throw new Error('Invalid runtime preparation mode')
    const target = runtimeTarget(platform, arch)
    version = version || undefined
    if (version) validTag(version)
    if (env.UXPLAY_MINI_BINARY) {
      if (mode === 'package')
        throw new Error(
          'UXPLAY_MINI_BINARY is a development-only override; packaging requires a GitHub Release.'
        )
      if (platform !== process.platform || arch !== process.arch)
        throw new Error('Local runtime override must match the development host')
      const binary = resolve(env.UXPLAY_MINI_BINARY)
      if (!(await lstat(binary)).isFile())
        throw new Error('Local mini override is not a regular file')
      await access(binary, platform === 'win32' ? constants.R_OK : constants.X_OK)
      log('Using local UXPLAY_MINI_BINARY override (no download)')
      return { source: 'local', binary }
    }
    const directory = join(projectDir, 'resources', 'uxplay-mini', target.key)
    if (mode === 'development') {
      const staged = await verifiedRuntime(directory, target, version)
      if (staged) {
        log('Using cached uxplay-mini ' + staged.version + ' (' + target.key + ')')
        return { source: 'github', binary: join(directory, target.binary), version: staged.version }
      }
      let cachedVersion = version
      if (!cachedVersion) {
        try {
          cachedVersion = validTag(
            (await jsonFile(join(cacheRoot, target.key, 'selected.json'))).version
          )
        } catch {
          /* No previous selection. */
        }
      }
      if (cachedVersion) {
        const cached = await verifiedRuntime(
          cachePath(target, cachedVersion),
          target,
          cachedVersion
        )
        if (cached) {
          await publish(
            directory,
            await filesFrom(cachePath(target, cachedVersion), target, cached),
            cached,
            target
          )
          return select(target, directory, cached)
        }
      }
    }
    // Update/package deliberately resolve GitHub even when an old stage exists.
    // A manager is shared across all beforePack targets: latest is resolved once.
    const data = await release(version)
    const name = assetName(data.tag_name, target)
    const item = asset(data, name)
    const digest = await checksum(data, name)
    if (item.digest && item.digest !== 'sha256:' + digest)
      throw new Error('GitHub asset digest and SHA-256 sidecar disagree')
    const cachedDirectory = cachePath(target, data.tag_name)
    let metadata = await verifiedRuntime(cachedDirectory, target, data.tag_name, digest)
    if (!metadata) {
      const archive = await request(item.browser_download_url, MAX_DOWNLOAD_BYTES)
      if (hash(archive) !== digest) throw new Error('SHA-256 mismatch for ' + name)
      const files = await unpackRuntime(archive, target.binary)
      metadata = {
        schema: 1,
        repository: REPOSITORY,
        version: data.tag_name,
        platform,
        arch,
        asset: name,
        archiveSha256: digest,
        files: Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)]))
      }
      await publish(cachedDirectory, files, metadata, target)
    }
    await publish(directory, await filesFrom(cachedDirectory, target, metadata), metadata, target)
    return select(target, directory, metadata)
  }

  return {
    prepare(options = {}) {
      const key = JSON.stringify([
        options.platform || process.platform,
        options.arch || process.arch,
        options.mode || 'development',
        options.version || env.UXPLAY_MINI_VERSION
      ])
      if (!inflight.has(key)) {
        const operation = prepareOne(options).finally(() => inflight.delete(key))
        inflight.set(key, operation)
      }
      return inflight.get(key)
    }
  }
}

export async function prepareRuntime(options) {
  return createRuntimeManager().prepare(options)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        platform: { type: 'string' },
        arch: { type: 'string' },
        version: { type: 'string' },
        update: { type: 'boolean', default: false }
      }
    })
    const { update, ...options } = values
    await prepareRuntime({ ...options, mode: update ? 'update' : 'development' })
  } catch (error) {
    console.error('uxplay-mini preparation failed: ' + error.message)
    process.exitCode = 1
  }
}
