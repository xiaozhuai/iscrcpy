require('./register-ts.cjs')
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createSocket } = require('node:dgram')
const { createServer } = require('node:net')
const { validateMcpConfiguration } = require('../src/shared/mcp.ts')
const { AirplayService } = require('../src/main/airplay.ts')
const { findRuntime } = require('../src/main/uxplayRuntime.ts')
const { McpBridge } = require('../src/main/mcpBridge.ts')
const { McpService } = require('../src/main/mcpService.ts')
const directory = mkdtempSync(path.join(tmpdir(), 'iscrcpy-mcp-electron-'))
app.setPath('userData', path.join(directory, 'user-data'))
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => app.exit(1), 75000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(25)
  }
  throw new Error('Timed out: ' + label)
}
function rtp(pt, sequence, timestamp, payload, marker = true) {
  const header = Buffer.alloc(12)
  header[0] = 0x80
  header[1] = pt | (marker ? 128 : 0)
  header.writeUInt16BE(sequence & 65535, 2)
  header.writeUInt32BE(timestamp >>> 0, 4)
  header.writeUInt32BE(pt, 8)
  return Buffer.concat([header, payload])
}
async function run() {
  let window
  const airplay = new AirplayService(),
    bridge = new McpBridge(),
    sender = createSocket('udp4')
  const service = new McpService((method, params, signal) =>
    method === 'capture_audio'
      ? airplay.captureAudio(params.durationMs, signal)
      : bridge.call(method, params, signal)
  )
  const project = path.resolve(__dirname, '..'),
    logs = [],
    errors = []
  const secret = 'test-secret-not-for-mcp-output'
  let configureCalls = 0
  let settings = { version: 1, autoReconnect: false }
  let takeoverCalls = 0,
    failTakeoverPause = false
  try {
    // Electron launched with this script uses tests/ as its app path. Resolve
    // the installed project runtime explicitly, without requiring a shell env.
    process.env.UXPLAY_MINI_BINARY = await findRuntime({
      appPath: project,
      resourcesPath: process.resourcesPath,
      packaged: false,
      override: process.env.UXPLAY_MINI_BINARY
    })
    const { build } = await import('vite')
    const { default: react } = await import('@vitejs/plugin-react')
    await build({
      configFile: false,
      root: project,
      plugins: [react()],
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: {
          entry: path.join(__dirname, 'electron-mcp-renderer.ts'),
          formats: ['es'],
          fileName: () => 'test.mjs',
          cssFileName: 'test'
        }
      }
    })
    // Compile the current preload into the temporary test folder, not project out/.
    await build({
      configFile: false,
      root: project,
      logLevel: 'warn',
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: {
          entry: path.join(project, 'src/preload/index.ts'),
          formats: ['cjs'],
          fileName: () => 'preload.cjs'
        },
        rollupOptions: { external: ['electron'] }
      }
    })
    await fs.writeFile(
      path.join(directory, 'index.html'),
      '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="./test.css"><div id="root"></div><script type="module" src="./test.mjs"></script>'
    )
    await app.whenReady()
    const state = await service.start(0)
    let sequence = 0
    async function rpc(name, args = {}) {
      const response = await fetch(state.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + state.token,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++sequence,
          method: 'tools/call',
          params: { name, arguments: args }
        })
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
      assert.ok(!reply.error, JSON.stringify(reply.error))
      return reply.result
    }
    const tool = async (name, args) => {
      const result = await rpc(name, args)
      assert.ok(!result.isError, JSON.stringify(result))
      return result
    }
    ipcMain.handle('storage:load', () => ({
      devices: {
        version: 1,
        groups: [],
        devices: [
          {
            id: 'test',
            name: 'MCP Test',
            host: 'test.invalid',
            port: 2786,
            groupId: null,
            accessToken: secret,
            airplay: { maxFps: 30, audioEnabled: true }
          }
        ]
      },
      settings
    }))
    ipcMain.handle('storage:save-devices', () => {})
    ipcMain.handle('storage:save-settings', (_event, value) => {
      settings = value
    })
    ipcMain.handle('devices:discover', () => [])
    ipcMain.handle('mcp:state', () => service.getState())
    ipcMain.handle('mcp:configure', async (_event, value) => {
      const config = validateMcpConfiguration(value, service.getState())
      configureCalls++
      const current = service.getState()
      bridge.cancelAll()
      await service.stop()
      service.configureInactive(config.port, current.token, current.paused, config.host)
      const result = config.enabled
        ? await service.start(config.port, current.token, current.paused, config.host)
        : service.getState()
      Object.assign(state, result)
      return result
    })
    ipcMain.handle('mcp:set-paused', (_event, paused) => service.setPaused(paused))
    ipcMain.handle('mcp:manual-takeover', () => {
      takeoverCalls++
      if (failTakeoverPause) throw new Error('Simulated failure to pause')
      const state = service.getState()
      return !state.enabled || state.paused ? state : service.setPaused(true)
    })
    ipcMain.on('mcp:ready', (event) => bridge.ready(event.sender))
    ipcMain.on('mcp:reply', (event, reply) => bridge.reply(event.sender, reply))
    service.on('state', (state) => {
      if (window && !window.isDestroyed()) window.webContents.send('mcp:state', state)
    })
    ipcMain.handle('airplay:start', (event, name, config) =>
      airplay.start(name, config, event.sender)
    )
    ipcMain.handle('airplay:stop', () => airplay.stop())
    ipcMain.handle('airplay:restart', (_event, config) => airplay.restart(config))
    ipcMain.on('airplay:renderer-log', (_event, message) => logs.push(message))
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      webPreferences: {
        preload: path.join(directory, 'preload.cjs'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
        offscreen: true,
        autoplayPolicy: 'no-user-gesture-required',
        partition: 'mcp-test'
      }
    })
    bridge.attach(window.webContents)
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => {
      if (channel === 'airplay:log') logs.push(args[0])
      return send(channel, ...args)
    }
    window.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') errors.push(message)
    })
    await window.loadFile(path.join(directory, 'index.html'))
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(
      () => js('!!document.querySelector(".device-content")'),
      'real App and storage ready'
    )
    await until(
      () => js(`!!document.querySelector('.device-header button[aria-label="暂停 AI 访问"]')`),
      'MCP pause button is visible in the device toolbar even before AI calls'
    )
    assert.equal(
      await js(`(() => {
      const header = document.querySelector('.device-header')
      const buttons = [...header.querySelectorAll('button')]
      const stop = buttons.findIndex(button => button.getAttribute('aria-label') === '暂停 AI 访问')
      const edit = buttons.findIndex(button => button.getAttribute('aria-label') === '编辑设备')
      return stop >= 0 && edit === stop + 1 && !header.textContent.includes('http://') &&
        buttons[stop].textContent.trim() === '' && !!buttons[stop].querySelector('svg.tabler-icon-robot') &&
        buttons[stop].getAttribute('aria-pressed') === 'false'
    })()`),
      true,
      'pause button must be immediately left of Edit Device without an MCP address'
    )
    const listed = await tool('list_devices')
    assert.ok(!JSON.stringify(listed).includes(secret), 'device token must not be exposed to MCP')
    await tool('connect_device', { deviceId: 'test' })
    await until(
      () => logs.some((line) => /listening on TCP/.test(line)),
      'Release receiver listening'
    )
    await until(
      () => settings.autoPauseAiOnCapture === false,
      'manual-takeover auto pause defaults to off'
    )
    await js(`document.querySelector('.preview-surface').click()`)
    await until(
      () => js('!!document.pointerLockElement'),
      'default manual capture acquires pointer lock without prompting'
    )
    assert.equal(await js('!!document.querySelector("[role=dialog]")'), false)
    assert.equal(takeoverCalls, 0)
    assert.equal(service.getState().paused, false)
    await js('document.exitPointerLock()')
    await sleep(350)
    await tool('update_settings', { muted: true })
    const videoPort = Number(
      logs.find((line) => line.startsWith('Video RTP/RTCP')).match(/:(\d+)/)[1]
    )
    const audioPort = Number(
      logs.find((line) => line.startsWith('Audio L16 RTP/RTCP')).match(/:(\d+)/)[1]
    )
    let videoSequence = 0,
      videoTimestamp = 90000
    const sendFrame = () => {
      sender.send(
        rtp(96, videoSequence++, videoTimestamp, Buffer.from([0x67, 0x64, 0, 0x1f]), false),
        videoPort,
        '127.0.0.1'
      )
      sender.send(
        rtp(96, videoSequence++, videoTimestamp, Buffer.from([0x68, 0x80]), false),
        videoPort,
        '127.0.0.1'
      )
      sender.send(
        rtp(96, videoSequence++, videoTimestamp, Buffer.from([0x65, 0x80])),
        videoPort,
        '127.0.0.1'
      )
      videoTimestamp += 3000
    }
    sendFrame()
    await until(
      () => js('document.querySelector(".preview-video")?.height === 800'),
      'phone frame decoded'
    )
    const image = await tool('screenshot', { maxWidth: 200, maxAgeMs: 10000 })
    const png = image.content.find((item) => item.type === 'image')
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(png.data, 'base64')).getSize(), {
      width: 200,
      height: 400
    })
    assert.equal(
      JSON.parse(image.content.find((item) => item.type === 'text').text).sourceWidth,
      400
    )
    console.log(
      'PASS: MCP HTTP -> real main/preload/App bridge -> phone-only screenshot with correct native/image coordinates'
    )
    const firstTiming = JSON.parse(image.content.find((item) => item.type === 'text').text)
    assert.ok(firstTiming.returnedAt >= firstTiming.requestedAt)
    assert.ok(firstTiming.frameAgeMs >= 0)
    const nextScreenshot = tool('screenshot', {
      settleMs: 0,
      maxAgeMs: 10000,
      afterCapturedAt: firstTiming.capturedAt
    })
    await sleep(100)
    sendFrame()
    const nextTiming = JSON.parse(
      (await nextScreenshot).content.find((item) => item.type === 'text').text
    )
    assert.ok(nextTiming.capturedAt > firstTiming.capturedAt)
    const noNewFrame = await rpc('screenshot', {
      settleMs: 0,
      afterCapturedAt: Date.now() + 10000
    })
    assert.equal(noNewFrame.isError, true)
    assert.match(noNewFrame.content[0].text, /No newer phone frame/)
    await tool('pointer_configure', { width: 80, height: 160 })
    await tool('pointer_move', { x: 0.5, y: 0.5 })
    await tool('screenshot', { settleMs: 0, maxAgeMs: 10000 })
    const beforeClick = await js('window.mcpTest.messages.length')
    await tool('pointer_click')
    const clickMessages = await js(`window.mcpTest.messages.slice(${beforeClick})`)
    assert.ok(!clickMessages.some((message) => message.type === 'mouse_move'))
    assert.ok(clickMessages.some((message) => message.type === 'mouse_button' && message.pressed))
    assert.equal((await rpc('pointer_click')).isError, true)
    console.log(
      'PASS: newer-frame screenshot waits/timeouts and prepared click without pointer movement'
    )
    sendFrame()
    await tool('tap', { x: 0.5, y: 0.5 })
    const messages = await js('window.mcpTest.messages')
    assert.ok(messages.some((message) => message.type === 'mouse_move' && message.x === -127))
    assert.ok(
      messages.some((message) => message.type === 'mouse_button' && message.pressed === true)
    )
    assert.ok(messages.some((message) => message.type === 'ping'))
    await tool('key_press', { usages: [227, 11] })
    await tool('type_text', { text: 'Test 123!' })
    const unsupported = await rpc('type_text', { text: '中文' })
    assert.equal(unsupported.isError, true)
    await js(
      `document.querySelector('.preview-surface').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))`
    )
    const manual = await rpc('key_press', { usages: [5] })
    assert.equal(manual.isError, true)
    assert.match(manual.content[0].text, /Manual/)
    await js(
      `document.querySelector('.preview-surface').dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }))`
    )
    await sleep(350)
    console.log(
      'PASS: MCP pointer calibration/homing/tap and HID keyboard use the existing controller lease and acknowledged command ordering'
    )
    const recording = tool('capture_audio', { durationMs: 100 })
    await sleep(100)
    let audioSequence = 0
    for (let tick = 0; tick < 8; tick++) {
      const samples = Buffer.alloc(294 * 4)
      for (let i = 0; i < 294; i++) {
        samples.writeInt16BE(12000, i * 4)
        samples.writeInt16BE(-12000, i * 4 + 2)
      }
      for (let part = 0; part < 3; part++)
        sender.send(
          rtp(97, audioSequence++, 44100 + tick * 882 + part * 294, samples),
          audioPort,
          '127.0.0.1'
        )
      await sleep(20)
    }
    const audio = await recording
    const bytes = Buffer.from(audio.content.find((item) => item.type === 'audio').data, 'base64')
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.ok(bytes.readInt16LE(44) > 0)
    assert.equal(bytes.readUInt32LE(24), 44100)
    console.log(
      'PASS: MCP audio captures actual L16 RTP from production AirplayService, including while local playback is muted'
    )
    const stop = await tool('release_all')
    assert.ok(!stop.isError)
    const beforeGesture = await js('window.mcpTest.messages.length')
    const gesture = rpc('long_press', { x: 0.5, y: 0.5, durationMs: 3000 }).catch(() => undefined)
    await until(
      () =>
        js(
          `window.mcpTest.messages.slice(${beforeGesture}).some(message => message.type === 'mouse_button' && message.pressed)`
        ),
      'long press held before human pause'
    )
    await js(`document.querySelector('button[aria-label="暂停 AI 访问"]').click()`)
    assert.equal((await gesture).isError, true)
    await until(
      () => js(`window.mcpTest.messages.slice(${beforeGesture}).at(-1)?.type === 'release_all'`),
      'human pause releases held input through the real IPC bridge'
    )
    assert.equal(service.getState().enabled, true)
    assert.equal(service.getState().paused, true)
    assert.equal(service.getState().url, state.url)
    assert.equal(service.getState().token, state.token)
    assert.equal(configureCalls, 0, 'pausing must not invoke the MCP settings switch')
    for (const name of ['get_status', 'screenshot', 'capture_audio']) {
      const paused = await rpc(name)
      assert.equal(paused.isError, true)
      assert.match(paused.content[0].text, /paused by the user/)
    }
    await until(
      () =>
        js(
          `document.querySelector('.device-header button[aria-label="恢复 AI 访问"]')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('.device-header button[aria-label="恢复 AI 访问"] svg.tabler-icon-robot-off')`
        ),
      'resume button remains visible while paused'
    )
    await js(`document.querySelector('button[aria-label="恢复 AI 访问"]').click()`)
    await until(
      () => service.getState().paused === false,
      'AI access resumed without restarting MCP'
    )
    const resumedPointer = await tool('pointer_status')
    assert.equal(
      resumedPointer.structuredContent.result.position,
      null,
      'resume must not reuse the old cursor position'
    )
    await tool('key_press', { usages: [4] })
    assert.equal(service.getState().enabled, true)
    assert.equal(configureCalls, 0, 'resuming must not invoke the MCP settings switch')
    // Exercise the actual Settings control and pre-lock confirmation, not just a
    // callback or a manually injected capture-state event.
    const openSettings = async () => {
      await js(`document.querySelector('button[aria-label="设置"]').click()`)
      await until(
        () =>
          js(
            `[...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === '设置')`
          ),
        'Settings menu'
      )
      await js(
        `[...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '设置').click()`
      )
      await until(
        () => js(`!!document.querySelector('input[aria-label="人工接管时自动暂停 AI 访问"]')`),
        'manual takeover preference'
      )
    }
    const backToDevice = async () => {
      await js(
        `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '返回设备').click()`
      )
      await until(() => js('!!document.querySelector(".preview-surface")'), 'preview restored')
    }
    const dialogAction = async (text) => {
      await js(
        `[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`
      )
    }
    await openSettings()
    assert.equal(
      await js(`document.querySelector('input[aria-label="人工接管时自动暂停 AI 访问"]').checked`),
      false
    )
    assert.equal(
      await js(`(() => {
        const card = document.querySelector('input[aria-label="人工接管时自动暂停 AI 访问"]').closest('.utility-card')
        return card.textContent.includes('AI 控制 / MCP') && !!card.querySelector('input[aria-label="AI 控制 / MCP"]')
      })()`),
      true,
      'manual-takeover preference must be inside the AI control / MCP card'
    )
    await js(`document.querySelector('input[aria-label="人工接管时自动暂停 AI 访问"]').click()`)
    await until(() => settings.autoPauseAiOnCapture === true, 'auto pause preference saved')
    await backToDevice()
    const requests = await js('window.mcpTest.lockRequests')
    await js(`document.querySelector('.preview-surface').click()`)
    await until(
      () => js('!!document.querySelector("[role=dialog]")'),
      'takeover warning before pointer lock'
    )
    assert.equal(await js('window.mcpTest.lockRequests'), requests)
    assert.equal(service.getState().paused, false)
    await js(`document.querySelector('[role="dialog"] input[type="checkbox"]').click()`)
    await dialogAction('取消')
    await until(() => js('!document.querySelector("[role=dialog]")'), 'cancel warning')
    assert.equal(settings.hideAiTakeoverNotice, false, 'cancel must not remember the checkbox')
    assert.equal(takeoverCalls, 0)
    assert.equal(await js('document.pointerLockElement'), null)

    await js(`window.mcpTest.failLock = true; document.querySelector('.preview-surface').click()`)
    await until(
      () => js('!!document.querySelector("[role=dialog]")'),
      'warning still shown after cancel'
    )
    assert.equal(
      await js(`document.querySelector('[role="dialog"] input[type="checkbox"]').checked`),
      false
    )
    await dialogAction('继续并接管')
    await until(
      () => js('!document.querySelector("[role=dialog]")'),
      'warning closed after denied pointer lock'
    )
    assert.equal(service.getState().paused, false)
    assert.equal(takeoverCalls, 0, 'a denied pointer lock must not pause AI')
    await js(`window.mcpTest.failLock = false; document.querySelector('.preview-surface').click()`)
    await until(() => js('!!document.querySelector("[role=dialog]")'), 'takeover confirmation')
    await js(`document.querySelector('[role="dialog"] input[type="checkbox"]').click()`)
    const beforeCapture = await js('window.mcpTest.messages.length')
    await sleep(350) // Allow the manual-input grace period after navigating back.
    const activeAi = rpc('key_press', { usages: [4], durationMs: 2000 })
    await until(
      () =>
        js(
          `window.mcpTest.messages.slice(${beforeCapture}).some(message => message.type === 'key' && message.action === 'down')`
        ),
      'AI key held before manual takeover'
    )
    await dialogAction('继续并接管')
    await until(() => service.getState().paused === true, 'manual capture pauses AI')
    assert.equal((await activeAi).isError, true)
    assert.equal(await js('!!document.pointerLockElement'), true)
    await until(() => settings.hideAiTakeoverNotice === true, 'do-not-remind preference saved')
    await until(
      () => js('!document.querySelector("[role=dialog]")'),
      'confirmed warning finishes its close transition'
    )
    assert.equal(service.getState().enabled, true)
    assert.equal(configureCalls, 0)
    assert.equal((await rpc('screenshot')).isError, true)
    await js('document.exitPointerLock()')
    assert.equal(
      service.getState().paused,
      true,
      'leaving manual capture never silently resumes AI'
    )
    await until(
      () => js(`!!document.querySelector('.device-header button[aria-label="恢复 AI 访问"]')`),
      'manual resume action'
    )
    await js(`document.querySelector('.device-header button[aria-label="恢复 AI 访问"]').click()`)
    await until(() => !service.getState().paused, 'resumed before remembered capture')
    const previousTakeovers = takeoverCalls
    await js(`document.querySelector('.preview-surface').click()`)
    await until(
      () => service.getState().paused && takeoverCalls > previousTakeovers,
      'remembered capture skips warning but still pauses AI'
    )
    assert.equal(await js('!!document.querySelector("[role=dialog]")'), false)
    await js('document.exitPointerLock()')

    service.setPaused(false)
    const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.reload()
    await loaded
    await until(
      () => js('!!document.querySelector(".device-content")'),
      'App reloaded with saved preferences'
    )
    await tool('connect_device', { deviceId: 'test' })
    await openSettings()
    assert.equal(
      await js(`document.querySelector('input[aria-label="人工接管时自动暂停 AI 访问"]').checked`),
      true,
      'auto pause survives reload'
    )
    await backToDevice()
    failTakeoverPause = true
    await js(`document.querySelector('.preview-surface').click()`)
    await until(
      () =>
        js(
          `!document.pointerLockElement && document.body.textContent.includes('未能暂停 AI 访问')`
        ),
      'pause failure releases pointer lock'
    )
    assert.equal(service.getState().paused, false)
    assert.equal(
      await js('!!document.querySelector("[role=dialog]")'),
      false,
      'do-not-remind survives reload'
    )
    failTakeoverPause = false
    await service.stop()
    await js(`document.querySelector('.preview-surface').click()`)
    await until(
      () => js('!!document.pointerLockElement'),
      'capture still works when MCP is disabled'
    )
    assert.equal(service.getState().enabled, false, 'manual capture must not enable MCP')
    await js('document.exitPointerLock()')
    console.log(
      'PASS: default-off auto pause; pre-lock warning/cancel; denied lock; active-input cancellation; remembered warning/preferences after reload; failure releases lock; disabled MCP stays off'
    )
    console.log(
      'PASS: manual takeover; toolbar pause cancels/releases and blocks media/input; resume keeps the MCP switch, endpoint and token unchanged'
    )
    await openSettings()
    const changeInput = async (label, value) => {
      await js(`(() => {
        const input = document.querySelector('input[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
    }
    const saveListener = async () => {
      await until(
        () =>
          js(
            `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存监听设置' && !b.disabled)`
          ),
        'listener settings editable'
      )
      await js(
        `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存监听设置').click()`
      )
    }
    const waitDialog = () =>
      until(() => js('!!document.querySelector("[role=dialog]")'), 'listener confirmation')
    const closedDialog = () =>
      until(() => js('!document.querySelector("[role=dialog]")'), 'listener dialog closed')
    assert.equal(
      await js(`document.querySelector('input[aria-label="监听地址"]').value`),
      '127.0.0.1'
    )
    const token = service.getState().token
    await changeInput('监听地址', '0.0.0.0')
    await saveListener()
    await waitDialog()
    assert.match(await js('document.querySelector("[role=dialog]").textContent'), /HTTP 未加密/)
    assert.equal(configureCalls, 0, 'remote warning must precede any configuration write')
    await dialogAction('取消')
    await closedDialog()
    assert.equal(service.getState().host, '127.0.0.1')
    await saveListener()
    await waitDialog()
    await dialogAction('确认更改')
    await until(() => service.getState().host === '0.0.0.0', 'remote address saved while MCP off')
    await closedDialog()
    assert.equal(service.getState().enabled, false)
    assert.equal(service.getState().token, token)
    await changeInput('监听地址', '127.0.0.1')
    await saveListener()
    await until(() => service.getState().host === '127.0.0.1', 'return to loopback without warning')
    assert.equal(await js('!!document.querySelector("[role=dialog]")'), false)

    Object.assign(state, await service.start(0, token, true))
    await until(
      () =>
        js(
          `document.querySelector('input[aria-label="端口"]').value === ${JSON.stringify(String(state.port))}`
        ),
      'running listener settings synchronized'
    )
    // Reserve and release an ephemeral port rather than assuming the next port is free.
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const newPort = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const oldUrl = state.url
    const callsBeforeRestart = configureCalls
    await changeInput('端口', newPort)
    await saveListener()
    await waitDialog()
    assert.match(
      await js('document.querySelector("[role=dialog]").textContent'),
      /不会重启 AirPlay/
    )
    assert.equal(configureCalls, callsBeforeRestart)
    await dialogAction('取消')
    await closedDialog()
    assert.equal(service.getState().url, oldUrl)
    assert.equal(
      (await rpc('get_status')).isError,
      true,
      'old paused listener remains usable after cancel'
    )
    await saveListener()
    await waitDialog()
    await dialogAction('确认并重启')
    await until(
      () => service.getState().enabled && service.getState().port === newPort,
      'MCP restarted on new port'
    )
    await closedDialog()
    assert.equal(service.getState().paused, true)
    assert.equal(service.getState().token, token)
    assert.equal(configureCalls, callsBeforeRestart + 1)
    assert.equal((await rpc('get_status')).isError, true)
    await assert.rejects(fetch(oldUrl))

    await changeInput('监听地址', '0.0.0.0')
    await saveListener()
    await waitDialog()
    const warning = await js('document.querySelector("[role=dialog]").textContent')
    assert.match(warning, /HTTP 未加密/)
    assert.match(warning, /需要重启 MCP/)
    await dialogAction('确认并重启')
    await until(
      () => service.getState().enabled && service.getState().host === '0.0.0.0',
      'remote listener confirmed and restarted'
    )
    await closedDialog()
    assert.equal(service.getState().paused, true)
    assert.equal(service.getState().token, token)
    assert.equal((await rpc('get_status')).isError, true)

    // Invalid unsaved drafts cannot prevent an immediate shutdown.
    await changeInput('监听地址', 'invalid.example')
    await js(`document.querySelector('input[aria-label="AI 控制 / MCP"]').click()`)
    await until(() => !service.getState().enabled, 'switch disables even with an invalid draft')
    assert.equal(service.getState().host, '0.0.0.0')
    assert.equal(await js('!!document.querySelector("[role=dialog]")'), false)
    console.log(
      'PASS: icon-only pause/resume; editable listener; remote warning; cancel preserves listener; confirmed address/port restart preserves pause/token; shutdown ignores unsaved drafts'
    )
    assert.deepEqual(
      errors.filter((error) => !/Content-Security-Policy/.test(error)),
      [],
      'renderer error'
    )
    console.log(
      'PASS: automated MCP end-to-end validation complete (simulated board/cursor and video decoder; no real phone input)'
    )
  } catch (error) {
    console.error('MCP integration diagnostics:', { airplay: airplay.getState(), logs, errors })
    throw error
  } finally {
    bridge.cancelAll()
    await service.stop()
    await airplay.stop()
    airplay.dispose()
    sender.close()
    window?.destroy()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
run().then(
  () => {
    clearTimeout(watchdog)
    app.exit(0)
  },
  (error) => {
    console.error(error)
    clearTimeout(watchdog)
    app.exit(1)
  }
)
