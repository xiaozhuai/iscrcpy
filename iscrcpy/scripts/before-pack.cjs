const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

let manager
module.exports = async (context) => {
  // Share one latest-release lookup across all targets in this packaging run.
  manager ||= import(pathToFileURL(join(__dirname, 'prepare-runtime.mjs')).href).then(
    ({ createRuntimeManager }) => createRuntimeManager()
  )
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch]
  if (!arch) throw new Error('Unsupported packaging architecture: ' + context.arch)
  await (await manager).prepare({ platform: context.electronPlatformName, arch, mode: 'package' })
}
