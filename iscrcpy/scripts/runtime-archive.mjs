import JSZip from 'jszip'

export const NOTICE_FILES = ['LICENSE', 'UPSTREAM.md', 'playfair-LICENSE.md']
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024

function readEntry(entry, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const stream = entry.internalStream('nodebuffer')
    stream.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        stream.pause()
        reject(new Error('Release ZIP exceeds unpacked size limit'))
      } else chunks.push(chunk)
    })
    stream.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    stream.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks, size))
      }
    })
    stream.resume()
  })
}

// SHA-256 is verified before parsing. Do not enable eager checkCRC32: JSZip
// would inflate every entry before we could enforce the size/file limits.
// Stream only the four approved regular files, with a shared expansion budget.
export async function unpackRuntime(archive, binary, { maxBytes = MAX_UNPACKED_BYTES } = {}) {
  const zip = await JSZip.loadAsync(archive, { createFolders: false, checkCRC32: false })
  const expected = new Set([binary, ...NOTICE_FILES])
  const entries = Object.values(zip.files)
  if (entries.length !== expected.size)
    throw new Error('Release ZIP must contain exactly the binary and three license notices')
  for (const entry of entries) {
    const type = (entry.unixPermissions ?? 0) & 0xf000
    if (
      entry.dir ||
      !expected.has(entry.name) ||
      entry.unsafeOriginalName !== entry.name ||
      (type !== 0 && type !== 0x8000)
    ) {
      throw new Error(
        'Unexpected or unsafe ZIP entry: ' + JSON.stringify(entry.unsafeOriginalName ?? entry.name)
      )
    }
  }
  const files = new Map()
  let total = 0
  for (const entry of entries) {
    const bytes = await readEntry(entry, maxBytes - total)
    if (!bytes.length) throw new Error('Release ZIP contains an empty file: ' + entry.name)
    total += bytes.length
    files.set(entry.name, bytes)
  }
  for (const name of expected) {
    if (!files.has(name)) throw new Error('Release ZIP is missing ' + name)
  }
  return files
}
