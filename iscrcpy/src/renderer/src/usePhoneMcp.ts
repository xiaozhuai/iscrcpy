import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { AirPlayMirror } from './useAirPlayMirror'
import type { useDeviceSession } from './useDeviceSession'
import type { Device, LibraryState, Locale, Target } from './types'
import { PhoneInput } from './phoneInput'
import { DEFAULT_AIRPLAY_CONFIG, normalizeAirplayConfig } from '../../shared/airplay'

interface Options {
  storageReady: boolean
  library: LibraryState
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  selectedId: string | null
  select(id: string): void
  connect(id: string): void
  session: ReturnType<typeof useDeviceSession>
  mirror: AirPlayMirror
  target: Target
  setTarget(value: Target): void
  locale: Locale
  setLocale(value: Locale): void
  autoReconnect: boolean
  setAutoReconnect(value: boolean): void
  reconnectInterval: number
  setReconnectInterval(value: number): void
  muted: boolean
  setMuted(value: boolean): void
  manual: boolean
  isManualBusy(): boolean
  airplayLogs: string[]
  controllerRef: RefObject<PhoneInput | null>
  profiles: unknown[]
  saveProfiles(value: unknown[]): void
}

const publicDevice = (device: Device): Omit<Device, 'accessToken'> => {
  return {
    id: device.id,
    name: device.name,
    host: device.host,
    port: device.port,
    groupId: device.groupId,
    airplay: device.airplay
  }
}

export function usePhoneMcp(options: Options): void {
  const current = useRef(options)
  // A frame belongs to the controller connection that started this receiver.
  // Never operate a newly selected phone using the previous phone's pixels.
  const sessionKey = `${options.selectedId}:${options.session.isConnected}`
  const mediaOwner = useRef({ pid: options.mirror.state.pid, sessionKey })
  const currentFrame = (): ReturnType<AirPlayMirror['frameInfo']> => {
    const o = current.current
    return o.session.isConnected &&
      mediaOwner.current.sessionKey === `${o.selectedId}:${o.session.isConnected}` &&
      mediaOwner.current.pid !== null
      ? o.mirror.frameInfo()
      : null
  }
  const input = useRef<PhoneInput | null>(null)
  input.current ??= new PhoneInput({
    context: () => {
      const o = current.current,
        s = o.session,
        frame = currentFrame()
      const actual =
        o.target === 'usb' || (o.target === 'usb_preferred' && s.usbConnected) ? 'usb' : 'ble'
      return {
        key: `${o.selectedId}:${actual}`,
        connected: s.isConnected,
        ready: actual === 'usb' ? s.usbConnected === true : s.bleConnected === true,
        manual: o.manual || o.isManualBusy(),
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        target: o.target
      }
    },
    send: (message) => current.current.session.send(message),
    flush: () => current.current.session.flush()
  })
  const { controllerRef } = options
  useLayoutEffect(() => {
    current.current = options
    if (mediaOwner.current.pid !== options.mirror.state.pid)
      mediaOwner.current = { pid: options.mirror.state.pid, sessionKey }
    controllerRef.current = input.current
  })
  useEffect(() => {
    input.current?.loadProfiles(options.profiles)
  }, [options.profiles])
  useEffect(() => {
    input.current?.invalidate()
  }, [
    options.selectedId,
    options.session.phase,
    options.session.usbConnected,
    options.session.bleConnected,
    options.target,
    options.manual,
    options.mirror.videoSize?.width,
    options.mirror.videoSize?.height
  ])

  useEffect(() => {
    const api = window.api.mcp
    if (!api) return
    const pending = new Map<string, AbortController>()
    const pause = (ms: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted()
      return new Promise((resolve, reject) => {
        const cancel = (): void => {
          clearTimeout(timer)
          reject(new Error('MCP operation cancelled'))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', cancel)
          resolve()
        }, ms)
        signal.addEventListener('abort', cancel, { once: true })
      })
    }
    const waitFor = async (check: () => boolean, signal: AbortSignal): Promise<void> => {
      const deadline = Date.now() + 8000
      while (!check()) {
        signal.throwIfAborted()
        if (Date.now() > deadline)
          throw new Error(
            'Device state did not become ready within 8 seconds; inspect get_status/get_logs'
          )
        await pause(25, signal)
      }
    }
    const execute = async (
      method: string,
      p: Record<string, unknown>,
      signal: AbortSignal
    ): Promise<unknown> => {
      const o = current.current
      if (!o.storageReady) throw new Error('Desktop storage is still loading')
      const device = o.library.devices.find((device) => device.id === o.selectedId)
      const settings = (): Record<string, unknown> => ({
        target: o.target,
        locale: o.locale,
        autoReconnect: o.autoReconnect,
        reconnectIntervalSeconds: o.reconnectInterval,
        muted: o.muted
      })
      if (method === 'get_settings') return settings()
      if (method === 'get_status')
        return {
          device: device ? publicDevice(device) : null,
          controller: {
            phase: o.session.phase,
            usbConnected: o.session.usbConnected,
            bleConnected: o.session.bleConnected,
            latency: o.session.latency,
            firmwareVersion: o.session.firmwareVersion,
            protocolVersion: o.session.protocolVersion
          },
          airplay: o.mirror.state,
          frame: currentFrame(),
          pointer: input.current!.status(),
          settings: settings()
        }
      if (method === 'list_devices')
        return { groups: o.library.groups, devices: o.library.devices.map(publicDevice) }
      if (method === 'discover_devices') return window.api.discoverDevices()
      if (method === 'select_device' || method === 'connect_device') {
        const id = typeof p.deviceId === 'string' ? p.deviceId : o.selectedId
        if (!id || !o.library.devices.some((device) => device.id === id))
          throw new Error('Unknown device ID')
        input.current!.invalidate()
        if (method === 'connect_device') o.connect(id)
        else o.select(id)
        await waitFor(
          () =>
            current.current.selectedId === id &&
            (method === 'select_device' || current.current.session.isConnected),
          signal
        )
        return { selectedDeviceId: id, connected: current.current.session.isConnected }
      }
      if (method === 'disconnect_device') {
        input.current!.invalidate()
        o.session.disconnect()
        await window.api.airplay.stop()
        await waitFor(() => !current.current.session.isConnected, signal)
        return { disconnected: true }
      }
      if (method === 'upsert_device') {
        const existing = o.library.devices.find((device) => device.id === p.id)
        if (p.id && !existing) throw new Error('Unknown device ID')
        if (existing?.id === o.selectedId && o.session.phase !== 'disconnected')
          throw new Error('Disconnect before editing the active device')
        const host = String(p.host).trim()
        if (!/^[A-Za-z0-9.-]+$/.test(host))
          throw new Error('Host must be a DNS name or IPv4 address, without URL syntax')
        const accessToken =
          p.accessToken === undefined ? (existing?.accessToken ?? '') : String(p.accessToken)
        if (accessToken && !/^[\x21-\x7e]{16,128}$/.test(accessToken))
          throw new Error(
            'Device access token must be 16..128 non-space ASCII characters, or empty'
          )
        const groupId =
          p.groupId === undefined ? (existing?.groupId ?? null) : (p.groupId as string | null)
        if (groupId && !o.library.groups.some((group) => group.id === groupId))
          throw new Error('Unknown group ID')
        const next: Device = {
          id: existing?.id ?? crypto.randomUUID(),
          name: String(p.name),
          host,
          port: Number(p.port),
          accessToken,
          groupId,
          airplay: existing?.airplay ?? { ...DEFAULT_AIRPLAY_CONFIG }
        }
        o.setLibrary((library) => ({
          ...library,
          devices: existing
            ? library.devices.map((device) => (device.id === next.id ? next : device))
            : [...library.devices, next]
        }))
        return publicDevice(next)
      }
      if (method === 'remove_device') {
        if (!o.library.devices.some((device) => device.id === p.deviceId))
          throw new Error('Unknown device ID')
        if (o.selectedId === p.deviceId && o.session.phase !== 'disconnected')
          throw new Error('Disconnect before deleting the active device')
        o.setLibrary((library) => ({
          ...library,
          devices: library.devices.filter((device) => device.id !== p.deviceId)
        }))
        return { removed: p.deviceId }
      }
      if (method === 'manage_group') {
        const group = o.library.groups.find((group) => group.id === p.id)
        if (p.action !== 'create' && !group) throw new Error('Unknown group ID')
        if (p.action !== 'delete' && !p.name) throw new Error('Group name is required')
        const id = group?.id ?? crypto.randomUUID()
        o.setLibrary((library) => ({
          groups:
            p.action === 'delete'
              ? library.groups.filter((group) => group.id !== id)
              : p.action === 'create'
                ? [...library.groups, { id, name: String(p.name) }]
                : library.groups.map((group) =>
                    group.id === id ? { id, name: String(p.name) } : group
                  ),
          devices:
            p.action === 'delete'
              ? library.devices.map((device) =>
                  device.groupId === id ? { ...device, groupId: null } : device
                )
              : library.devices
        }))
        return { id, action: p.action }
      }
      if (method === 'update_settings') {
        if (p.target !== undefined) {
          input.current!.invalidate()
          o.session.send({ type: 'release_all', target: o.target })
          o.setTarget(p.target as Target)
        }
        if (p.locale !== undefined) o.setLocale(p.locale as Locale)
        if (p.autoReconnect !== undefined) o.setAutoReconnect(Boolean(p.autoReconnect))
        if (p.reconnectIntervalSeconds !== undefined)
          o.setReconnectInterval(Number(p.reconnectIntervalSeconds))
        if (p.muted !== undefined) o.setMuted(Boolean(p.muted))
        return { updated: Object.keys(p) }
      }
      if (method === 'get_logs') {
        const logs = p.kind === 'airplay' ? o.airplayLogs : o.session.logs
        return logs
          .slice(-Number(p.limit))
          .map((line) =>
            o.library.devices.reduce(
              (text, device) =>
                device.accessToken ? text.replaceAll(device.accessToken, '[REDACTED]') : text,
              line
            )
          )
      }
      if (method.startsWith('airplay_')) {
        if (!device) throw new Error('Select a device first')
        if (method === 'airplay_configure') {
          const config = normalizeAirplayConfig({ ...device.airplay, ...p })
          o.setLibrary((library) => ({
            ...library,
            devices: library.devices.map((item) =>
              item.id === device.id ? { ...item, airplay: config } : item
            )
          }))
          return {
            saved: config,
            applied: false,
            note: 'Applies at next receiver start; restarting disconnects iPhone.'
          }
        }
        input.current!.invalidate()
        if (method === 'airplay_stop') {
          await window.api.airplay.stop()
          return { stopped: true }
        }
        if (!o.session.isConnected)
          throw new Error('Connect the controller before starting AirPlay')
        return method === 'airplay_restart'
          ? window.api.airplay.restart(device.airplay)
          : window.api.airplay.start(device.name, device.airplay)
      }
      if (method === 'screenshot') {
        const requestedAt = Date.now()
        const receiverPid = o.mirror.state.pid
        const assertSession = (): void => {
          if (
            o.selectedId !== current.current.selectedId ||
            receiverPid !== current.current.mirror.state.pid
          )
            throw new Error('Phone session changed while capturing; inspect get_status and retry')
          if (!currentFrame())
            throw new Error(
              'No phone frame belongs to this controller connection; reconnect AirPlay first'
            )
        }
        await pause(Number(p.settleMs ?? 300), signal)
        assertSession()
        if (p.afterCapturedAt !== undefined) {
          const deadline = Date.now() + 2000
          while (currentFrame()!.capturedAt <= Number(p.afterCapturedAt)) {
            if (Date.now() >= deadline)
              throw new Error(
                'No newer phone frame within 2 seconds; inspect AirPlay before retrying'
              )
            await pause(25, signal)
            assertSession()
          }
        }
        const frame = current.current.mirror.captureFrame(Number(p.maxWidth), Number(p.maxAgeMs))
        return {
          ...frame,
          requestedAt,
          returnedAt: Date.now(),
          frameAgeMs: Date.now() - frame.capturedAt
        }
      }
      if (method === 'pointer_status') return input.current!.status()
      if (method === 'release_all') {
        input.current!.invalidate()
        if (o.session.isConnected) {
          o.session.send({ type: 'release_all', target: o.target })
          await o.session.flush()
        }
        return { released: true }
      }
      if (method === 'key_press') {
        const keys = p.usages as number[]
        if (new Set(keys).size !== keys.length || keys.filter((key) => key < 0xe0).length > 6)
          throw new Error('A chord requires unique usages and at most 6 non-modifier keys')
      }
      if (method === 'scroll' && (p.x === undefined) !== (p.y === undefined))
        throw new Error('Scroll coordinates require both x and y')
      if (
        [
          'pointer_probe',
          'pointer_observe',
          'pointer_correct',
          'pointer_configure',
          'pointer_move',
          'pointer_click',
          'tap',
          'long_press',
          'swipe',
          'drag'
        ].includes(method) ||
        (method === 'scroll' && p.x !== undefined)
      ) {
        const frame = currentFrame()
        if (!frame || Date.now() - frame.capturedAt > 10000)
          throw new Error(
            'Coordinate input needs a fresh mirrored phone frame; connect AirPlay first'
          )
      }
      const result = await input.current!.execute(method, p, signal)
      if (method === 'pointer_observe' || method === 'pointer_configure')
        current.current.saveProfiles(input.current!.savedProfiles() as unknown[])
      return result
    }
    const removeRequest = api.onRequest((request) => {
      const controller = new AbortController()
      pending.set(request.id, controller)
      void execute(request.method, request.params, controller.signal)
        .then(
          (result) => {
            if (!controller.signal.aborted) api.reply({ id: request.id, result })
          },
          (error) => {
            if (!controller.signal.aborted)
              api.reply({
                id: request.id,
                error: error instanceof Error ? error.message : 'Operation failed'
              })
          }
        )
        .finally(() => pending.delete(request.id))
    })
    const removeCancel = api.onCancel((id) => {
      pending.get(id)?.abort()
      pending.delete(id)
    })
    const removeState = api.onState((state) => {
      if (!state.paused) return
      for (const controller of pending.values()) controller.abort()
      input.current?.invalidate()
    })
    api.ready()
    return () => {
      removeRequest()
      removeCancel()
      removeState()
      for (const controller of pending.values()) controller.abort()
      input.current?.invalidate()
    }
  }, [])
}
