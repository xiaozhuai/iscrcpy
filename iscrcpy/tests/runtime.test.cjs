const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, writeFile, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const JSZip = require('jszip')

const modulePromise = import('../scripts/prepare-runtime.mjs')
const archivePromise = import('../scripts/runtime-archive.mjs')
const REPO = 'xiaozhuai/uxplay-mini'
const API = 'https://api.github.com/repos/' + REPO + '/releases/'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function makeZip(binary = 'uxplay-mini', mutate = () => {}) {
  const zip = new JSZip()
  for (const [name, bytes] of [
    [binary, 'test native executable'],
    ['LICENSE', 'GPL-3.0'],
    ['UPSTREAM.md', 'Protocol attribution'],
    ['playfair-LICENSE.md', 'PlayFair license']
  ])
    zip.file(name, bytes, { createFolders: false, unixPermissions: 0o100755 })
  mutate(zip)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' })
}

async function fixture(t, { latest = 'v0.1.0', targets = [['darwin', 'arm64']], env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'iscrcpy-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { createRuntimeManager, runtimeTarget } = await modulePromise
  const releases = new Map()
  const downloads = new Map()
  const requests = []
  const logs = []
  const fake = {
    directory,
    requests,
    logs,
    downloads,
    releases,
    latest,
    stage: (key = 'mac-arm64') => join(directory, 'resources/uxplay-mini', key),
    async addRelease(tag, releaseTargets = targets, mutateZip) {
      const assets = []
      for (const [platform, arch] of releaseTargets) {
        const target = runtimeTarget(platform, arch)
        const name = 'uxplay-mini-' + tag + '-' + target.asset + '-' + arch + '.zip'
        const bytes = await makeZip(target.binary, mutateZip)
        const url = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + name
        downloads.set(url, bytes)
        assets.push({
          name,
          state: 'uploaded',
          browser_download_url: url,
          digest: 'sha256:' + hash(bytes)
        })
        const checksum = Buffer.from(hash(bytes) + '  ' + name + '\n')
        const checksumUrl = url + '.sha256'
        downloads.set(checksumUrl, checksum)
        assets.push({
          name: name + '.sha256',
          state: 'uploaded',
          browser_download_url: checksumUrl,
          digest: 'sha256:' + hash(checksum)
        })
      }
      const data = { tag_name: tag, draft: false, prerelease: false, assets }
      releases.set(tag, data)
      return data
    },
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.startsWith(API)) {
        const endpoint = url.slice(API.length)
        const data =
          endpoint === 'latest'
            ? releases.get(fake.latest)
            : releases.get(decodeURIComponent(endpoint.slice(5)))
        return new Response(data ? JSON.stringify(data) : 'not found', { status: data ? 200 : 404 })
      }
      const bytes = downloads.get(url)
      return new Response(bytes || 'not found', { status: bytes ? 200 : 404 })
    },
    manager(options = {}) {
      return createRuntimeManager({
        projectDir: directory,
        env,
        fetchImpl: fake.fetch,
        log: (line) => logs.push(line),
        ...options
      })
    }
  }
  await fake.addRelease(latest)
  return fake
}

test('development first run downloads, verifies, stages notices and records the exact release', async (t) => {
  const f = await fixture(t)
  const result = await f.manager().prepare({ platform: 'darwin', arch: 'arm64' })
  assert.equal(result.version, 'v0.1.0')
  assert.equal(f.requests.length, 3)
  assert.ok(f.requests[0].url.endsWith('/latest'))
  const metadata = JSON.parse(await readFile(join(f.stage(), 'runtime.json'), 'utf8'))
  assert.equal(metadata.repository, REPO)
  assert.equal(metadata.asset, 'uxplay-mini-v0.1.0-macos-arm64.zip')
  assert.equal(metadata.platform, 'darwin')
  assert.equal((await stat(result.binary)).mode & 0o111, 0o111)
  for (const name of ['LICENSE', 'UPSTREAM.md', 'playfair-LICENSE.md']) {
    assert.ok((await readFile(join(f.stage(), name))).length > 0)
  }
})

test('development reuses valid stage offline and restores a deleted stage from its versioned cache', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  await f.manager().prepare(target)
  const offline = f.manager({
    fetchImpl: () => {
      throw new Error('Network must not be used')
    }
  })
  assert.equal((await offline.prepare(target)).version, 'v0.1.0')
  await rm(f.stage(), { recursive: true, force: true })
  assert.equal((await offline.prepare(target)).version, 'v0.1.0')
  assert.equal(f.requests.length, 3)
})

test('development repairs a modified binary from the verified cache without networking', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  const { binary } = await f.manager().prepare(target)
  await writeFile(binary, 'modified')
  const offline = f.manager({
    fetchImpl: () => {
      throw new Error('Unexpected networking')
    }
  })
  await offline.prepare(target)
  assert.equal(await readFile(binary, 'utf8'), 'test native executable')
})

test('explicit update checks latest even with a valid old stage', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  await f.manager().prepare(target)
  await f.addRelease('v0.2.0')
  f.latest = 'v0.2.0'
  assert.equal((await f.manager().prepare({ ...target, mode: 'update' })).version, 'v0.2.0')
  assert.equal(f.requests.filter(({ url }) => url.endsWith('/latest')).length, 2)
})

test('packaging always resolves GitHub but reuses the checksummed artifact cache', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64', mode: 'package' }
  await f.manager().prepare(target)
  await f.manager().prepare(target)
  assert.equal(f.requests.filter(({ url }) => url.endsWith('/latest')).length, 2)
  assert.equal(f.requests.filter(({ url }) => url.endsWith('.zip')).length, 1)
})

test('one packaging manager freezes latest across target platforms and architectures', async (t) => {
  const f = await fixture(t, {
    targets: [
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['linux', 'arm64']
    ]
  })
  const manager = f.manager()
  const mac = await manager.prepare({ platform: 'darwin', arch: 'arm64', mode: 'package' })
  await f.addRelease('v0.2.0')
  f.latest = 'v0.2.0'
  const win = await manager.prepare({ platform: 'win32', arch: 'x64', mode: 'package' })
  const linux = await manager.prepare({ platform: 'linux', arch: 'arm64', mode: 'package' })
  await manager.prepare({ platform: 'darwin', arch: 'arm64', mode: 'package' })
  assert.equal(mac.version, win.version)
  assert.equal(linux.version, mac.version)
  assert.ok(win.binary.endsWith('win-x64/uxplay-mini.exe'))
  assert.ok(linux.binary.endsWith('linux-arm64/uxplay-mini'))
  assert.equal(f.requests.filter(({ url }) => url.endsWith('/latest')).length, 1)
  const sidecars = f.requests.filter(({ url }) => url.endsWith('.zip.sha256'))
  assert.equal(sidecars.length, 3)
  assert.equal(new Set(sidecars.map(({ url }) => url)).size, 3)
})

test('pinned version uses the tag endpoint and is not replaced by newer cached versions', async (t) => {
  const f = await fixture(t)
  await f.manager().prepare({ platform: 'darwin', arch: 'arm64' })
  await f.addRelease('v0.2.0')
  f.latest = 'v0.2.0'
  const result = await f
    .manager({ env: { UXPLAY_MINI_VERSION: 'v0.2.0' } })
    .prepare({ platform: 'darwin', arch: 'arm64' })
  assert.equal(result.version, 'v0.2.0')
  assert.ok(f.requests.at(-3).url.endsWith('/tags/v0.2.0'))
  const calls = f.requests.length
  const pinned = f.manager({
    env: { UXPLAY_MINI_VERSION: 'v0.1.0' },
    fetchImpl: () => {
      throw new Error('Pinned cache must work offline')
    }
  })
  assert.equal((await pinned.prepare({ platform: 'darwin', arch: 'arm64' })).version, 'v0.1.0')
  assert.equal(f.requests.length, calls)
})

test('local development override skips every download and is rejected for release packaging', async (t) => {
  const f = await fixture(t)
  const binary = join(f.directory, 'local-mini')
  await writeFile(binary, 'local binary', { mode: 0o755 })
  const manager = f.manager({ env: { UXPLAY_MINI_BINARY: binary } })
  assert.equal((await manager.prepare()).source, 'local')
  assert.equal(f.requests.length, 0)
  await assert.rejects(manager.prepare({ mode: 'package' }), /development-only/)
})

test('missing repository/release fails clearly and never silently packages the old stage', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  await f.manager().prepare(target)
  const original = await readFile(join(f.stage(), 'runtime.json'), 'utf8')
  f.latest = 'not-published'
  await assert.rejects(
    f.manager().prepare({ ...target, mode: 'package' }),
    /not found.*xiaozhuai\/uxplay-mini/
  )
  assert.equal(await readFile(join(f.stage(), 'runtime.json'), 'utf8'), original)
})

test('missing platform asset, draft and prerelease are rejected without architecture fallback', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.manager().prepare({ platform: 'win32', arch: 'x64' }),
    /missing a unique asset/
  )
  f.releases.get('v0.1.0').prerelease = true
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /unexpected.*release/
  )
  f.releases.get('v0.1.0').prerelease = false
  f.releases.get('v0.1.0').draft = true
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /unexpected.*release/
  )
})

test('SHA-256 mismatch does not overwrite a previously working runtime', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  await f.manager().prepare(target)
  const data = await f.addRelease('v0.2.0')
  f.latest = 'v0.2.0'
  f.downloads.set(data.assets[0].browser_download_url, Buffer.from('tampered archive'))
  await assert.rejects(f.manager().prepare({ ...target, mode: 'update' }), /SHA-256 mismatch/)
  const meta = JSON.parse(await readFile(join(f.stage(), 'runtime.json'), 'utf8'))
  assert.equal(meta.version, 'v0.1.0')
})

test('GitHub API token is not sent to downloads, persisted or logged', async (t) => {
  const secret = 'mock-github-token-never-persist'
  const f = await fixture(t, { env: { GITHUB_TOKEN: secret } })
  await f.manager().prepare({ platform: 'darwin', arch: 'arm64' })
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer ' + secret)
  assert.equal(f.requests[1].options.headers.Authorization, undefined)
  assert.equal(f.requests[2].options.headers.Authorization, undefined)
  assert.equal(f.logs.join('\n').includes(secret), false)
  assert.equal((await readFile(join(f.stage(), 'runtime.json'), 'utf8')).includes(secret), false)
})

test('foreign asset URLs and invalid target paths are rejected', async (t) => {
  const f = await fixture(t)
  f.releases.get('v0.1.0').assets[0].browser_download_url = 'https://example.com/untrusted.zip'
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /Unexpected GitHub.*URL/
  )
  const count = f.requests.length
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: '../../outside' }),
    /Unsupported mini target/
  )
  assert.equal(f.requests.length, count)
})

test('concurrent preparations for one target share the same download', async (t) => {
  const f = await fixture(t)
  const manager = f.manager()
  const target = { platform: 'darwin', arch: 'arm64', mode: 'package' }
  const [a, b] = await Promise.all([manager.prepare(target), manager.prepare(target)])
  assert.deepEqual(a, b)
  assert.equal(f.requests.length, 3)
})

test('legacy hand-copied binaries are not trusted as a verified development cache', async (t) => {
  const f = await fixture(t)
  const { mkdir } = require('node:fs/promises')
  await mkdir(f.stage(), { recursive: true })
  await writeFile(join(f.stage(), 'uxplay-mini'), 'legacy native binary', { mode: 0o755 })
  f.latest = 'repository-not-created'
  await assert.rejects(f.manager().prepare({ platform: 'darwin', arch: 'arm64' }), /not found/)
  assert.equal(await readFile(join(f.stage(), 'uxplay-mini'), 'utf8'), 'legacy native binary')
})

test('network failures and oversized responses do not silently reuse an old runtime', async (t) => {
  const f = await fixture(t)
  const target = { platform: 'darwin', arch: 'arm64' }
  await f.manager().prepare(target)
  const networkDown = f.manager({
    fetchImpl: () => {
      throw new Error('network unavailable')
    }
  })
  await assert.rejects(networkDown.prepare({ ...target, mode: 'update' }), /network unavailable/)
  const oversized = f.manager({
    fetchImpl: () => new Response('too large', { headers: { 'content-length': '999999999' } })
  })
  await assert.rejects(oversized.prepare({ ...target, mode: 'package' }), /size limit/)
  assert.equal(
    JSON.parse(await readFile(join(f.stage(), 'runtime.json'), 'utf8')).version,
    'v0.1.0'
  )
})

test('checksums must agree with GitHub digests and must identify exactly one matching ZIP', async (t) => {
  const f = await fixture(t)
  const release = f.releases.get('v0.1.0')
  release.assets[0].digest = 'sha256:' + '0'.repeat(64)
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /digests? .*disagree/
  )
  delete release.assets[0].digest
  const sidecar = release.assets.find((asset) => asset.name.endsWith('.zip.sha256'))
  delete sidecar.digest
  f.downloads.set(
    sidecar.browser_download_url,
    Buffer.from('0'.repeat(64) + '  wrong-target.zip\n')
  )
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /Invalid SHA-256 sidecar/
  )
})

for (const format of ['bare', 'text', 'binary', 'uppercase-bom-crlf']) {
  test('per-ZIP checksum accepts ' + format + ' format', async (t) => {
    const f = await fixture(t)
    const [zip, sidecar] = f.releases.get('v0.1.0').assets
    const digest = zip.digest.slice('sha256:'.length)
    const content = Buffer.from(
      {
        bare: digest + '\n',
        text: digest + '  ' + zip.name + '\n',
        binary: digest + ' *' + zip.name + '\n',
        'uppercase-bom-crlf': '\uFEFF' + digest.toUpperCase() + '  ' + zip.name + '\r\n'
      }[format]
    )
    sidecar.digest = 'sha256:' + hash(content)
    f.downloads.set(sidecar.browser_download_url, content)
    await f.manager().prepare({ platform: 'darwin', arch: 'arm64' })
    const metadata = JSON.parse(await readFile(join(f.stage(), 'runtime.json'), 'utf8'))
    assert.equal(metadata.archiveSha256, digest)
    assert.equal(f.requests[1].url, zip.browser_download_url + '.sha256')
  })
}

test('missing ZIP checksum sidecar fails without downloading the ZIP', async (t) => {
  const f = await fixture(t)
  const release = f.releases.get('v0.1.0')
  release.assets = release.assets.filter((asset) => !asset.name.endsWith('.sha256'))
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /missing a unique asset: .*\.zip\.sha256/
  )
  assert.equal(f.requests.length, 1)
})

test('malformed or multi-record sidecars are rejected before ZIP download', async (t) => {
  const invalid = [
    '',
    'not-a-hash',
    'a'.repeat(63),
    'a'.repeat(64) + '\n' + 'b'.repeat(64),
    'a'.repeat(64) + '  wrong-target.zip',
    'a'.repeat(64) + '  ./uxplay-mini-v0.1.0-macos-arm64.zip'
  ]
  for (const value of invalid) {
    const f = await fixture(t)
    const sidecar = f.releases.get('v0.1.0').assets[1]
    const content = Buffer.from(value)
    sidecar.digest = 'sha256:' + hash(content)
    f.downloads.set(sidecar.browser_download_url, content)
    await assert.rejects(
      f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
      /Invalid SHA-256 sidecar/
    )
    assert.equal(f.requests.filter(({ url }) => url.endsWith('.zip')).length, 0)
  }
})

test('sidecar digest mismatch and excessive size are rejected', async (t) => {
  const f = await fixture(t)
  const sidecar = f.releases.get('v0.1.0').assets[1]
  f.downloads.set(sidecar.browser_download_url, Buffer.from('changed checksum file'))
  await assert.rejects(
    f.manager().prepare({ platform: 'darwin', arch: 'arm64' }),
    /sidecar asset digest mismatch/
  )
  const oversized = Buffer.alloc(4097, 'a')
  sidecar.digest = 'sha256:' + hash(oversized)
  f.downloads.set(sidecar.browser_download_url, oversized)
  await assert.rejects(f.manager().prepare({ platform: 'darwin', arch: 'arm64' }), /size limit/)
  assert.equal(f.requests.filter(({ url }) => url.endsWith('.zip')).length, 0)
})

test('npm dev/preview prepare the runtime directly, while macOS build does not call npm run build', () => {
  const { scripts } = require('../package.json')
  assert.equal(scripts.dev, 'node scripts/prepare-runtime.mjs && electron-vite dev')
  assert.equal(scripts.start, 'node scripts/prepare-runtime.mjs && electron-vite preview')
  assert.equal(scripts['runtime:update'], 'node scripts/prepare-runtime.mjs --update')
  assert.equal(scripts['build:mac'], 'electron-vite build && electron-builder --mac')
})

test('ZIP extraction rejects traversal, links, unexpected files, missing notices and expansion bombs', async () => {
  const { unpackRuntime } = await archivePromise
  const traversal = await makeZip('uxplay-mini', (zip) => {
    zip.remove('uxplay-mini')
    zip.file('../../uxplay-mini', 'evil', { createFolders: false })
  })
  await assert.rejects(unpackRuntime(traversal, 'uxplay-mini'), /unsafe ZIP/)
  const symlink = await makeZip('uxplay-mini', (zip) =>
    zip.file('uxplay-mini', '../evil', { unixPermissions: 0o120777 })
  )
  await assert.rejects(unpackRuntime(symlink, 'uxplay-mini'), /unsafe ZIP/)
  const extra = await makeZip('uxplay-mini', (zip) => zip.file('extra.exe', 'evil'))
  await assert.rejects(unpackRuntime(extra, 'uxplay-mini'), /exactly/)
  const missing = await makeZip('uxplay-mini', (zip) => zip.remove('LICENSE'))
  await assert.rejects(unpackRuntime(missing, 'uxplay-mini'), /exactly/)
  const bomb = await makeZip('uxplay-mini', (zip) => zip.file('uxplay-mini', Buffer.alloc(4096)))
  await assert.rejects(unpackRuntime(bomb, 'uxplay-mini', { maxBytes: 1000 }), /size limit/)
})
