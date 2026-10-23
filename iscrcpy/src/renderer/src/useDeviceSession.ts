import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import type { Device, Target } from './types'
import type { TranslationKey } from './i18n'

const PROTOCOL_VERSION = 1
const DEFAULT_RECONNECT_DELAY = 5000

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'incompatible'

interface SessionState {
  phase: ConnectionPhase
  reconnectPending: boolean
  usbConnected: boolean | null
  bleConnected: boolean | null
  latency: number | null
  firmwareVersion: string | null
  protocolVersion: number | null
  logs: string[]
}

interface DeviceSession extends SessionState {
  isConnected: boolean
  connect: () => void
  disconnect: () => void
  send: (message: Record<string, unknown>) => boolean
  appendLog: (message: string) => void
  clearLogs: () => void
}

type Translator = (key: TranslationKey, variables?: Record<string, string | number>) => string
type DeviceNameHandler = (deviceId: string, name: string) => void

const initialState: SessionState = {
  phase: 'disconnected',
  reconnectPending: false,
  usbConnected: null,
  bleConnected: null,
  latency: null,
  firmwareVersion: null,
  protocolVersion: null,
  logs: []
}

function endpoint(device: Device): string {
  return `ws://${device.host}:${device.port}/control`
}

export function useDeviceSession(
  selectedDevice: Device | undefined,
  t: Translator,
  onDeviceName?: DeviceNameHandler,
  autoReconnect = true,
  reconnectDelay = DEFAULT_RECONNECT_DELAY,
  inputTarget: Target = 'usb_preferred'
): DeviceSession {
  const [state, setState] = useState<SessionState>(initialState)
  const socketRef = useRef<WebSocket | null>(null)
  const deviceRef = useRef<Device | undefined>(selectedDevice)
  const reconnectRef = useRef<number | null>(null)
  const manualCloseRef = useRef(false)
  const authenticatedRef = useRef(false)
  const pingTimerRef = useRef<number | null>(null)
  const pingSequenceRef = useRef(0)
  const pingTimesRef = useRef(new Map<number, number>())
  const connectRef = useRef<() => void>(() => undefined)
  const translatorRef = useRef(t)
  const deviceNameHandlerRef = useRef(onDeviceName)
  const autoReconnectRef = useRef(autoReconnect)
  const reconnectDelayRef = useRef(reconnectDelay)
  const inputTargetRef = useRef(inputTarget)

  useEffect(() => {
    translatorRef.current = t
  }, [t])
  useEffect(() => {
    deviceNameHandlerRef.current = onDeviceName
  }, [onDeviceName])
  useEffect(() => {
    autoReconnectRef.current = autoReconnect
  }, [autoReconnect])
  useEffect(() => {
    reconnectDelayRef.current = reconnectDelay
  }, [reconnectDelay])
  useEffect(() => {
    inputTargetRef.current = inputTarget
  }, [inputTarget])

  const stopTimers = useCallback(() => {
    if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current)
    if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current)
    reconnectRef.current = null
    pingTimerRef.current = null
    pingTimesRef.current.clear()
  }, [])

  const send = useCallback((message: Record<string, unknown>): boolean => {
    const socket = socketRef.current
    if (!authenticatedRef.current || !socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  const scheduleReconnect = useCallback(() => {
    const device = deviceRef.current
    if (!device || !autoReconnectRef.current || reconnectRef.current !== null) return
    setState((current) => ({ ...current, reconnectPending: true }))
    notifications.show({
      message: translatorRef.current('reconnecting'),
      color: 'gray',
      autoClose: 1800
    })
    reconnectRef.current = window.setTimeout(() => {
      reconnectRef.current = null
      if (!autoReconnectRef.current) {
        setState((current) => ({ ...current, reconnectPending: false }))
        return
      }
      connectRef.current()
    }, reconnectDelayRef.current)
  }, [])

  const connect = useCallback(() => {
    const device = deviceRef.current
    if (!device || socketRef.current) return
    const host = device.host.trim()
    if (!host) return

    stopTimers()
    manualCloseRef.current = false
    authenticatedRef.current = false
    setState((current) => ({
      ...current,
      phase: 'connecting',
      reconnectPending: false,
      firmwareVersion: null,
      protocolVersion: null,
      logs: []
    }))

    let socket: WebSocket
    try {
      socket = new WebSocket(endpoint(device))
    } catch {
      setState((current) => ({ ...current, phase: 'disconnected', reconnectPending: false }))
      notifications.show({
        title: translatorRef.current('connectionFailed'),
        message: translatorRef.current('validationAddress'),
        color: 'red',
        icon: createElement(IconAlertTriangle, { size: 16 })
      })
      return
    }
    socketRef.current = socket
    let retryAllowed = true
    let protocolMismatch = false

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol_version: PROTOCOL_VERSION,
          access_token: device.accessToken
        })
      )
    })

    socket.addEventListener('message', (event) => {
      if (socketRef.current !== socket) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }

      if (message.type === 'hello') {
        const protocolVersion = Number(message.protocol_version)
        if (!Number.isInteger(protocolVersion) || protocolVersion !== PROTOCOL_VERSION) {
          retryAllowed = false
          protocolMismatch = true
          setState((current) => ({ ...current, phase: 'incompatible' }))
          notifications.show({
            title: translatorRef.current('incompatible'),
            message: translatorRef.current('protocolMismatch'),
            color: 'red',
            icon: createElement(IconAlertTriangle, { size: 16 })
          })
          return
        }
        authenticatedRef.current = true
        const firmwareVersion = typeof message.version === 'string' ? message.version : null
        const reportedDeviceName =
          typeof message.device_name === 'string' && message.device_name.trim()
            ? message.device_name
            : null
        setState((current) => ({
          ...current,
          phase: 'connected',
          firmwareVersion,
          protocolVersion
        }))
        if (reportedDeviceName && reportedDeviceName !== device.name) {
          deviceNameHandlerRef.current?.(device.id, reportedDeviceName)
        }
        notifications.show({
          message: translatorRef.current('connectedNotice', {
            name: reportedDeviceName ?? device.name
          }),
          color: 'teal',
          icon: createElement(IconCheck, { size: 16 }),
          autoClose: 2200
        })

        const ping = (): void => {
          if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return
          const sequence = ++pingSequenceRef.current
          pingTimesRef.current.set(sequence, performance.now())
          send({ type: 'ping', seq: sequence })
          for (const oldSequence of pingTimesRef.current.keys()) {
            if (oldSequence < sequence - 10) pingTimesRef.current.delete(oldSequence)
          }
        }
        ping()
        pingTimerRef.current = window.setInterval(ping, 5000)
      } else if (message.type === 'status') {
        setState((current) => ({
          ...current,
          usbConnected: Boolean(message.usb_connected),
          bleConnected: Boolean(message.ble_connected)
        }))
      } else if (message.type === 'pong') {
        const sequence = Number(message.seq)
        const sentAt = pingTimesRef.current.get(sequence)
        if (sentAt !== undefined) {
          pingTimesRef.current.delete(sequence)
          setState((current) => ({ ...current, latency: Math.round(performance.now() - sentAt) }))
        }
      } else if (message.type === 'log' && typeof message.message === 'string') {
        setState((current) => ({
          ...current,
          logs: [...current.logs.slice(-999), message.message as string]
        }))
      } else if (message.type === 'error') {
        const code = String(message.code ?? '')
        if (
          code === 'unauthorized' ||
          code === 'configuration_error' ||
          code === 'version_mismatch'
        ) {
          retryAllowed = false
        }
        if (code === 'version_mismatch') protocolMismatch = true
        const key: TranslationKey =
          code === 'unauthorized'
            ? 'authFailed'
            : code === 'busy'
              ? 'busy'
              : code === 'configuration_error'
                ? 'configError'
                : code === 'version_mismatch'
                  ? 'protocolMismatch'
                  : 'genericError'
        notifications.show({
          title: translatorRef.current('connectionFailed'),
          message: translatorRef.current(key, { message: String(message.message ?? code) }),
          color: 'red',
          icon: createElement(IconAlertTriangle, { size: 16 })
        })
      }
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket || manualCloseRef.current) return
      notifications.show({
        message: translatorRef.current('connectionFailed'),
        color: 'red',
        autoClose: 3000
      })
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return
      const manuallyClosed = manualCloseRef.current
      const wasAuthenticated = authenticatedRef.current
      socketRef.current = null
      authenticatedRef.current = false
      if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current)
      pingTimerRef.current = null
      pingTimesRef.current.clear()
      setState((current) => ({
        ...current,
        phase: protocolMismatch ? 'incompatible' : 'disconnected',
        reconnectPending: false,
        usbConnected: null,
        bleConnected: null,
        latency: null,
        firmwareVersion: null,
        protocolVersion: null
      }))
      if (!manuallyClosed && wasAuthenticated) {
        notifications.show({
          message: translatorRef.current('disconnectedNotice', { name: device.name }),
          color: 'orange'
        })
      }
      manualCloseRef.current = false
      if (!manuallyClosed && retryAllowed) scheduleReconnect()
    })
  }, [scheduleReconnect, send, stopTimers])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const disconnect = useCallback(() => {
    stopTimers()
    setState((current) => ({ ...current, reconnectPending: false }))
    const socket = socketRef.current
    if (!socket) return
    manualCloseRef.current = true
    if (authenticatedRef.current && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'release_all',
          target: inputTargetRef.current
        })
      )
    }
    socket.close(1000, 'user disconnect')
  }, [stopTimers])

  useEffect(() => {
    const previousDevice = deviceRef.current
    if (previousDevice?.id !== selectedDevice?.id && socketRef.current) disconnect()
    deviceRef.current = selectedDevice
  }, [disconnect, selectedDevice])

  useEffect(() => {
    return () => {
      stopTimers()
      const socket = socketRef.current
      if (socket) {
        manualCloseRef.current = true
        socket.close(1000, 'window closed')
      }
    }
  }, [stopTimers])

  const clearLogs = useCallback(() => setState((current) => ({ ...current, logs: [] })), [])
  const appendLog = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      logs: [...current.logs.slice(-999), message]
    }))
  }, [])

  const visibleState = selectedDevice ? state : initialState
  return {
    ...visibleState,
    isConnected: visibleState.phase === 'connected',
    connect,
    disconnect,
    send,
    appendLog,
    clearLogs
  }
}
