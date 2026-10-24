const assert = require('node:assert/strict')
const { test } = require('node:test')
const { McpService } = require('../src/main/mcpService.ts')
const { AudioCapture, wav } = require('../src/main/audioCapture.ts')
const { PhoneInput, asciiKey } = require('../src/renderer/src/phoneInput.ts')
const { POINTER_MOTION, pointerSteps } = require('../src/renderer/src/pointerMotion.ts')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const path = require('node:path')
const { McpBridge } = require('../src/main/mcpBridge.ts')
const {
  DEFAULT_MCP_HOST,
  normalizeMcpHost,
  mcpHostKey,
  isMcpLoopback,
  mcpClientUrl,
  validateMcpConfiguration
} = require('../src/shared/mcp.ts')

test('MCP listen addresses accept IP literals/localhost and correctly classify loopback', () => {
  assert.equal(DEFAULT_MCP_HOST, '127.0.0.1')
  for (const [input, expected] of [
    ['  LOCALHOST  ', 'localhost'],
    ['127.8.1.2', '127.8.1.2'],
    ['[0:0:0:0:0:0:0:1]', '::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::ffff:127.0.0.1', '::ffff:7f00:1'],
    ['0.0.0.0', '0.0.0.0'],
    ['[::]', '::']
  ])
    assert.equal(normalizeMcpHost(input), expected)
  for (const input of [
    '',
    'example.com',
    '127.1',
    '2130706433',
    '127.00.0.1',
    '256.1.1.1',
    'http://127.0.0.1',
    '127.0.0.1:2787',
    '[::1]:2787',
    'fe80::1%en0',
    ':::',
    '[127.0.0.1]',
    null,
    0
  ])
    assert.throws(() => normalizeMcpHost(input), /MCP address/)
  for (const input of ['localhost', '127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1'])
    assert.equal(isMcpLoopback(input), true, input)
  for (const input of ['0.0.0.0', '::', '192.168.1.2', '::ffff:192.168.1.2', '2001:db8::1'])
    assert.equal(isMcpLoopback(input), false, input)
  assert.equal(mcpHostKey('::ffff:192.168.1.2'), '192.168.1.2')
  assert.equal(mcpClientUrl('::1', 2787), 'http://[::1]:2787/mcp')
  assert.equal(mcpClientUrl('0.0.0.0', 2787), 'http://127.0.0.1:2787/mcp')
  assert.equal(mcpClientUrl('::', 2787), 'http://[::1]:2787/mcp')
  assert.equal(mcpClientUrl('192.168.1.2', 2787), 'http://192.168.1.2:2787/mcp')
})

test('MCP settings require explicit restart/remote confirmations and preserve legacy loopback config', () => {
  const off = { enabled: false, host: DEFAULT_MCP_HOST, port: 2787 }
  const on = { ...off, enabled: true }
  assert.equal(validateMcpConfiguration({ enabled: true, port: 2787 }, off).host, DEFAULT_MCP_HOST)
  assert.throws(() => validateMcpConfiguration({ ...on, port: 3000 }, on), /restarting/)
  assert.throws(() => validateMcpConfiguration({ ...on, host: '::1' }, on), /restarting/)
  assert.equal(validateMcpConfiguration({ ...on, port: 3000, restart: true }, on).port, 3000)
  const remote = { ...off, host: '0.0.0.0' }
  assert.throws(() => validateMcpConfiguration(remote, off), /security warning/)
  assert.equal(validateMcpConfiguration({ ...remote, allowRemote: true }, off).host, '0.0.0.0')
  assert.throws(
    () => validateMcpConfiguration({ ...remote, enabled: true }, remote),
    /security warning/
  )
  assert.equal(
    validateMcpConfiguration({ ...remote, enabled: true, allowRemote: true }, remote).enabled,
    true
  )
  assert.equal(
    validateMcpConfiguration({ ...remote, enabled: false }, { ...remote, enabled: true }).enabled,
    false
  )
  assert.equal(validateMcpConfiguration({ ...off, port: 3000 }, off).port, 3000)
  for (const value of [
    null,
    [],
    { ...off, port: 0 },
    { ...off, port: '2787' },
    { ...off, port: 65536 },
    { ...off, enabled: 1 },
    { ...off, restart: 'true' },
    { ...off, allowRemote: 'true' }
  ])
    assert.throws(() => validateMcpConfiguration(value, off))
})

function fixture() {
  const messages = []
  let clock = 1000
  const context = {
    key: 'test:usb',
    target: 'usb',
    connected: true,
    ready: true,
    manual: false,
    width: 400,
    height: 800
  }
  const physical = { x: 600, y: 1200, button: false }
  const input = new PhoneInput({
    context: () => context,
    send: (message) => {
      messages.push(message)
      if (message.type === 'mouse_move') {
        physical.x = Math.max(0, Math.min(800, physical.x + message.x))
        physical.y = Math.max(0, Math.min(1600, physical.y + message.y))
      }
      if (message.type === 'mouse_button') physical.button = message.pressed
      if (message.type === 'release_all') physical.button = false
      return true
    },
    flush: async () => {},
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  })
  input.setProfile({ width: 800, height: 1600, aspect: 0.5 })
  return {
    input,
    messages,
    physical,
    context,
    advance: (ms) => {
      clock += ms
    }
  }
}

test('relative HID homes an unknown cursor and reaches normalized coordinates without overflow', async () => {
  const f = fixture()
  const result = await f.input.execute('tap', { x: 0.5, y: 0.25 })
  assert.equal(result.busy, false, 'a completed tool must not report itself as still executing')
  assert.deepEqual(f.physical, { x: 400, y: 400, button: false })
  assert.ok(f.messages.some((message) => message.x === -127))
  for (const message of f.messages.filter((message) => message.type === 'mouse_move')) {
    assert.ok(Number.isInteger(message.x) && Math.abs(message.x) <= 127)
    assert.ok(Number.isInteger(message.y) && Math.abs(message.y) <= 127)
  }
})

test('cursor rehomes after ten gestures and after idle timeout, never during a drag', async () => {
  const f = fixture()
  const homes = () => f.messages.filter((message) => message.x === -127).length
  for (let i = 0; i < 10; i++) await f.input.execute('pointer_move', { x: 0.5, y: 0.5 })
  const first = homes()
  await f.input.execute('pointer_move', { x: 0.6, y: 0.6 })
  assert.equal(homes(), first * 2)
  f.advance(31000)
  await f.input.execute('drag', {
    points: [
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.8 }
    ],
    durationMs: 200
  })
  assert.equal(homes(), first * 3)
  const down = f.messages.findLastIndex(
    (message) => message.type === 'mouse_button' && message.pressed
  )
  assert.ok(!f.messages.slice(down).some((message) => message.x === -127))
  assert.equal(f.physical.button, false)
})

test('tap lets delayed HID movement reach the phone before pressing', async () => {
  let clock = 1000
  const pending = [],
    clicks = []
  const physical = { x: 600, y: 1200 }
  const input = new PhoneInput({
    context: () => ({
      key: 'delayed:ble',
      target: 'ble',
      connected: true,
      ready: true,
      manual: false,
      width: 400,
      height: 800
    }),
    send: (message) => {
      if (message.type === 'mouse_move') pending.push({ ...message, at: clock + 100 })
      if (message.type === 'mouse_button' && message.pressed) clicks.push({ ...physical })
      return true
    },
    flush: async () => {}, // Board dispatch acknowledgement is earlier than host application.
    sleep: async (ms) => {
      clock += ms
      while (pending.length && pending[0].at <= clock) {
        const m = pending.shift()
        physical.x = Math.max(0, Math.min(800, physical.x + m.x))
        physical.y = Math.max(0, Math.min(1600, physical.y + m.y))
      }
    },
    now: () => clock
  })
  input.setProfile({ width: 800, height: 1600, aspect: 0.5 })
  await input.execute('tap', { x: 0.5, y: 0.25 })
  assert.deepEqual(clicks, [{ x: 400, y: 400 }])
})

test('prepared pointer click preserves the observed landing across a homing deadline, once', async () => {
  const f = fixture()
  await f.input.execute('pointer_move', { x: 0.05, y: 0.05 })
  f.advance(27000)
  await f.input.execute('pointer_move', { x: 0.06, y: 0.06 })
  f.advance(2000)
  assert.equal(f.input.status().clickReady, true)
  const before = f.messages.length
  await f.input.execute('pointer_click', {})
  assert.ok(!f.messages.slice(before).some((m) => m.type === 'mouse_move'))
  assert.deepEqual(f.physical, { x: 48, y: 96, button: false })
  assert.equal(f.input.status().clickReady, false)
  await assert.rejects(f.input.execute('pointer_click', {}), /prepared cursor/)
})

test('prepared click refuses expired, invalidated or intervening input without pressing', async () => {
  for (const invalidate of [
    async (f) => f.advance(30000),
    async (f) => f.input.invalidate(),
    async (f) => f.input.execute('key_press', { usages: [4] }),
    async (f) => {
      f.context.width = 800
      f.context.height = 400
    }
  ]) {
    const f = fixture()
    await f.input.execute('pointer_move', { x: 0.5, y: 0.5 })
    await invalidate(f)
    const before = f.messages.length
    await assert.rejects(f.input.execute('pointer_click', {}))
    assert.ok(!f.messages.slice(before).some((m) => m.type === 'mouse_button' && m.pressed))
  }
})

test('manual input/reconnect invalidation forces homing and rotation requires a matching profile', async () => {
  const f = fixture()
  await f.input.execute('pointer_move', { x: 0.4, y: 0.4 })
  f.input.invalidate()
  const before = f.messages.length
  await f.input.execute('pointer_move', { x: 0.5, y: 0.5 })
  assert.ok(f.messages.slice(before).some((message) => message.x === -127))
  f.context.width = 800
  f.context.height = 400
  await assert.rejects(f.input.execute('tap', { x: 0.5, y: 0.5 }), /not calibrated/)
})

test('manual capture and missing HID transport refuse AI input', async () => {
  const f = fixture()
  f.context.manual = true
  await assert.rejects(f.input.execute('tap', { x: 0.5, y: 0.5 }), /Manual/)
  f.context.manual = false
  f.context.ready = false
  await assert.rejects(f.input.execute('key_press', { usages: [4] }), /HID transport/)
  assert.equal(f.messages.length, 0)
})

test('probe observation calibrates without clicking, persists and rejects edge clamping', async () => {
  const f = fixture()
  await f.input.execute('pointer_probe', { units: 150 })
  await assert.rejects(f.input.execute('pointer_observe', { x: 0.99, y: 0.5 }), /edges/)
  await f.input.execute('pointer_probe', { units: 150 })
  await f.input.execute('pointer_observe', { x: 0.1875, y: 0.09375 })
  assert.equal(f.input.status().profile.width, 800)
  assert.equal(f.input.status().profile.height, 1600)
  assert.ok(!f.messages.some((message) => message.type === 'mouse_button'))
  const next = fixture()
  next.input.loadProfiles(f.input.savedProfiles())
  assert.deepEqual(next.input.status().profile, f.input.status().profile)
})

test('raw relative moves invalidate pointer estimate; invalid Unicode fails before any key press', async () => {
  const f = fixture()
  await f.input.execute('pointer_probe', { units: 50 })
  await f.input.execute('mouse_move_relative', { x: 100, y: -20 })
  assert.equal(f.input.status().position, null)
  await assert.rejects(f.input.execute('pointer_observe', { x: 0.3, y: 0.3 }), /first/)
  await assert.rejects(f.input.execute('type_text', { text: 'abc中文' }), /ASCII/)
  assert.ok(!f.messages.some((message) => message.type === 'key'))
  assert.deepEqual(asciiKey('A'), { usage: 4, shift: true })
  assert.deepEqual(asciiKey('@'), { usage: 0x1f, shift: true })
})

test('two probes fit edge offset; feedback preserves the fit and corrects toward the original target', async () => {
  const f = fixture()
  await f.input.execute('pointer_probe', { units: 150 })
  await f.input.execute('pointer_observe', { x: 0.1975, y: 0.10375 })
  await f.input.execute('pointer_probe', { units: 300 })
  await f.input.execute('pointer_observe', { x: 0.385, y: 0.1975 })
  assert.ok(Math.abs(f.input.status().profile.width - 800) < 0.01)
  assert.ok(Math.abs(f.input.status().profile.offsetX - 0.01) < 0.001)
  const calibration = f.input.savedProfiles()
  await f.input.execute('pointer_move', { x: 0.5, y: 0.5 })
  await f.input.execute('pointer_correct', { x: 0.52, y: 0.51 })
  assert.deepEqual(f.input.savedProfiles(), calibration)
  assert.deepEqual(f.input.status().requestedTarget, { x: 0.5, y: 0.5 })
  const before = f.messages.length
  await f.input.execute('pointer_correct', { x: 0.51, y: 0.505 })
  const corrections = f.messages.slice(before).filter((m) => m.type === 'mouse_move')
  assert.equal(
    corrections.reduce((sum, m) => sum + m.x, 0),
    -8
  )
  assert.equal(
    corrections.reduce((sum, m) => sum + m.y, 0),
    -8
  )
  await assert.rejects(f.input.execute('pointer_correct', { x: 0.9, y: 0.9 }), /too large/)
})

test('all directions and path lengths use unit axis reports with exact displacement', () => {
  for (const [dx, dy] of [
    [1, 0],
    [50, 50],
    [-61, 23],
    [0, -19],
    [3, 100],
    [0, 0]
  ]) {
    const steps = [...pointerSteps(dx, dy)]
    assert.equal(
      steps.reduce((sum, p) => sum + p.x, 0),
      dx
    )
    assert.equal(
      steps.reduce((sum, p) => sum + p.y, 0),
      dy
    )
    assert.ok(steps.every((p) => Math.abs(p.x) + Math.abs(p.y) === 1))
    let x = 0,
      y = 0
    for (const p of steps) {
      x += p.x
      y += p.y
      // The interleaving stays within one HID count of the intended line.
      assert.ok(Math.abs(x * dy - y * dx) <= Math.abs(dx) + Math.abs(dy))
    }
  }
})

test('oversized positioning and drag paths fail before pressing instead of timing out held', async () => {
  const f = fixture()
  await assert.rejects(f.input.execute('pointer_move', { x: 1, y: 1 }), /32s input budget/)
  await assert.rejects(
    f.input.execute('drag', {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 1, y: 1 }
      ],
      durationMs: 500
    }),
    /32s input budget/
  )
  assert.ok(!f.messages.some((m) => m.type === 'mouse_button' && m.pressed))
  assert.equal(f.physical.button, false)
})

test('old speed calibrations are discarded and nominal precision uses decoded-frame pixels', () => {
  const f = fixture()
  const saved = f.input.savedProfiles()
  const key = saved[0][0]
  const next = fixture()
  const oldOnly = new PhoneInput({
    context: () => f.context,
    send: () => true,
    flush: async () => {}
  })
  oldOnly.loadProfiles([[key, { width: 100, height: 200, aspect: 0.5 }]])
  assert.equal(oldOnly.status().calibrated, false)
  oldOnly.loadProfiles(saved)
  assert.equal(oldOnly.status().profile.motion, POINTER_MOTION.id)
  assert.deepEqual(next.input.status().nominalStep, {
    normalizedX: 1 / 800,
    normalizedY: 1 / 1600,
    framePixelsX: 0.5,
    framePixelsY: 0.5
  })
})

test('speed-sensitive host sees the same gain in probes, positioning and drag duration variants', async () => {
  for (const durationMs of [100, 3000]) {
    let clock = 1000
    const physical = { x: 600, y: 1200 }
    const packets = []
    const input = new PhoneInput({
      context: () => ({
        key: 'accelerating',
        target: 'ble',
        connected: true,
        ready: true,
        manual: false,
        width: 400,
        height: 800
      }),
      send: (m) => {
        if (m.type === 'mouse_move') {
          const gain = Math.hypot(m.x, m.y) > 1 ? 2 : 1
          physical.x = Math.max(0, Math.min(800, physical.x + gain * m.x))
          physical.y = Math.max(0, Math.min(1600, physical.y + gain * m.y))
          if (Math.abs(m.x) !== 127) packets.push({ ...m, at: clock })
        }
        return true
      },
      flush: async () => {},
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock
    })
    await input.execute('pointer_probe', { units: 150 })
    await input.execute('pointer_observe', { x: physical.x / 800, y: physical.y / 1600 })
    await input.execute('pointer_move', { x: 0.2, y: 0.2 })
    assert.deepEqual(physical, { x: 160, y: 320 })
    packets.length = 0
    await input.execute('drag', {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.3, y: 0.3 }
      ],
      durationMs
    })
    assert.deepEqual(physical, { x: 240, y: 480 })
    assert.ok(packets.every((m) => Math.hypot(m.x, m.y) === 1))
    for (let i = 1; i < packets.length; i++)
      assert.equal(packets[i].at - packets[i - 1].at, POINTER_MOTION.intervalMs)
  }
})

test('aborting a pressed gesture releases the button and cancels queued operations', async () => {
  const controller = new AbortController()
  let pressed = false,
    input
  const context = {
    key: 'd',
    target: 'usb',
    connected: true,
    ready: true,
    manual: false,
    width: 400,
    height: 800
  }
  input = new PhoneInput({
    context: () => context,
    flush: async () => {},
    send: (m) => {
      if (m.type === 'mouse_button') pressed = m.pressed
      if (m.type === 'release_all') pressed = false
      return true
    },
    sleep: async () => {
      if (pressed) controller.abort()
    }
  })
  input.setProfile({ width: 800, height: 1600, aspect: 0.5 })
  const first = input.execute('long_press', { x: 0.4, y: 0.4 }, controller.signal)
  const queued = input.execute('tap', { x: 0.8, y: 0.8 })
  await assert.rejects(first)
  await assert.rejects(queued, /context changed/)
  assert.equal(pressed, false)
})

test('WAV capture is PCM16 little endian and records only on demand', async () => {
  const encoded = wav(Float32Array.of(-1, 0, 1, NaN))
  assert.equal(encoded.toString('ascii', 0, 4), 'RIFF')
  assert.equal(encoded.readUInt32LE(24), 44100)
  assert.equal(encoded.readUInt16LE(22), 2)
  assert.equal(encoded.readInt16LE(44), -32768)
  assert.equal(encoded.readInt16LE(48), 32767)
  const capture = new AudioCapture()
  const signal = new AbortController()
  const recording = capture.record(100, signal.signal)
  await assert.rejects(capture.record(100, signal.signal), /already active/)
  capture.push({
    samples: new Float32Array(8820),
    sampleRate: 44100,
    channels: 2,
    streamId: 1,
    timestampUs: 0
  })
  assert.equal((await recording).length, 44 + 8820 * 2)
  const cancelled = capture.record(100, signal.signal)
  signal.abort()
  await assert.rejects(cancelled, /cancelled/)
})

async function httpFixture(
  t,
  backend = async (method, params) => ({ method, params }),
  host = DEFAULT_MCP_HOST
) {
  const service = new McpService(backend)
  const state = await service.start(0, service.getState().token, false, host)
  t.after(() => service.stop())
  const headers = {
    Authorization: 'Bearer ' + state.token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  let sequence = 0
  async function rpc(method, params) {
    const response = await fetch(state.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params })
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const reply = response.headers.get('content-type').includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            .slice(5)
        )
      : JSON.parse(text)
    return reply
  }
  return { service, state, headers, rpc }
}

test('real MCP HTTP negotiates, lists the complete tools and validates input before dispatch', async (t) => {
  const calls = []
  const f = await httpFixture(t, async (method, params) => {
    calls.push([method, params])
    return { ok: true }
  })
  const init = await f.rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
  })
  assert.equal(init.result.serverInfo.name, 'iscrcpy')
  const list = await f.rpc('tools/list', {})
  assert.ok(list.result.tools.length >= 30)
  for (const name of [
    'tap',
    'screenshot',
    'capture_audio',
    'pointer_probe',
    'pointer_click',
    'key_press',
    'type_text',
    'list_devices',
    'airplay_restart'
  ])
    assert.ok(list.result.tools.some((tool) => tool.name === name))
  const good = await f.rpc('tools/call', { name: 'tap', arguments: { x: 0.5, y: 0.5 } })
  assert.ok(!good.result.isError)
  assert.equal(calls.length, 1)
  await f.rpc('tools/call', { name: 'tap', arguments: { x: 500, y: 0.5 } })
  await f.rpc('tools/call', { name: 'tap', arguments: { x: 0.5, y: 0.5, arbitrary: true } })
  assert.equal(calls.length, 1)
})

test('MCP HTTP rejects unauthenticated, foreign-origin, forged-host and oversized requests', async (t) => {
  const f = await httpFixture(t)
  const request = (headers) =>
    fetch(f.state.url, { method: 'POST', headers: { ...f.headers, ...headers }, body: '{}' })
  assert.equal((await request({ Authorization: '' })).status, 401)
  assert.equal((await request({ Authorization: f.state.token })).status, 401)
  assert.equal((await request({ Origin: 'https://evil.example' })).status, 403)
  const forged = await new Promise((resolve) => {
    const request = http.request(
      f.state.url,
      { method: 'POST', headers: { ...f.headers, Host: 'evil.example:' + f.state.port } },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    request.end('{}')
  })
  assert.equal(forged, 403)
  assert.equal(
    (await fetch(f.state.url, { method: 'POST', headers: f.headers, body: 'x'.repeat(65537) }))
      .status,
    413
  )
  assert.equal((await fetch(f.state.url, { headers: f.headers })).status, 405)
})

test('wildcard IPv4 listener supports address changes without weakening bearer/Host/Origin guards', async (t) => {
  const f = await httpFixture(t, undefined, '0.0.0.0')
  assert.equal(f.state.host, '0.0.0.0')
  assert.match(f.state.url, /^http:\/\/127\.0\.0\.1:/)
  assert.ok(!(await f.rpc('tools/call', { name: 'get_status', arguments: {} })).result.isError)
  const request = (headers) =>
    fetch(f.state.url, { method: 'POST', headers: { ...f.headers, ...headers }, body: '{}' })
  assert.equal((await request({ Authorization: '' })).status, 401)
  assert.equal((await request({ Origin: 'http://evil.example:' + f.state.port })).status, 403)
  assert.equal((await request({ Origin: 'http://127.0.0.1:1' })).status, 403)
  assert.equal((await request({ Origin: `http://127.0.0.1:${f.state.port}/path` })).status, 403)
  const forged = await new Promise((resolve, reject) => {
    const req = http.request(
      f.state.url,
      { method: 'POST', headers: { ...f.headers, Host: 'evil.example:' + f.state.port } },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      }
    )
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(forged, 403)
  const token = f.state.token
  f.service.setPaused(true)
  Object.assign(f.state, await f.service.start(0, token, true, DEFAULT_MCP_HOST))
  assert.equal(f.state.host, DEFAULT_MCP_HOST)
  assert.equal(f.state.token, token)
  assert.equal(f.state.paused, true)
  assert.equal(
    (await f.rpc('tools/call', { name: 'get_status', arguments: {} })).result.isError,
    true
  )
})

test('IPv6 wildcard listener accepts bracketed local URLs and rejects foreign origins', async (t) => {
  let f
  try {
    f = await httpFixture(t, undefined, '::')
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return t.skip('IPv6 unavailable')
    throw error
  }
  assert.equal(f.state.host, '::')
  assert.match(f.state.url, /^http:\/\/\[::1\]:/)
  assert.ok(!(await f.rpc('tools/call', { name: 'get_status', arguments: {} })).result.isError)
  assert.equal(
    (
      await fetch(f.state.url, {
        method: 'POST',
        headers: { ...f.headers, Origin: 'http://evil.example' },
        body: '{}'
      })
    ).status,
    403
  )
})

test('MCP shutdown aborts in-flight phone operations and refuses new connections', async (t) => {
  let aborted = false,
    entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const f = await httpFixture(t, async (_method, _params, signal) => {
    entered()
    await new Promise((resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('stopped'))
        },
        { once: true }
      )
    )
  })
  const pending = f.rpc('tools/call', { name: 'get_status', arguments: {} }).catch(() => undefined)
  await started
  await f.service.stop()
  await pending
  assert.equal(aborted, true)
  assert.equal(f.service.getState().enabled, false)
  await assert.rejects(fetch(f.state.url))
})

test('MCP pause cancels operations, gates all tools and resumes without changing the listener/token', async (t) => {
  const calls = []
  let entered, inputSignal
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const f = await httpFixture(t, async (method, _params, signal) => {
    calls.push(method)
    if (method !== 'long_press') return { ok: true }
    inputSignal = signal
    entered()
    return new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    )
  })
  const running = f.rpc('tools/call', {
    name: 'long_press',
    arguments: { x: 0.5, y: 0.5, durationMs: 3000 }
  })
  await started
  const paused = f.service.setPaused(true)
  assert.equal(paused.enabled, true)
  assert.equal(paused.paused, true)
  assert.equal(paused.url, f.state.url)
  assert.equal(paused.token, f.state.token)
  assert.equal(inputSignal.aborted, true)
  assert.equal((await running).result.isError, true)
  for (const name of ['get_status', 'screenshot', 'capture_audio', 'tap']) {
    const args = name === 'tap' ? { x: 0.5, y: 0.5 } : {}
    const result = await f.rpc('tools/call', { name, arguments: args })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /paused by the user/)
  }
  assert.deepEqual(calls, ['long_press'], 'paused tools must never reach the backend')
  assert.ok(
    (await f.rpc('tools/list', {})).result.tools.length >= 30,
    'MCP protocol remains available'
  )
  const resumed = f.service.setPaused(false)
  assert.equal(resumed.enabled, true)
  assert.equal(resumed.paused, false)
  assert.equal(resumed.url, paused.url)
  assert.equal(resumed.token, paused.token)
  assert.equal(inputSignal.aborted, true, 'resuming cannot revive an old operation')
  assert.ok(!(await f.rpc('tools/call', { name: 'get_status', arguments: {} })).result.isError)
  f.service.setPaused(true)
  await f.service.stop()
  Object.assign(f.state, await f.service.start(0, f.state.token))
  assert.equal(
    f.service.getState().paused,
    true,
    'service reconfiguration preserves pause independently of enabled'
  )
  assert.equal(
    (await f.rpc('tools/call', { name: 'get_status', arguments: {} })).result.isError,
    true
  )
})

test('MCP can start paused from saved preferences without admitting a tool', async (t) => {
  let calls = 0
  const service = new McpService(async () => {
    calls++
    return {}
  })
  const state = await service.start(0, service.getState().token, true)
  t.after(() => service.stop())
  const response = await fetch(state.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + state.token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_status', arguments: {} }
    })
  })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /paused by the user/)
  assert.equal(calls, 0)
  assert.equal(service.getState().enabled, true)
  assert.equal(service.getState().paused, true)
})

test('renderer bridge rejects spoofed replies and releases pending requests on cancellation/navigation', async () => {
  const target = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    messages: [],
    send(channel, value) {
      this.messages.push([channel, value])
    }
  })
  const bridge = new McpBridge()
  bridge.attach(target)
  await assert.rejects(bridge.call('get_status', {}, new AbortController().signal), /not ready/)
  bridge.ready(target)
  const first = bridge.call('get_status', {}, new AbortController().signal)
  const id = target.messages[0][1].id
  bridge.reply({}, { id, result: 'forged' })
  bridge.reply(target, { id, result: 'real' })
  assert.equal(await first, 'real')
  const controller = new AbortController()
  const pending = bridge.call('tap', {}, controller.signal)
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(target.messages.at(-1)[0], 'mcp:cancel')
  const navigating = bridge.call('get_status', {}, new AbortController().signal)
  target.emit('did-start-loading')
  await assert.rejects(navigating, /closed/)
  await assert.rejects(bridge.call('get_status', {}, new AbortController().signal), /not ready/)
})

test('stdio adapter negotiates and calls the real HTTP server; cancellation reaches the backend', async (t) => {
  let entered,
    cancelled = false
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const f = await httpFixture(t, async (method, _params, signal) => {
    if (method !== 'capture_audio') return { connected: true }
    entered()
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true
          reject(new Error('cancelled'))
        },
        { once: true }
      )
    })
  })
  const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/mcp-stdio.mjs')], {
    env: { ...process.env, ISCRCPY_MCP_URL: f.state.url, ISCRCPY_MCP_TOKEN: f.state.token },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map(),
    unmatched = []
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data
  })
  lines.on('line', (line) => {
    const reply = JSON.parse(line)
    const resolve = pending.get(reply.id)
    if (resolve) {
      pending.delete(reply.id)
      resolve(reply)
    } else unmatched.push(reply)
  })
  t.after(() => {
    lines.close()
    child.kill()
  })
  async function send(id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio timeout: ' + stderr)), 5000)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const init = await send(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '1' }
  })
  assert.equal(init.result.serverInfo.name, 'iscrcpy')
  const list = await send(2, 'tools/list', {})
  assert.ok(list.result.tools.some((tool) => tool.name === 'screenshot'))
  const status = await send(3, 'tools/call', { name: 'get_status', arguments: {} })
  assert.equal(status.result.structuredContent.result.connected, true)
  const audio = send(4, 'tools/call', { name: 'capture_audio', arguments: { durationMs: 3000 } })
  await started
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 4 }
    }) + '\n'
  )
  assert.match((await audio).error.message, /cancelled/)
  for (let attempt = 0; attempt < 100 && !cancelled; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(cancelled, true, 'HTTP abort must cancel capture/input in the desktop backend')
  assert.deepEqual(unmatched, [])
  assert.ok(!stderr.includes(f.state.token))
})
