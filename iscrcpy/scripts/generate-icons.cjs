// Run with Electron so resizing uses Chromium's image codecs on every platform.
const { app, nativeImage } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const { resolve } = require('node:path')

const root = resolve(__dirname, '..')
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

function createIco(images) {
  const frames = sizes.filter((size) => size <= 256)
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach((size, index) => {
    const entry = 6 + index * 16
    const png = images.get(size)
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...frames.map((size) => images.get(size))])
}

function createIcns(images) {
  // Modern ICNS entries store PNG frames, including the Retina representations.
  const types = {
    icp4: 16,
    icp5: 32,
    icp6: 64,
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
    ic11: 32,
    ic12: 64,
    ic13: 256,
    ic14: 512
  }
  const frames = Object.entries(types).map(([type, size]) => {
    const png = images.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + frames.reduce((sum, frame) => sum + frame.length, 0), 4)
  return Buffer.concat([header, ...frames])
}

async function generate() {
  const source = nativeImage.createFromPath(resolve(root, 'build/icon-source.png'))
  const { width, height } = source.getSize()
  if (source.isEmpty() || width !== height || width < 1024) {
    throw new Error('build/icon-source.png must be a square PNG of at least 1024 pixels')
  }

  const images = new Map(
    sizes.map((size) => [
      size,
      source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    ])
  )
  await mkdir(resolve(root, 'build/icons'), { recursive: true })
  for (const [size, png] of images) {
    await writeFile(resolve(root, `build/icons/${size}x${size}.png`), png)
  }
  await writeFile(resolve(root, 'build/icon.png'), images.get(1024))
  await writeFile(resolve(root, 'build/icon.ico'), createIco(images))
  await writeFile(resolve(root, 'build/icon.icns'), createIcns(images))
  await writeFile(resolve(root, 'resources/icon.png'), images.get(512))
  await writeFile(resolve(root, 'src/renderer/src/assets/app-icon.png'), images.get(128))
  console.log('Generated macOS ICNS, Windows ICO, Linux PNGs and application assets.')
}

app.whenReady().then(async () => {
  try {
    await generate()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
