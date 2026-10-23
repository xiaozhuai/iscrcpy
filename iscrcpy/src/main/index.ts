import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Bonjour, { type Browser, type Service } from 'bonjour-service'
import icon from '../../resources/icon.png?asset'
import { normalizeAirplayConfig } from '../shared/airplay'
import { AirplayService } from './airplay'

const storageFiles = {
  devices: 'devices.json',
  settings: 'settings.json'
} as const

let storageWriteQueue = Promise.resolve()
const airplayService = new AirplayService()

interface DiscoveredDevice {
  id: string
  name: string
  hostname: string
  addresses: string[]
  port: number
  firmwareVersion?: string
  protocolVersion?: number
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return undefined
}

function discoveredDevice(service: Service): DiscoveredDevice {
  const hostname = service.host.replace(/\.$/, '')
  const txt = service.txt ?? {}
  const protocolVersion = Number(textValue(txt.protocol_version))
  return {
    id: service.fqdn,
    name: textValue(txt.device_name) || service.name,
    hostname,
    addresses: (service.addresses ?? []).filter(
      (address) => !address.includes(':') && !address.startsWith('169.254.')
    ),
    port: service.port,
    firmwareVersion: textValue(txt.version),
    protocolVersion: Number.isInteger(protocolVersion) ? protocolVersion : undefined
  }
}

function discoverDevices(timeoutMs = 2200): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour()
    const found = new Map<string, DiscoveredDevice>()
    let browser: Browser | undefined
    let finished = false

    const finish = (): void => {
      if (finished) return
      finished = true
      browser?.stop()
      bonjour.destroy()
      resolve([...found.values()])
    }

    try {
      browser = bonjour.find({ type: 'iscrcpy-control', protocol: 'tcp' }, (service) => {
        const device = discoveredDevice(service)
        found.set(device.id, device)
      })
      setTimeout(finish, timeoutMs)
    } catch {
      finish()
    }
  })
}

function storagePath(filename: string): string {
  return join(app.getPath('userData'), filename)
}

async function backupInvalidFile(file: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    await rename(file, `${file}.corrupt-${timestamp}`)
  } catch {
    // The original read error is sufficient; never overwrite the invalid file in place.
  }
}

async function readStorageFile(filename: string): Promise<unknown | null> {
  const file = storagePath(filename)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    await backupInvalidFile(file)
    console.error(`Could not load ${file}`, error)
    return null
  }
}

function queueStorageWrite(filename: string, value: unknown): Promise<void> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Promise.reject(new TypeError('Storage value must be a JSON object'))
  }

  const write = async (): Promise<void> => {
    const file = storagePath(filename)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporary, file)
      await chmod(file, 0o600).catch(() => undefined)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  const queued = storageWriteQueue.then(write, write)
  storageWriteQueue = queued.catch(() => undefined)
  return queued
}

async function loadStorage(): Promise<{
  devices: unknown | null
  settings: unknown | null
}> {
  const [devices, settings] = await Promise.all([
    readStorageFile(storageFiles.devices),
    readStorageFile(storageFiles.settings)
  ])
  return { devices, settings }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f7',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#f7f8fa', symbolColor: '#30343b', height: 38 } }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('devices:discover', () => discoverDevices())
  ipcMain.handle('storage:load', () => loadStorage())
  ipcMain.handle('storage:save-devices', (_, value: unknown) =>
    queueStorageWrite(storageFiles.devices, value)
  )
  ipcMain.handle('storage:save-settings', (_, value: unknown) =>
    queueStorageWrite(storageFiles.settings, value)
  )
  ipcMain.handle('airplay:start', (event, deviceName: unknown, config: unknown) => {
    if (typeof deviceName !== 'string') throw new TypeError('Device name must be a string')
    return airplayService.start(deviceName, normalizeAirplayConfig(config), event.sender)
  })
  ipcMain.handle('airplay:stop', () => airplayService.stop())
  ipcMain.handle('airplay:restart', () => airplayService.restart())
  ipcMain.on('airplay:renderer-log', (_, message: unknown) => {
    if (typeof message === 'string') airplayService.reportRendererLog(message.slice(0, 500))
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  airplayService.dispose()
  app.quit()
})

app.on('before-quit', () => {
  airplayService.dispose()
})

process.once('exit', () => {
  airplayService.dispose()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
