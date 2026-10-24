// Real React application, Mantine styles, ResizeObserver and Electron geometry.
// Only the firmware/storage/media input is replaced by isolated fixtures.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const directory = mkdtempSync(join(tmpdir(), 'iscrcpy-layout-'))
mkdirSync(join(directory, 'user-data'))
app.setPath('userData', join(directory, 'user-data'))
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => app.exit(1), 30000)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, description) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error('Timed out: ' + description)
}

async function run() {
  let window
  try {
    const { build } = await import('vite')
    const { default: react } = await import('@vitejs/plugin-react')
    await build({
      configFile: false,
      root: resolve(__dirname, '..'),
      plugins: [react()],
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: {
          entry: join(__dirname, 'electron-layout-renderer.ts'),
          formats: ['es'],
          fileName: () => 'layout.mjs',
          cssFileName: 'layout'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="./layout.css"><div id="root"></div><script type="module" src="./layout.mjs"></script>'
    )
    await app.whenReady()
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'layout-test' }
    })
    const errors = []
    window.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') errors.push(message)
    })
    await window.loadFile(join(directory, 'index.html'))
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js('!!document.querySelector(".device-content")'), 'real app loaded')
    const geometry = () =>
      js(`(() => {
        const rect = selector => {
          const node = document.querySelector(selector)
          const r = node.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height,
            right: r.right, bottom: r.bottom,
            overflowX: node.scrollWidth - node.clientWidth }
        }
        return { sidebar: rect('.sidebar'), preview: rect('.preview-area'),
          surface: rect('.preview-surface'), panels: rect('.device-panels'),
          info: rect('.device-detail-section'), logs: rect('.device-log-section'),
          content: rect('.device-content'), probe: window.layoutTest.probe,
          detailsHeading: document.querySelector('.device-panels-header h2')?.textContent,
          detailsHeaderButtons: document.querySelectorAll('.device-panels-header button').length,
          sameCanvas: !window.originalCanvas ||
            window.originalCanvas === document.querySelector('.preview-video') }
      })()`)
    const assertPortrait = (value) => {
      assert.ok(value.sidebar.right <= value.preview.x + 1, 'device list is left of preview')
      assert.ok(value.preview.right <= value.panels.x + 1, 'details are right of preview')
      assert.ok(Math.abs(value.preview.y - value.panels.y) < 1, 'columns share the top edge')
      assert.ok(Math.abs(value.preview.height - value.panels.height) < 1, 'columns fill height')
      assert.ok(value.logs.y > value.info.y, 'logs stack below device info')
      assert.ok(value.preview.width > 150 && value.surface.height > 300, 'preview stays usable')
      assert.ok(value.panels.overflowX <= 1, 'right panel has no horizontal overflow')
    }
    assertPortrait(await geometry())
    await js(`Array.from(document.querySelectorAll('.device-header button'))
      .find(button => button.textContent.trim() === '连接').click()`)
    await until(() => js('window.layoutTest.probe.starts === 1'), 'isolated receiver started')
    await js('window.layoutTest.rotate(120, 260)')
    await until(
      () => js('document.querySelector(".preview-video").height === 260'),
      'portrait frame'
    )
    await js('window.originalCanvas = document.querySelector(".preview-video")')
    const initial = await geometry()
    assertPortrait(initial)
    for (const [width, height, portrait] of [
      [260, 120, false],
      [120, 260, true],
      [180, 180, false],
      [120, 260, true]
    ]) {
      await js(`window.layoutTest.rotate(${width}, ${height})`)
      await until(
        () =>
          js(`document.querySelector('.preview-video').width === ${width} &&
          document.querySelector('.device-content').classList.contains('device-content--portrait') === ${portrait}`),
        'orientation change'
      )
      await sleep(60) // Allow ResizeObserver and the resulting React sizing update.
      const current = await geometry()
      assert.equal(current.detailsHeading, '设备信息', 'details use a static heading')
      assert.equal(current.detailsHeaderButtons, 0, 'details have no collapse button')
      assert.ok(current.info.height > 0 && current.logs.height > 0, 'details stay expanded')
      if (portrait) assertPortrait(current)
      else {
        assert.ok(current.preview.bottom <= current.panels.y + 1, 'landscape details stay below')
        assert.ok(Math.abs(current.preview.x - current.panels.x) < 1, 'landscape spans workspace')
      }
      assert.ok(
        Math.abs(current.surface.width / current.surface.height - width / height) < 0.01,
        'preview preserves decoded aspect ratio'
      )
      assert.ok(current.sameCanvas, 'rotation must not remount the player canvas')
      assert.deepEqual(
        current.probe,
        { ...initial.probe, width, height },
        'no receiver/decoder restart'
      )
      assert.ok(current.surface.right <= current.preview.right + 1, 'preview fits horizontally')
      assert.ok(current.surface.bottom <= current.preview.bottom + 1, 'preview fits vertically')
    }
    for (const [width, height] of [
      [820, 600],
      [1440, 900]
    ]) {
      window.setContentSize(width, height)
      await until(() => js(`innerWidth === ${width}`), 'window resized')
      await sleep(60)
      assertPortrait(await geometry())
      await js('window.layoutTest.rotate(260, 120)')
      await until(
        () =>
          js(
            '!document.querySelector(".device-content").classList.contains("device-content--portrait")'
          ),
        'landscape in resized window'
      )
      await sleep(60)
      const landscape = await geometry()
      assert.ok(landscape.preview.height > 100, 'landscape preview is not squeezed out')
      assert.ok(landscape.panels.bottom <= landscape.content.bottom + 1, 'details fit the window')
      assert.ok(landscape.surface.bottom <= landscape.preview.bottom + 1, 'preview fits height')
      await js('window.layoutTest.rotate(120, 260)')
      await until(
        () =>
          js(
            'document.querySelector(".device-content").classList.contains("device-content--portrait")'
          ),
        'portrait restored'
      )
      await sleep(60)
      assertPortrait(await geometry())
    }
    await js(`document.querySelectorAll('.device-row')[1].click()`)
    await until(
      () => js('document.querySelector(".device-header").textContent.includes("other")'),
      'device switch'
    )
    assertPortrait(await geometry())
    assert.deepEqual(errors, [], 'renderer must not log errors')
    console.log(
      'PASS: portrait three-column / landscape stacked layouts; live rotations without player restart; square frames; 820/1440px windows; device switch'
    )
  } finally {
    window?.destroy()
    await rm(directory, { recursive: true, force: true })
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
