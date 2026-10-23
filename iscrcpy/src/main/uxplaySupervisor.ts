export const UXPLAY_PID_MARKER = '__ISCRCPY_UXPLAY_PID__='

export const UXPLAY_SUPERVISOR_SOURCE = `
const { spawn, spawnSync } = require('node:child_process')
const [binary, ...args] = process.argv.slice(1)
if (!binary) process.exit(2)
const child = spawn(binary, args, {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  detached: process.platform !== 'win32'
})
let stopping = false
let forceTimer
const terminateTree = (signal) => {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {}
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch {}
  }
}
const terminate = () => {
  if (stopping) return
  stopping = true
  if (child.exitCode === null) terminateTree('SIGTERM')
  forceTimer = setTimeout(() => {
    if (child.exitCode === null) terminateTree('SIGKILL')
    process.exit(1)
  }, 1000)
}
const forward = (stream, chunk) => {
  if (stream.destroyed || !stream.writable) return
  try { stream.write(chunk) } catch {}
}
process.stdout.write('${UXPLAY_PID_MARKER}' + String(child.pid || '') + '\\n')
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
child.stdout.on('data', chunk => forward(process.stdout, chunk))
child.stderr.on('data', chunk => forward(process.stderr, chunk))
child.on('error', (error) => {
  process.stderr.write(String(error) + '\\n')
  process.exit(1)
})
child.on('exit', (code) => {
  if (forceTimer) clearTimeout(forceTimer)
  process.exit(code == null ? 1 : code)
})
process.stdin.resume()
process.stdin.on('end', terminate)
process.stdin.on('close', terminate)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try { process.on(signal, terminate) } catch {}
}
`
