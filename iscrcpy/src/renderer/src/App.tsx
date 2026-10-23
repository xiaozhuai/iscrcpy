import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAccessible,
  IconActivityHeartbeat,
  IconAdjustments,
  IconAdjustmentsHorizontal,
  IconApps,
  IconArrowLeft,
  IconBell,
  IconBluetooth,
  IconBroadcast,
  IconCamera,
  IconChevronDown,
  IconChevronRight,
  IconCirclePlus,
  IconCode,
  IconCpu,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconEdit,
  IconFolder,
  IconFolderPlus,
  IconGripVertical,
  IconHome,
  IconInfoCircle,
  IconKeyboard,
  IconLanguage,
  IconLink,
  IconLock,
  IconPlugConnected,
  IconRefresh,
  IconReload,
  IconRoute,
  IconSearch,
  IconSettings,
  IconTrash,
  IconUsb,
  IconWifi
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AIRPLAY_CONFIG,
  normalizeAirplayConfig,
  type AirplayConfig
} from '../../shared/airplay'
import { localeNames, preferredLocale, translate, type TranslationKey } from './i18n'
import type {
  AddressMode,
  Device,
  DeviceGroup,
  DiscoveredDevice,
  LibraryState,
  Locale,
  Target
} from './types'
import { useAirPlayMirror } from './useAirPlayMirror'
import { useDeviceSession } from './useDeviceSession'

const GROUP_DRAG_TYPE = 'application/x-iscrcpy-group'
const DEVICE_DRAG_TYPE = 'application/x-iscrcpy-device'
const DEFAULT_RESOLUTION_WIDTH = 1206
const DEFAULT_RESOLUTION_HEIGHT = 2622

const keyUsages: Record<string, number> = {
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  ContextMenu: 0x65,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7
}
const mouseButtons = ['left', 'middle', 'right', 'back', 'forward'] as const

const systemShortcuts = [
  {
    label: 'shortcutHome',
    keys: '⌘H',
    icon: IconHome,
    usages: [keyUsages.MetaLeft, keyUsages.KeyH]
  },
  {
    label: 'shortcutAppSwitcher',
    keys: '⌘Tab',
    icon: IconApps,
    usages: [keyUsages.MetaLeft, keyUsages.Tab]
  },
  {
    label: 'shortcutControlCenter',
    keys: '⌃⌘C',
    icon: IconAdjustments,
    usages: [keyUsages.ControlLeft, keyUsages.MetaLeft, keyUsages.KeyC]
  },
  {
    label: 'shortcutNotificationCenter',
    keys: '⌃⌘N',
    icon: IconBell,
    usages: [keyUsages.ControlLeft, keyUsages.MetaLeft, keyUsages.KeyN]
  },
  {
    label: 'shortcutLockScreen',
    keys: '⌃⌘Q',
    icon: IconLock,
    usages: [keyUsages.ControlLeft, keyUsages.MetaLeft, keyUsages.KeyQ]
  },
  {
    label: 'shortcutRestart',
    keys: '⌃⌘R',
    icon: IconReload,
    usages: [keyUsages.ControlLeft, keyUsages.MetaLeft, keyUsages.KeyR]
  },
  {
    label: 'shortcutAccessibility',
    keys: '⌥⌘F5',
    icon: IconAccessible,
    usages: [keyUsages.AltLeft, keyUsages.MetaLeft, keyUsages.F5]
  },
  {
    label: 'shortcutSearch',
    keys: '⌘Space',
    icon: IconSearch,
    usages: [keyUsages.MetaLeft, keyUsages.Space]
  },
  {
    label: 'shortcutScreenshot',
    keys: '⇧⌘3',
    icon: IconCamera,
    usages: [keyUsages.MetaLeft, keyUsages.ShiftLeft, keyUsages.Digit3]
  }
] as const satisfies ReadonlyArray<{
  label: TranslationKey
  keys: string
  icon: typeof IconHome
  usages: readonly number[]
}>

type SystemShortcut = (typeof systemShortcuts)[number]

function handlePointerLockRequest(
  request: Promise<void> | undefined,
  onCooldown: () => void
): void {
  if (!request) return
  void request.catch((error: unknown) => {
    // Chromium rejects an immediate re-lock after Esc as a safety measure.
    if (error instanceof DOMException && error.name === 'SecurityError') {
      onCooldown()
      return
    }
    console.error('Unable to acquire pointer lock', error)
  })
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function connectionStatusColor(value: boolean | null): 'dimmed' | 'teal' | 'red' {
  return value === null ? 'dimmed' : value ? 'teal' : 'red'
}

function latencyStatusColor(value: number | null): 'dimmed' | 'teal' | 'orange' | 'red' {
  if (value === null) return 'dimmed'
  if (value < 80) return 'teal'
  if (value < 200) return 'orange'
  return 'red'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDevice(value: unknown): Device | null {
  if (!isRecord(value)) return null
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  const port = Number(value.port)
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    !host ||
    /\s/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : host
  return {
    id: value.id,
    name,
    groupId: typeof value.groupId === 'string' ? value.groupId : null,
    host,
    port,
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
    airplay: normalizeAirplayConfig(value.airplay)
  }
}

function normalizeLibrary(value: unknown): LibraryState {
  if (!isRecord(value)) return { groups: [], devices: [] }
  const groups = Array.isArray(value.groups)
    ? value.groups.flatMap((group) =>
        isRecord(group) && typeof group.id === 'string' && typeof group.name === 'string'
          ? [{ id: group.id, name: group.name }]
          : []
      )
    : []
  const groupIds = new Set(groups.map((group) => group.id))
  const devices = Array.isArray(value.devices)
    ? value.devices.flatMap((device) => {
        const normalized = normalizeDevice(device)
        if (!normalized) return []
        return [
          {
            ...normalized,
            groupId:
              normalized.groupId && groupIds.has(normalized.groupId) ? normalized.groupId : null
          }
        ]
      })
    : []
  return { groups, devices }
}

interface StoredSettings {
  version: 1
  locale: Locale
  autoReconnect: boolean
  reconnectIntervalSeconds: number
  addressMode: AddressMode
  target: Target
  collapsedGroups: string[]
  hideFullKeyboardAccessNotice: boolean
}

function normalizeStoredSettings(value: unknown): StoredSettings | null {
  if (!isRecord(value) || value.version !== 1) return null
  const reconnectIntervalSeconds = Number(value.reconnectIntervalSeconds)
  return {
    version: 1,
    locale:
      value.locale === 'zh-CN' || value.locale === 'zh-TW' || value.locale === 'en'
        ? value.locale
        : 'zh-CN',
    autoReconnect: typeof value.autoReconnect === 'boolean' ? value.autoReconnect : true,
    reconnectIntervalSeconds:
      Number.isInteger(reconnectIntervalSeconds) &&
      reconnectIntervalSeconds >= 1 &&
      reconnectIntervalSeconds <= 300
        ? reconnectIntervalSeconds
        : 5,
    addressMode: value.addressMode === 'ip' ? 'ip' : 'hostname',
    target:
      value.target === 'usb' || value.target === 'ble' || value.target === 'usb_preferred'
        ? value.target
        : 'usb_preferred',
    collapsedGroups: Array.isArray(value.collapsedGroups)
      ? value.collapsedGroups.filter((item): item is string => typeof item === 'string')
      : [],
    hideFullKeyboardAccessNotice: value.hideFullKeyboardAccessNotice === true
  }
}

interface DeviceDialogProps {
  opened: boolean
  device?: Device
  groups: DeviceGroup[]
  initialGroupId: string | null
  preferredAddressMode: AddressMode
  t: (key: TranslationKey, variables?: Record<string, string | number>) => string
  onClose: () => void
  onSave: (device: Device) => void
  onPreferredAddressModeChange: (mode: AddressMode) => void
}

function DeviceDialog({
  opened,
  device,
  groups,
  initialGroupId,
  preferredAddressMode,
  t,
  onClose,
  onSave,
  onPreferredAddressModeChange
}: DeviceDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<Device>(() => {
    return (
      device ?? {
        id: makeId('device'),
        name: '',
        groupId: initialGroupId,
        host: '',
        port: 2786,
        accessToken: '',
        airplay: { ...DEFAULT_AIRPLAY_CONFIG }
      }
    )
  })
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])
  const [discoveryAddressMode, setDiscoveryAddressMode] =
    useState<AddressMode>(preferredAddressMode)
  const [selectedDiscoveryId, setSelectedDiscoveryId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const testSocketRef = useRef<WebSocket | null>(null)
  const testTimerRef = useRef<number | null>(null)

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      setDiscovered(await window.api.discoverDevices())
    } catch {
      notifications.show({ message: t('discoverFailed'), color: 'red' })
    } finally {
      setScanning(false)
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => void scan(), 0)
    return () => {
      window.clearTimeout(timer)
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current)
      testSocketRef.current?.close()
    }
  }, [scan])
  const update = <K extends keyof Device>(key: K, value: Device[K]): void => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
    setErrors((current) => ({ ...current, [key]: '' }))
  }
  const selectDiscovered = (id: string | null): void => {
    const found = discovered.find((item) => item.id === id)
    if (!found) return
    setSelectedDiscoveryId(found.id)
    setDraft((current) =>
      current
        ? {
            ...current,
            name: found.name,
            host: discoveryAddressMode === 'ip' ? (found.addresses[0] ?? '') : found.hostname,
            port: found.port
          }
        : current
    )
  }
  const submit = (): void => {
    const nextErrors: Record<string, string> = {}
    const address = draft.host
    if (!address.trim() || /\s/.test(address)) nextErrors.address = t('validationAddress')
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)
      nextErrors.port = t('validationPort')
    if (draft.accessToken && !/^[!-~]{16,128}$/.test(draft.accessToken))
      nextErrors.accessToken = t('validationToken')
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    onSave({
      ...draft,
      name: draft.name.trim() || address.trim(),
      host: address.trim()
    })
  }
  const testConnection = (): void => {
    const nextErrors: Record<string, string> = {}
    const address = draft.host
    if (!address.trim() || /\s/.test(address)) nextErrors.address = t('validationAddress')
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)
      nextErrors.port = t('validationPort')
    if (draft.accessToken && !/^[!-~]{16,128}$/.test(draft.accessToken))
      nextErrors.accessToken = t('validationToken')
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    setTestingConnection(true)
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://${address.trim()}:${draft.port}/control`)
    } catch {
      setTestingConnection(false)
      setErrors((current) => ({ ...current, address: t('validationAddress') }))
      return
    }
    testSocketRef.current = socket
    let settled = false
    const finish = (success: boolean, message: string): void => {
      if (settled) return
      settled = true
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current)
      testTimerRef.current = null
      testSocketRef.current = null
      setTestingConnection(false)
      notifications.show({
        title: success ? t('testConnection') : t('testFailed'),
        message,
        color: success ? 'teal' : 'red'
      })
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'connection test complete')
    }

    testTimerRef.current = window.setTimeout(() => finish(false, t('testTimeout')), 5000)
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol_version: 1,
          access_token: draft.accessToken
        })
      )
    })
    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        finish(false, t('testInvalidResponse'))
        return
      }
      if (message.type === 'hello') {
        if (Number(message.protocol_version) !== 1) {
          finish(false, t('protocolMismatch'))
          return
        }
        finish(
          true,
          t('testSucceeded', {
            version: typeof message.version === 'string' ? message.version : t('unknown')
          })
        )
      } else if (message.type === 'error') {
        const code = String(message.code ?? '')
        const errorMessage =
          code === 'unauthorized'
            ? t('authFailed')
            : code === 'busy'
              ? t('busy')
              : code === 'configuration_error'
                ? t('configError')
                : code === 'version_mismatch'
                  ? t('protocolMismatch')
                  : t('genericError', { message: String(message.message ?? code) })
        finish(false, errorMessage)
      }
    })
    socket.addEventListener('error', () => finish(false, t('testSocketError')))
    socket.addEventListener('close', (event) =>
      finish(
        false,
        t('testClosed', {
          code: event.code,
          reason: event.reason ? `: ${event.reason}` : ''
        })
      )
    )
  }
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={device ? t('editDevice') : t('addDevice')}
      size="xl"
      centered
    >
      <div className="device-dialog-layout">
        <Stack gap="sm" className="device-dialog-form">
          <div className="endpoint-fields">
            <TextInput
              label={t('host')}
              withAsterisk
              autoFocus
              value={draft.host}
              error={errors.address}
              placeholder={t('hostPlaceholder')}
              onChange={(event) => update('host', event.currentTarget.value)}
            />
            <NumberInput
              label={t('port')}
              withAsterisk
              value={draft.port}
              error={errors.port}
              min={1}
              max={65535}
              allowDecimal={false}
              onChange={(value) => update('port', Number(value))}
            />
          </div>
          <TextInput
            label={t('token')}
            description={t('tokenHint')}
            type="password"
            value={draft.accessToken}
            error={errors.accessToken}
            onChange={(event) => update('accessToken', event.currentTarget.value)}
          />
          <TextInput
            label={t('deviceName')}
            description={t('deviceNameSynced')}
            value={draft.name}
            error={errors.name}
            readOnly={Boolean(device)}
            onChange={(event) => update('name', event.currentTarget.value)}
          />
          <Select
            label={t('group')}
            value={draft.groupId ?? 'ungrouped'}
            data={[
              { value: 'ungrouped', label: t('ungrouped') },
              ...groups.map((group) => ({ value: group.id, label: group.name }))
            ]}
            onChange={(value) => update('groupId', value === 'ungrouped' ? null : value)}
          />
        </Stack>
        <Paper className="discovery-card" p="sm" radius="md">
          <SegmentedControl
            fullWidth
            size="xs"
            value={discoveryAddressMode}
            data={[
              { value: 'hostname', label: t('useHostname') },
              { value: 'ip', label: t('useIp') }
            ]}
            onChange={(value) => {
              const mode = value as AddressMode
              setDiscoveryAddressMode(mode)
              onPreferredAddressModeChange(mode)
              const found = discovered.find((item) => item.id === selectedDiscoveryId)
              if (found) {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        host: mode === 'ip' ? (found.addresses[0] ?? '') : found.hostname
                      }
                    : current
                )
              }
            }}
          />
          <Group justify="space-between" mt="sm" mb={7}>
            <Text size="sm" fw={650}>
              {t('discovered')}
            </Text>
            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={<IconRefresh size={14} />}
              onClick={() => void scan()}
              disabled={scanning}
            >
              {t('scanAgain')}
            </Button>
          </Group>
          <div className="discovered-device-list">
            {scanning ? (
              <div className="discovery-empty">
                <Loader size={15} />
                <Text size="xs" c="dimmed">
                  {t('scanning')}
                </Text>
              </div>
            ) : discovered.length ? (
              discovered.map((item) => {
                const host =
                  discoveryAddressMode === 'ip' ? (item.addresses[0] ?? '—') : item.hostname
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`discovered-device${selectedDiscoveryId === item.id ? ' is-selected' : ''}`}
                    onClick={() => selectDiscovered(item.id)}
                  >
                    <span className="discovered-device-icon">
                      <IconDeviceDesktop size={16} />
                    </span>
                    <span className="discovered-device-copy">
                      <span className="discovered-device-line">
                        <Text size="sm" fw={600} truncate>
                          {item.name}
                        </Text>
                        <Text size="xs" c="dimmed" className="discovered-device-version">
                          {t('firmware')} {item.firmwareVersion ?? '—'}
                        </Text>
                      </span>
                      <span className="discovered-device-line">
                        <Text size="xs" c="dimmed" truncate>
                          {host}:{item.port}
                        </Text>
                        <Text size="xs" c="dimmed" className="discovered-device-version">
                          {t('protocol')} {item.protocolVersion ?? '—'}
                        </Text>
                      </span>
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="discovery-empty">
                <Text size="xs" c="dimmed" ta="center">
                  {t('noDiscovered')}
                </Text>
              </div>
            )}
          </div>
        </Paper>
      </div>
      <Group justify="space-between" mt="md">
        <Button
          variant="light"
          leftSection={<IconPlugConnected size={15} />}
          loading={testingConnection}
          onClick={testConnection}
        >
          {t('testConnection')}
        </Button>
        <Group gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={submit}>{t('save')}</Button>
        </Group>
      </Group>
    </Modal>
  )
}

interface PreviewProps {
  device: Device
  target: Target
  connected: boolean
  send: (message: Record<string, unknown>) => boolean
  onCaptureChange: (captured: boolean) => void
  onAirplayPidChange: (deviceId: string, pid: number | null) => void
  onVideoSizeChange: (deviceId: string, size: { width: number; height: number } | null) => void
  t: (key: TranslationKey, variables?: Record<string, string | number>) => string
}

function PreviewSurface({
  device,
  target,
  connected,
  send,
  onCaptureChange,
  onAirplayPidChange,
  onVideoSizeChange,
  t
}: PreviewProps): React.JSX.Element {
  const mirror = useAirPlayMirror()
  const areaRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const pressedRef = useRef(new Map<string, number>())
  const mouseRef = useRef({ x: 0, y: 0, wheel: 0, pan: 0, frame: 0, last: 0 })
  const [captured, setCaptured] = useState(false)
  const [frameSize, setFrameSize] = useState({ width: 220, height: 478 })
  const resetMouse = useCallback(() => {
    const pending = mouseRef.current
    if (pending.frame) cancelAnimationFrame(pending.frame)
    pending.x = 0
    pending.y = 0
    pending.wheel = 0
    pending.pan = 0
    pending.frame = 0
    pending.last = 0
  }, [])
  const release = useCallback(() => {
    if (connected) send({ type: 'release_all', target })
    resetMouse()
    pressedRef.current.clear()
  }, [connected, resetMouse, send, target])
  useEffect(() => () => resetMouse(), [resetMouse])
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const resize = (): void => {
      const ratio = mirror.videoSize
        ? mirror.videoSize.width / mirror.videoSize.height
        : DEFAULT_RESOLUTION_WIDTH / DEFAULT_RESOLUTION_HEIGHT
      const width = Math.max(1, area.clientWidth - 40),
        height = Math.max(1, area.clientHeight - 32)
      if (width / height > ratio) setFrameSize({ width: height * ratio, height })
      else setFrameSize({ width, height: width / ratio })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(area)
    resize()
    return () => observer.disconnect()
  }, [mirror.videoSize])
  useEffect(() => {
    const onLockChange = (): void => {
      const active = document.pointerLockElement === surfaceRef.current
      setCaptured(active)
      onCaptureChange(active)
      if (!active) release()
    }
    document.addEventListener('pointerlockchange', onLockChange)
    return () => document.removeEventListener('pointerlockchange', onLockChange)
  }, [onCaptureChange, release])
  useEffect(() => {
    if (!connected) {
      if (document.pointerLockElement === surfaceRef.current) document.exitPointerLock()
      onCaptureChange(false)
    }
  }, [connected, onCaptureChange])
  useEffect(() => {
    onAirplayPidChange(device.id, mirror.state.pid)
  }, [device.id, mirror.state.pid, onAirplayPidChange])
  useEffect(() => {
    onVideoSizeChange(device.id, mirror.videoSize)
  }, [device.id, mirror.videoSize, onVideoSizeChange])
  useEffect(
    () => () => {
      if (document.pointerLockElement === surfaceRef.current) document.exitPointerLock()
      onCaptureChange(false)
    },
    [onCaptureChange]
  )
  useEffect(() => resetMouse(), [resetMouse, target])
  function flushMouse(time: number): void {
    const pending = mouseRef.current
    pending.frame = 0
    if (!connected || document.pointerLockElement !== surfaceRef.current) {
      resetMouse()
      return
    }
    if (pending.last && time - pending.last < 1000 / 60) {
      pending.frame = requestAnimationFrame(flushMouse)
      return
    }
    const take = (value: number): number => Math.max(-127, Math.min(127, Math.trunc(value)))
    const x = take(pending.x),
      y = take(pending.y),
      wheel = take(pending.wheel),
      pan = take(pending.pan)
    if (!x && !y && !wheel && !pan) return
    pending.x -= x
    pending.y -= y
    pending.wheel -= wheel
    pending.pan -= pan
    pending.last = time
    send({ type: 'mouse_move', x, y, wheel, pan, target })
    if (
      Math.abs(pending.x) >= 1 ||
      Math.abs(pending.y) >= 1 ||
      Math.abs(pending.wheel) >= 1 ||
      Math.abs(pending.pan) >= 1
    )
      pending.frame = requestAnimationFrame(flushMouse)
  }
  const queueMouse = (x: number, y: number, wheel = 0, pan = 0): void => {
    const pending = mouseRef.current
    pending.x += x
    pending.y += y
    pending.wheel += wheel
    pending.pan += pan
    if (!pending.frame) pending.frame = requestAnimationFrame(flushMouse)
  }
  const airplayServiceName = mirror.state.serviceName ?? `iscrcpy for ${device.name}`
  const airplayMessage =
    mirror.state.phase === 'starting'
      ? t('airplayStarting')
      : mirror.state.phase === 'streaming'
        ? t('airplayReceiving')
        : mirror.state.phase === 'error'
          ? t('airplayError')
          : t('airplayWaiting')
  const mirrorError = mirror.decoderError ?? mirror.state.error
  return (
    <div className="preview-area" ref={areaRef}>
      <div
        ref={surfaceRef}
        className={`preview-surface${connected ? ' is-connected' : ''}${captured ? ' is-captured' : ''}`}
        style={{ width: frameSize.width, height: frameSize.height }}
        tabIndex={0}
        onClick={() => {
          if (!connected || document.pointerLockElement === surfaceRef.current) return
          surfaceRef.current?.focus({ preventScroll: true })
          handlePointerLockRequest(surfaceRef.current?.requestPointerLock(), () => {
            notifications.show({
              id: 'pointer-lock-cooldown',
              message: t('pointerLockCooldown'),
              color: 'yellow',
              autoClose: 2200
            })
          })
        }}
        onKeyDown={(event) => {
          const usage = keyUsages[event.code]
          if (usage === undefined || !connected) return
          event.preventDefault()
          if (pressedRef.current.has(event.code)) return
          pressedRef.current.set(event.code, usage)
          send({ type: 'key', action: 'down', usage, target })
        }}
        onKeyUp={(event) => {
          const usage = pressedRef.current.get(event.code)
          if (usage === undefined) return
          event.preventDefault()
          send({ type: 'key', action: 'up', usage, target })
          pressedRef.current.delete(event.code)
        }}
        onMouseMove={(event) => {
          if (document.pointerLockElement === surfaceRef.current && connected)
            queueMouse(event.movementX, event.movementY)
        }}
        onMouseDown={(event) => {
          const button = mouseButtons[event.button]
          if (document.pointerLockElement !== surfaceRef.current || !connected || !button) return
          event.preventDefault()
          send({ type: 'mouse_button', button, pressed: true, target })
        }}
        onMouseUp={(event) => {
          const button = mouseButtons[event.button]
          if (document.pointerLockElement !== surfaceRef.current || !connected || !button) return
          event.preventDefault()
          send({ type: 'mouse_button', button, pressed: false, target })
        }}
        onWheel={(event) => {
          if (document.pointerLockElement !== surfaceRef.current || !connected) return
          event.preventDefault()
          queueMouse(
            0,
            0,
            event.deltaY === 0 ? 0 : event.deltaY > 0 ? -1 : 1,
            event.deltaX === 0 ? 0 : event.deltaX > 0 ? 1 : -1
          )
        }}
        onContextMenu={(event) => event.preventDefault()}
        onBlur={release}
      >
        <canvas ref={mirror.canvasRef} className="preview-video" aria-hidden="true" />
        {!mirror.hasVideo &&
          (connected ? (
            <div className="setup-guide">
              <Text fw={650} size="sm">
                {t('setupGuideTitle')}
              </Text>
              <div className="setup-guide-step">
                <span className="setup-guide-index">1</span>
                <div>
                  <Text size="xs" fw={650}>
                    {t('setupAssistiveTouch')}
                  </Text>
                  <Text className="setup-guide-frequency" size="xs">
                    {t('setupOnce')}
                  </Text>
                  <Text size="xs" c="dimmed" mt={2}>
                    {t('assistiveTouchHint')}
                  </Text>
                </div>
              </div>
              <div className="setup-guide-step">
                <span className="setup-guide-index">2</span>
                <div>
                  <Text size="xs" fw={650}>
                    {t('setupFullKeyboardAccess')}
                  </Text>
                  <Text className="setup-guide-frequency" size="xs">
                    {t('setupOnce')}
                  </Text>
                  <Text size="xs" c="dimmed" mt={2}>
                    {t('fullKeyboardAccessHint')}
                  </Text>
                </div>
              </div>
              <div className="setup-guide-step">
                <span className="setup-guide-index">3</span>
                <div>
                  <Text size="xs" fw={650}>
                    {t('setupMirror')}
                  </Text>
                  <Text
                    className="setup-guide-frequency setup-guide-frequency--connection"
                    size="xs"
                  >
                    {t('setupEveryConnection')}
                  </Text>
                  <Text size="xs" c="dimmed" mt={2}>
                    {airplayMessage}
                  </Text>
                </div>
              </div>
              {mirrorError && (
                <Text size="xs" c="red.4">
                  {mirror.state.phase === 'error'
                    ? mirrorError
                    : t('airplayVideoError', { message: mirrorError })}
                </Text>
              )}
              <Text className="setup-guide-device-name" size="md" fw={700}>
                {airplayServiceName}
              </Text>
            </div>
          ) : (
            <div className="preview-message">
              <Text fw={650} size="sm">
                {t('previewDisconnected')}
              </Text>
            </div>
          ))}
      </div>
    </div>
  )
}

type ContextMenuState =
  | { x: number; y: number; type: 'blank' }
  | { x: number; y: number; type: 'group' | 'device'; id: string }
  | null

type AppPage = 'devices' | 'settings' | 'about'
type Translator = (key: TranslationKey, variables?: Record<string, string | number>) => string

interface SettingsPageProps {
  target: Target
  autoReconnect: boolean
  reconnectInterval: number
  t: Translator
  onTargetChange: (target: Target) => void
  onAutoReconnectChange: (enabled: boolean) => void
  onReconnectIntervalChange: (seconds: number) => void
}

function SettingsPage({
  target,
  autoReconnect,
  reconnectInterval,
  t,
  onTargetChange,
  onAutoReconnectChange,
  onReconnectIntervalChange
}: SettingsPageProps): React.JSX.Element {
  return (
    <div className="utility-page">
      <div className="utility-page-header">
        <div>
          <Text fw={700} size="sm">
            {t('settings')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('settingsDescription')}
          </Text>
        </div>
      </div>
      <Paper className="utility-card" p="lg" radius="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Text fw={650}>{t('target')}</Text>
            <Text size="sm" c="dimmed" mt={4}>
              {t('targetDescription')}
            </Text>
          </div>
          <Select
            w={160}
            value={target}
            data={[
              { value: 'usb_preferred', label: t('usbPreferred') },
              { value: 'usb', label: t('usbOnly') },
              { value: 'ble', label: t('bleOnly') }
            ]}
            onChange={(value) => {
              if (value) onTargetChange(value as Target)
            }}
          />
        </Group>
        <Divider my="lg" />
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Text fw={650}>{t('autoReconnect')}</Text>
            <Text size="sm" c="dimmed" mt={4}>
              {t('autoReconnectDescription')}
            </Text>
          </div>
          <Switch
            checked={autoReconnect}
            onChange={(event) => onAutoReconnectChange(event.currentTarget.checked)}
          />
        </Group>
        <Divider my="lg" />
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Text fw={650}>{t('reconnectInterval')}</Text>
            <Text size="sm" c="dimmed" mt={4}>
              {t('reconnectIntervalDescription')}
            </Text>
          </div>
          <NumberInput
            w={120}
            min={1}
            max={300}
            allowDecimal={false}
            value={reconnectInterval}
            suffix={t('seconds')}
            onChange={(value) => {
              const seconds = Number(value)
              if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 300) {
                onReconnectIntervalChange(seconds)
              }
            }}
          />
        </Group>
      </Paper>
    </div>
  )
}

interface AboutPageProps {
  t: Translator
}

function AboutPage({ t }: AboutPageProps): React.JSX.Element {
  const versions = window.electron.process.versions
  return (
    <div className="utility-page">
      <div className="utility-page-header">
        <div>
          <Text fw={700} size="sm">
            {t('about')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('aboutDescription')}
          </Text>
        </div>
      </div>
      <Paper className="utility-card" p="lg" radius="md">
        <Group gap="md" wrap="nowrap">
          <div className="brand-mark">
            <IconDeviceDesktop size={18} stroke={1.8} />
          </div>
          <div>
            <Text fw={700}>{t('appName')}</Text>
            <Text size="sm" c="dimmed">
              {t('aboutVersion')}
            </Text>
          </div>
        </Group>
        <Divider my="lg" />
        <Text size="sm">{t('aboutTechnology')}</Text>
        <Text size="xs" c="dimmed" mt="md">
          Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
        </Text>
      </Paper>
    </div>
  )
}

function App(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(preferredLocale)
  const [page, setPage] = useState<AppPage>('devices')
  const t = useCallback(
    (key: TranslationKey, variables?: Record<string, string | number>) =>
      translate(locale, key, variables),
    [locale]
  )
  const translatorRef = useRef(t)
  useEffect(() => {
    translatorRef.current = t
  }, [t])
  const [storageReady, setStorageReady] = useState(false)
  const [library, setLibrary] = useState<LibraryState>({ groups: [], devices: [] })
  const [logKind, setLogKind] = useState<'device' | 'airplay'>('device')
  const [airplayLogs, setAirplayLogs] = useState<string[]>([])
  const [target, setTarget] = useState<Target>('usb_preferred')
  const [autoReconnect, setAutoReconnect] = useState(true)
  const [reconnectInterval, setReconnectInterval] = useState(5)
  const [addressMode, setAddressMode] = useState<AddressMode>('hostname')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deviceDialog, setDeviceDialog] = useState<{
    opened: boolean
    deviceId?: string
    groupId: string | null
  }>({ opened: false, groupId: null })
  const [groupDialog, setGroupDialog] = useState<{ opened: boolean; groupId?: string }>({
    opened: false
  })
  const [groupName, setGroupName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [fullKeyboardAccessNoticeOpened, setFullKeyboardAccessNoticeOpened] = useState(false)
  const [fullKeyboardAccessNoticeDisabled, setFullKeyboardAccessNoticeDisabled] = useState(false)
  const [rememberFullKeyboardAccessNotice, setRememberFullKeyboardAccessNotice] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<SystemShortcut | null>(null)
  const [previewCaptured, setPreviewCaptured] = useState(false)
  const [airplayRestarting, setAirplayRestarting] = useState(false)
  const [airplayProcess, setAirplayProcess] = useState<{
    deviceId: string
    pid: number | null
  } | null>(null)
  const [detectedVideoSize, setDetectedVideoSize] = useState<{
    deviceId: string
    width: number
    height: number
  } | null>(null)
  const airplayConfigRef = useRef<AirplayConfig | undefined>(undefined)
  const pendingConnectIdRef = useRef<string | null>(null)
  const shortcutBusyRef = useRef(false)
  const storageErrorShownRef = useRef(false)
  const logViewportRef = useRef<HTMLDivElement>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  const selectedDevice = library.devices.find((device) => device.id === selectedId)
  useEffect(() => {
    let cancelled = false
    void window.api.storage
      .load()
      .then((stored) => {
        if (cancelled) return
        if (stored.devices !== null) {
          const nextLibrary = normalizeLibrary(stored.devices)
          setLibrary(nextLibrary)
          setSelectedId(nextLibrary.devices[0]?.id ?? null)
        }
        const storedSettings = normalizeStoredSettings(stored.settings)
        if (storedSettings) {
          setLocale(storedSettings.locale)
          setTarget(storedSettings.target)
          setAutoReconnect(storedSettings.autoReconnect)
          setReconnectInterval(storedSettings.reconnectIntervalSeconds)
          setAddressMode(storedSettings.addressMode)
          setCollapsedGroups(storedSettings.collapsedGroups)
          setFullKeyboardAccessNoticeDisabled(storedSettings.hideFullKeyboardAccessNotice)
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to load local storage files', error)
        if (!storageErrorShownRef.current) {
          storageErrorShownRef.current = true
          notifications.show({ message: translatorRef.current('storageError'), color: 'red' })
        }
      })
      .finally(() => {
        if (!cancelled) setStorageReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!storageReady) return
    const settings: StoredSettings = {
      version: 1,
      locale,
      target,
      autoReconnect,
      reconnectIntervalSeconds: reconnectInterval,
      addressMode,
      collapsedGroups,
      hideFullKeyboardAccessNotice: fullKeyboardAccessNoticeDisabled
    }
    void Promise.all([
      window.api.storage.saveDevices({
        version: 1,
        groups: library.groups,
        devices: library.devices
      }),
      window.api.storage.saveSettings(settings)
    ]).catch((error: unknown) => {
      console.error('Unable to save configuration files', error)
      if (!storageErrorShownRef.current) {
        storageErrorShownRef.current = true
        notifications.show({ message: t('storageError'), color: 'red' })
      }
    })
  }, [
    addressMode,
    autoReconnect,
    collapsedGroups,
    fullKeyboardAccessNoticeDisabled,
    library,
    locale,
    reconnectInterval,
    storageReady,
    target,
    t
  ])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  useEffect(() => {
    const close = (): void => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [])
  const updateDevice = useCallback(
    (id: string, changes: Partial<Device>) =>
      setLibrary((current) => ({
        ...current,
        devices: current.devices.map((device) =>
          device.id === id ? { ...device, ...changes } : device
        )
      })),
    []
  )
  const updateVideoSize = useCallback(
    (deviceId: string, size: { width: number; height: number } | null) => {
      setDetectedVideoSize(size ? { deviceId, ...size } : null)
    },
    []
  )
  const updateAirplayPid = useCallback((deviceId: string, pid: number | null) => {
    setAirplayProcess({ deviceId, pid })
  }, [])
  const updateAirplaySetting = <K extends keyof AirplayConfig>(
    key: K,
    value: AirplayConfig[K]
  ): void => {
    if (!selectedDevice) return
    updateDevice(selectedDevice.id, {
      airplay: normalizeAirplayConfig({
        ...selectedDevice.airplay,
        [key]: value
      })
    })
  }
  const syncReportedDeviceName = useCallback(
    (deviceId: string, name: string) => updateDevice(deviceId, { name }),
    [updateDevice]
  )
  const session = useDeviceSession(
    selectedDevice,
    t,
    syncReportedDeviceName,
    autoReconnect,
    reconnectInterval * 1000,
    target
  )
  useEffect(() => {
    return window.api.airplay.onLog((message) => {
      setAirplayLogs((current) => [...current.slice(-999), message])
    })
  }, [])
  useEffect(() => {
    return window.api.airplay.onState((state) => {
      if (state.phase === 'starting') setAirplayLogs([])
    })
  }, [])
  useEffect(() => {
    const viewport = logViewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [airplayLogs.length, logKind, session.logs.length])
  useEffect(() => {
    airplayConfigRef.current = selectedDevice?.airplay
  }, [selectedDevice?.airplay])
  useEffect(() => {
    const deviceName = selectedDevice?.name
    const airplayConfig = airplayConfigRef.current
    if (!session.isConnected || !deviceName || !airplayConfig) {
      void window.api.airplay.stop()
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.airplay.start(deviceName, airplayConfig).catch((error: unknown) => {
        console.error('Unable to start AirPlay receiver', error)
      })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      void window.api.airplay.stop()
    }
  }, [selectedDevice?.id, selectedDevice?.name, session.isConnected])
  const sessionSend = session.send
  const sessionConnected = session.isConnected
  const sendShortcut = useCallback(
    (usages: readonly number[]): void => {
      if (!sessionConnected || shortcutBusyRef.current) return
      shortcutBusyRef.current = true
      const messages = [
        ...usages.map((usage) => ({ type: 'key', action: 'down', usage, target })),
        ...[...usages].reverse().map((usage) => ({ type: 'key', action: 'up', usage, target }))
      ]
      messages.forEach((message, index) => {
        window.setTimeout(() => {
          sessionSend(message)
          if (index === messages.length - 1) shortcutBusyRef.current = false
        }, index * 40)
      })
    },
    [sessionConnected, sessionSend, target]
  )
  const requestShortcut = (shortcut: SystemShortcut): void => {
    if (!fullKeyboardAccessNoticeDisabled) {
      setRememberFullKeyboardAccessNotice(false)
      setPendingShortcut(shortcut)
      setFullKeyboardAccessNoticeOpened(true)
      return
    }
    sendShortcut(shortcut.usages)
  }
  const closeFullKeyboardAccessNotice = (): void => {
    setFullKeyboardAccessNoticeOpened(false)
    setPendingShortcut(null)
  }
  const confirmShortcut = (): void => {
    if (rememberFullKeyboardAccessNotice) {
      setFullKeyboardAccessNoticeDisabled(true)
    }
    const shortcut = pendingShortcut
    closeFullKeyboardAccessNotice()
    if (shortcut) sendShortcut(shortcut.usages)
  }
  useEffect(() => {
    const pendingConnectId = pendingConnectIdRef.current
    if (!pendingConnectId || selectedDevice?.id !== pendingConnectId) return
    if (session.isConnected || session.phase === 'connecting') return
    pendingConnectIdRef.current = null
    session.connect()
  }, [selectedDevice?.id, session])

  const connectDevice = (id: string): void => {
    setPage('devices')
    if (selectedId === id) {
      if (!session.isConnected && session.phase !== 'connecting') session.connect()
      return
    }
    pendingConnectIdRef.current = id
    setSelectedId(id)
  }

  const toggleDeviceConnection = (id: string): void => {
    if (
      selectedId === id &&
      (session.isConnected || session.phase === 'connecting' || session.reconnectPending)
    ) {
      session.disconnect()
    } else {
      connectDevice(id)
    }
  }

  const toggleGroup = (groupId: string): void => {
    setCollapsedGroups((current) =>
      current.includes(groupId) ? current.filter((item) => item !== groupId) : [...current, groupId]
    )
  }

  const saveDevice = (device: Device): void => {
    setPage('devices')
    setLibrary((current) => {
      const exists = current.devices.some((item) => item.id === device.id)
      return {
        ...current,
        devices: exists
          ? current.devices.map((item) => (item.id === device.id ? device : item))
          : [...current.devices, device]
      }
    })
    setSelectedId(device.id)
    setDeviceDialog({ opened: false, groupId: null })
    notifications.show({ message: t('deviceSaved'), color: 'teal', autoClose: 1800 })
  }
  const saveGroup = (): void => {
    const name = groupName.trim()
    if (!name) return
    setLibrary((current) =>
      groupDialog.groupId
        ? {
            ...current,
            groups: current.groups.map((group) =>
              group.id === groupDialog.groupId ? { ...group, name } : group
            )
          }
        : { ...current, groups: [...current.groups, { id: makeId('group'), name }] }
    )
    setGroupDialog({ opened: false })
    setGroupName('')
    notifications.show({ message: t('groupCreated'), color: 'teal', autoClose: 1600 })
  }
  const deleteDevice = (id: string): void => {
    const device = library.devices.find((item) => item.id === id)
    if (!device || !window.confirm(t('confirmDeleteDevice', { name: device.name }))) return
    setLibrary((current) => ({
      ...current,
      devices: current.devices.filter((item) => item.id !== id)
    }))
    if (selectedId === id) setSelectedId(library.devices.find((item) => item.id !== id)?.id ?? null)
  }
  const deleteGroup = (id: string): void => {
    const group = library.groups.find((item) => item.id === id)
    if (
      !group ||
      !window.confirm(`${t('confirmDeleteGroup', { name: group.name })}\n${t('deleteGroupHint')}`)
    )
      return
    setLibrary((current) => ({
      groups: current.groups.filter((item) => item.id !== id),
      devices: current.devices.map((device) =>
        device.groupId === id ? { ...device, groupId: null } : device
      )
    }))
  }
  const moveDevice = (deviceId: string, groupId: string | null, beforeId?: string): void =>
    setLibrary((current) => {
      const moving = current.devices.find((device) => device.id === deviceId)
      if (!moving) return current
      const remaining = current.devices.filter((device) => device.id !== deviceId),
        moved = { ...moving, groupId }
      if (!beforeId) return { ...current, devices: [...remaining, moved] }
      const index = remaining.findIndex((device) => device.id === beforeId)
      if (index < 0) return { ...current, devices: [...remaining, moved] }
      remaining.splice(index, 0, moved)
      return { ...current, devices: remaining }
    })
  const moveGroup = (groupId: string, beforeId: string): void => {
    if (groupId === beforeId) return
    setLibrary((current) => {
      const moving = current.groups.find((group) => group.id === groupId)
      if (!moving) return current
      const groups = current.groups.filter((group) => group.id !== groupId)
      const index = groups.findIndex((group) => group.id === beforeId)
      groups.splice(index < 0 ? groups.length : index, 0, moving)
      return { ...current, groups }
    })
  }
  const onDrop = (
    event: React.DragEvent,
    groupId: string | null,
    beforeDeviceId?: string,
    beforeGroupId?: string
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    const deviceId = event.dataTransfer.getData(DEVICE_DRAG_TYPE),
      groupDragId = event.dataTransfer.getData(GROUP_DRAG_TYPE)
    if (deviceId) moveDevice(deviceId, groupId, beforeDeviceId)
    else if (groupDragId && beforeGroupId) moveGroup(groupDragId, beforeGroupId)
  }
  const renderDevice = (device: Device): React.JSX.Element => {
    const active = device.id === selectedId,
      connected = active && session.isConnected
    return (
      <div
        key={device.id}
        className={`device-row${active ? ' is-active' : ''}`}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(DEVICE_DRAG_TYPE, device.id)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => onDrop(event, device.groupId, device.id)}
        onClick={() => {
          setSelectedId(device.id)
          setPage('devices')
        }}
        onDoubleClick={() => connectDevice(device.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenu({ x: event.clientX, y: event.clientY, type: 'device', id: device.id })
        }}
      >
        <IconGripVertical className="drag-handle" size={14} />
        <span className={`device-dot${connected ? ' online' : ''}`} />
        <div className="device-copy">
          <Text size="sm" fw={active ? 650 : 500} truncate>
            {device.name}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {device.host}
          </Text>
        </div>
        {active && (session.phase === 'connecting' || session.reconnectPending) && (
          <Loader size={12} />
        )}
      </div>
    )
  }
  const renderGroup = (group: DeviceGroup): React.JSX.Element => {
    const devices = library.devices.filter((device) => device.groupId === group.id)
    const collapsed = collapsedGroups.includes(group.id)
    return (
      <div
        key={group.id}
        className="device-group"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(GROUP_DRAG_TYPE, group.id)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDrop(event, group.id, undefined, group.id)}
      >
        <div
          className="group-heading is-clickable"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onClick={() => toggleGroup(group.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleGroup(group.id)
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setContextMenu({ x: event.clientX, y: event.clientY, type: 'group', id: group.id })
          }}
        >
          <IconChevronDown
            className={`group-chevron${collapsed ? ' is-collapsed' : ''}`}
            size={13}
          />
          <Text size="xs" fw={650} truncate>
            {group.name}
          </Text>
          <span>{devices.length}</span>
        </div>
        {!collapsed &&
          (devices.length ? (
            devices.map(renderDevice)
          ) : (
            <div className="empty-drop">{t('dropHere')}</div>
          ))}
      </div>
    )
  }
  const ungrouped = library.devices.filter((device) => device.groupId === null)
  const ungroupedCollapsed = collapsedGroups.includes('ungrouped')
  const sessionActive =
    session.isConnected || session.phase === 'connecting' || session.reconnectPending
  const phaseLabel = session.reconnectPending
    ? t('reconnecting')
    : session.phase === 'connected'
      ? t('connected')
      : session.phase === 'connecting'
        ? t('connecting')
        : session.phase === 'incompatible'
          ? t('incompatible')
          : t('disconnected')
  const phaseColor = session.reconnectPending
    ? 'orange'
    : session.phase === 'connected'
      ? 'teal'
      : session.phase === 'connecting'
        ? 'blue'
        : session.phase === 'incompatible'
          ? 'red'
          : 'gray'
  const activeResolution =
    session.isConnected && detectedVideoSize?.deviceId === selectedDevice?.id
      ? detectedVideoSize
      : null
  const activeAirplayPid =
    airplayProcess && airplayProcess.deviceId === selectedDevice?.id ? airplayProcess.pid : null
  const visibleLogs = logKind === 'device' ? session.logs : airplayLogs

  return (
    <div className="app-shell">
      <header className="app-titlebar">
        <div className="app-titlebar-sidebar" />
        <div className="app-titlebar-content">
          {page !== 'devices' && (
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              ml={-9}
              leftSection={<IconArrowLeft size={15} />}
              onClick={() => setPage('devices')}
            >
              {t('backToDevices')}
            </Button>
          )}
        </div>
      </header>
      <aside
        className="sidebar"
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY, type: 'blank' })
          }
        }}
      >
        <div className="sidebar-header">
          <div className="brand-mark">
            <IconDeviceDesktop size={18} stroke={1.8} />
          </div>
          <Text fw={700} size="sm">
            {t('appName')}
          </Text>
          <div className="sidebar-header-actions">
            <Menu position="bottom-end" shadow="md" width={180}>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('sidebarMenu')}>
                  <IconCirclePlus size={17} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  leftSection={<IconDeviceDesktop size={15} />}
                  onClick={() => setDeviceDialog({ opened: true, groupId: null })}
                >
                  {t('addDevice')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconFolderPlus size={15} />}
                  onClick={() => {
                    setGroupName('')
                    setGroupDialog({ opened: true })
                  }}
                >
                  {t('addGroup')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Menu position="bottom-end" shadow="md" width={180}>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('settings')}>
                  <IconSettings size={17} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Sub>
                  <Menu.Sub.Target>
                    <Menu.Sub.Item leftSection={<IconLanguage size={15} />}>
                      {t('language')}
                    </Menu.Sub.Item>
                  </Menu.Sub.Target>
                  <Menu.Sub.Dropdown>
                    {(Object.keys(localeNames) as Locale[]).map((item) => (
                      <Menu.Item key={item} onClick={() => setLocale(item)}>
                        {locale === item ? `✓ ${localeNames[item]}` : localeNames[item]}
                      </Menu.Item>
                    ))}
                  </Menu.Sub.Dropdown>
                </Menu.Sub>
                <Menu.Divider />
                <Menu.Item
                  leftSection={<IconSettings size={15} />}
                  onClick={() => setPage('settings')}
                >
                  {t('settings')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconInfoCircle size={15} />}
                  onClick={() => setPage('about')}
                >
                  {t('about')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </div>
        <div className="sidebar-section-title">
          <Text size="xs" fw={650}>
            {t('devices')}
          </Text>
          <Text size="xs" c="dimmed">
            {library.devices.length}
          </Text>
        </div>
        <ScrollArea
          className="device-tree"
          scrollbarSize={5}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY, type: 'blank' })
          }}
        >
          {!library.devices.length && !library.groups.length ? (
            <div className="empty-library">
              <IconDeviceDesktop size={28} stroke={1.3} />
              <Text size="sm" fw={600}>
                {t('emptyLibrary')}
              </Text>
              <Text size="xs" c="dimmed" ta="center">
                {t('emptyLibraryHint')}
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => setDeviceDialog({ opened: true, groupId: null })}
              >
                {t('addDevice')}
              </Button>
            </div>
          ) : (
            <>
              {ungrouped.length > 0 && (
                <div
                  className="device-group"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onDrop(event, null)}
                >
                  <div
                    className="group-heading is-clickable"
                    role="button"
                    tabIndex={0}
                    aria-expanded={!ungroupedCollapsed}
                    onClick={() => toggleGroup('ungrouped')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleGroup('ungrouped')
                      }
                    }}
                  >
                    <IconChevronDown
                      className={`group-chevron${ungroupedCollapsed ? ' is-collapsed' : ''}`}
                      size={13}
                    />
                    <Text size="xs" fw={650}>
                      {t('ungrouped')}
                    </Text>
                    <span>{ungrouped.length}</span>
                  </div>
                  {!ungroupedCollapsed && ungrouped.map(renderDevice)}
                </div>
              )}
              {library.groups.map(renderGroup)}
            </>
          )}
        </ScrollArea>
      </aside>
      <main className="workspace">
        {page === 'settings' ? (
          <SettingsPage
            target={target}
            autoReconnect={autoReconnect}
            reconnectInterval={reconnectInterval}
            t={t}
            onTargetChange={(nextTarget) => {
              if (nextTarget === target) return
              if (session.isConnected) session.send({ type: 'release_all', target })
              setTarget(nextTarget)
            }}
            onAutoReconnectChange={(enabled) => {
              setAutoReconnect(enabled)
              if (!enabled && session.reconnectPending) session.disconnect()
            }}
            onReconnectIntervalChange={setReconnectInterval}
          />
        ) : page === 'about' ? (
          <AboutPage t={t} />
        ) : !selectedDevice ? (
          <div className="workspace-empty">
            <div className="empty-illustration">
              <IconLink size={30} />
            </div>
            <Text fw={650}>{t('emptyLibrary')}</Text>
            <Text size="sm" c="dimmed">
              {t('emptyLibraryHint')}
            </Text>
            <Button
              size="sm"
              leftSection={<IconCirclePlus size={16} />}
              onClick={() => setDeviceDialog({ opened: true, groupId: null })}
            >
              {t('addDevice')}
            </Button>
          </div>
        ) : (
          <>
            <header className="device-header">
              <div className="device-title">
                <Text fw={700} size="sm" truncate>
                  {selectedDevice.name}
                </Text>
                <Group gap={6} wrap="nowrap">
                  <Badge size="xs" variant="light" color={phaseColor} circle>
                    <span className="badge-dot" />
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {phaseLabel}
                  </Text>
                  <Text size="xs" c="dimmed">
                    ·
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {selectedDevice.host}:{selectedDevice.port}
                  </Text>
                </Group>
              </div>
              <Group gap="xs">
                {previewCaptured && (
                  <Badge
                    size="xs"
                    variant="light"
                    color="blue"
                    leftSection={<IconKeyboard size={12} />}
                  >
                    {t('captureExit')}
                  </Badge>
                )}
                <Menu position="bottom-end" shadow="md" width={230}>
                  <Menu.Target>
                    <Tooltip label={t('deviceMenu')}>
                      <ActionIcon variant="default" size={26} aria-label={t('deviceMenu')}>
                        <IconAdjustmentsHorizontal size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconEdit size={15} />}
                      onClick={() =>
                        setDeviceDialog({
                          opened: true,
                          deviceId: selectedDevice.id,
                          groupId: selectedDevice.groupId
                        })
                      }
                    >
                      {t('editDevice')}
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Sub>
                      <Menu.Sub.Target>
                        <Menu.Sub.Item
                          leftSection={<IconKeyboard size={15} />}
                          rightSection={<IconChevronRight size={14} />}
                        >
                          {t('sendShortcut')}
                        </Menu.Sub.Item>
                      </Menu.Sub.Target>
                      <Menu.Sub.Dropdown>
                        <Menu.Label>{t('systemShortcuts')}</Menu.Label>
                        {systemShortcuts.map((shortcut) => {
                          const ShortcutIcon = shortcut.icon
                          return (
                            <Menu.Item
                              key={shortcut.label}
                              leftSection={<ShortcutIcon size={15} />}
                              rightSection={
                                <Text size="xs" c="dimmed" ff="monospace">
                                  {shortcut.keys}
                                </Text>
                              }
                              disabled={!session.isConnected}
                              onClick={() => requestShortcut(shortcut)}
                            >
                              {t(shortcut.label)}
                            </Menu.Item>
                          )
                        })}
                      </Menu.Sub.Dropdown>
                    </Menu.Sub>
                  </Menu.Dropdown>
                </Menu>
                <Button
                  size="compact-sm"
                  variant={sessionActive ? 'default' : 'filled'}
                  color={sessionActive ? 'red' : 'blue'}
                  loading={session.phase === 'connecting'}
                  leftSection={<IconPlugConnected size={15} />}
                  onClick={sessionActive ? session.disconnect : session.connect}
                >
                  {session.reconnectPending
                    ? t('cancelReconnect')
                    : sessionActive
                      ? t('disconnect')
                      : t('connect')}
                </Button>
              </Group>
            </header>
            <section className="device-content">
              <PreviewSurface
                device={selectedDevice}
                target={target}
                connected={session.isConnected}
                send={session.send}
                onCaptureChange={setPreviewCaptured}
                onAirplayPidChange={updateAirplayPid}
                onVideoSizeChange={updateVideoSize}
                t={t}
              />
              <div className="bottom-panels">
                <Accordion defaultValue="details" variant="separated" radius={0}>
                  <Accordion.Item value="details">
                    <Accordion.Control icon={<IconAdjustmentsHorizontal size={16} />}>
                      <Group gap="xs">
                        <Text size="sm" fw={650}>
                          {t('deviceDetails')}
                        </Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <div className="device-details-grid">
                        <section className="device-detail-section">
                          <Group gap={7}>
                            <IconActivityHeartbeat size={15} />
                            <Text size="sm" fw={650}>
                              {t('deviceInfo')}
                            </Text>
                          </Group>
                          <div className="info-grid">
                            <div className="status-strip">
                              <div className="status-cell">
                                <IconCpu size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('firmware')}
                                  </Text>
                                  <Text
                                    size="xs"
                                    fw={600}
                                    c={session.firmwareVersion === null ? 'dimmed' : undefined}
                                  >
                                    {session.firmwareVersion ?? t('unknown')}
                                  </Text>
                                </span>
                              </div>
                              <div className="status-cell">
                                <IconCode size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('protocol')}
                                  </Text>
                                  <Text
                                    size="xs"
                                    fw={600}
                                    c={session.protocolVersion === null ? 'dimmed' : undefined}
                                  >
                                    {session.protocolVersion ?? t('unknown')}
                                  </Text>
                                </span>
                              </div>
                              <div className="status-cell">
                                <IconDeviceMobile size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('resolution')}
                                  </Text>
                                  <Text
                                    size="xs"
                                    fw={600}
                                    c={activeResolution === null ? 'dimmed' : undefined}
                                  >
                                    {activeResolution?.width && activeResolution.height
                                      ? `${activeResolution.width} × ${activeResolution.height}`
                                      : t('unknown')}
                                  </Text>
                                </span>
                              </div>
                            </div>
                            <div className="status-strip">
                              <div className="status-cell">
                                <IconUsb size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('usb')}
                                  </Text>
                                  <Text
                                    size="xs"
                                    fw={600}
                                    c={connectionStatusColor(session.usbConnected)}
                                  >
                                    {session.usbConnected === null
                                      ? t('unknown')
                                      : session.usbConnected
                                        ? t('available')
                                        : t('unavailable')}
                                  </Text>
                                </span>
                              </div>
                              <div className="status-cell">
                                <IconBluetooth size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('bluetooth')}
                                  </Text>
                                  <Text
                                    size="xs"
                                    fw={600}
                                    c={connectionStatusColor(session.bleConnected)}
                                  >
                                    {session.bleConnected === null
                                      ? t('unknown')
                                      : session.bleConnected
                                        ? t('available')
                                        : t('unavailable')}
                                  </Text>
                                </span>
                              </div>
                              <div className="status-cell">
                                <IconWifi size={16} />
                                <span>
                                  <Text size="xs" c="dimmed">
                                    {t('latency')}
                                  </Text>
                                  <Text size="xs" fw={600} c={latencyStatusColor(session.latency)}>
                                    {session.latency === null ? '—' : `${session.latency} ms`}
                                  </Text>
                                </span>
                              </div>
                            </div>
                            <div className="airplay-settings">
                              <Group justify="space-between" gap="xs">
                                <Group gap={7}>
                                  <IconBroadcast size={15} />
                                  <Text size="sm" fw={650}>
                                    {t('airplaySettings')}
                                  </Text>
                                </Group>
                                <Group gap="md">
                                  <Text size="xs" c="dimmed" ff="monospace">
                                    PID {activeAirplayPid ?? '—'}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                    {t('airplaySettingsHint')}
                                  </Text>
                                </Group>
                              </Group>
                              <div className="airplay-settings-grid">
                                <div className="airplay-settings-field">
                                  <Text className="airplay-settings-field-label">
                                    {t('airplayMaxFps')}
                                  </Text>
                                  <div className="airplay-settings-field-control">
                                    <Select
                                      size="xs"
                                      aria-label={t('airplayMaxFps')}
                                      value={String(selectedDevice.airplay.maxFps)}
                                      allowDeselect={false}
                                      data={[
                                        { value: '15', label: '15 fps' },
                                        { value: '30', label: '30 fps' },
                                        { value: '60', label: '60 fps' }
                                      ]}
                                      onChange={(value) => {
                                        if (value) updateAirplaySetting('maxFps', Number(value))
                                      }}
                                    />
                                  </div>
                                </div>
                                <div className="airplay-settings-field">
                                  <Text className="airplay-settings-field-label">
                                    {t('airplayAudio')}
                                  </Text>
                                  <div className="airplay-settings-field-control">
                                    <Switch
                                      size="xs"
                                      label={t('airplayAudioEnabled')}
                                      checked={selectedDevice.airplay.audioEnabled}
                                      onChange={(event) =>
                                        updateAirplaySetting(
                                          'audioEnabled',
                                          event.currentTarget.checked
                                        )
                                      }
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                            <Divider />
                            <Group gap={8} justify="flex-end">
                              <Button
                                variant="default"
                                size="xs"
                                loading={airplayRestarting}
                                leftSection={<IconReload size={14} />}
                                disabled={!session.isConnected || airplayRestarting}
                                onClick={() => {
                                  setAirplayRestarting(true)
                                  void window.api.airplay
                                    .restart()
                                    .catch((error: unknown) => {
                                      console.error('Unable to restart AirPlay receiver', error)
                                    })
                                    .finally(() => setAirplayRestarting(false))
                                }}
                              >
                                {t('restartAirplayService')}
                              </Button>
                              <Button
                                variant="default"
                                size="xs"
                                disabled={!session.isConnected}
                                onClick={() =>
                                  session.send({
                                    type: 'release_all',
                                    target
                                  })
                                }
                              >
                                {t('releaseAll')}
                              </Button>
                              <Tooltip label={t('refresh')}>
                                <ActionIcon
                                  variant="default"
                                  size={30}
                                  disabled={!session.isConnected}
                                  onClick={() => session.send({ type: 'get_status' })}
                                >
                                  <IconRefresh size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                          </div>
                        </section>
                        <section className="device-detail-section device-log-section">
                          <Group justify="space-between" gap="xs">
                            <Group gap={8}>
                              <IconRoute size={15} />
                              <SegmentedControl
                                size="xs"
                                value={logKind}
                                data={[
                                  { value: 'device', label: t('deviceLog') },
                                  { value: 'airplay', label: t('airplayLogs') }
                                ]}
                                onChange={(value) => setLogKind(value as 'device' | 'airplay')}
                              />
                            </Group>
                            <Button
                              variant="subtle"
                              color="gray"
                              size="compact-xs"
                              onClick={() => {
                                if (logKind === 'device') session.clearLogs()
                                else setAirplayLogs([])
                              }}
                            >
                              {t('clear')}
                            </Button>
                          </Group>
                          <ScrollArea
                            h={264}
                            className="log-view"
                            scrollbarSize={5}
                            viewportRef={logViewportRef}
                          >
                            {visibleLogs.length ? (
                              <pre>{visibleLogs.join('\n')}</pre>
                            ) : (
                              <Text size="xs" c="dimmed" ta="center" py="lg">
                                {logKind === 'device' ? t('noLogs') : t('noAirplayLogs')}
                              </Text>
                            )}
                          </ScrollArea>
                        </section>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              </div>
            </section>
          </>
        )}
      </main>
      {deviceDialog.opened && (
        <DeviceDialog
          opened
          device={library.devices.find((item) => item.id === deviceDialog.deviceId)}
          groups={library.groups}
          initialGroupId={deviceDialog.groupId}
          preferredAddressMode={addressMode}
          t={t}
          onClose={() => setDeviceDialog({ opened: false, groupId: null })}
          onSave={saveDevice}
          onPreferredAddressModeChange={setAddressMode}
        />
      )}
      <Modal
        opened={groupDialog.opened}
        onClose={() => setGroupDialog({ opened: false })}
        title={groupDialog.groupId ? t('rename') : t('addGroup')}
        size="xs"
        centered
      >
        <Stack gap="sm">
          <TextInput
            label={t('groupName')}
            withAsterisk
            value={groupName}
            onChange={(event) => setGroupName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveGroup()
            }}
            autoFocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setGroupDialog({ opened: false })}>
              {t('cancel')}
            </Button>
            <Button onClick={saveGroup} disabled={!groupName.trim()}>
              {groupDialog.groupId ? t('save') : t('create')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={fullKeyboardAccessNoticeOpened}
        onClose={closeFullKeyboardAccessNotice}
        title={
          <Group gap={7}>
            <IconInfoCircle size={17} />
            <Text fw={650}>{t('fullKeyboardAccessTitle')}</Text>
          </Group>
        }
        size="sm"
        centered
      >
        <Stack gap="md">
          <Text size="sm">{t('fullKeyboardAccessHint')}</Text>
          <Checkbox
            label={t('doNotShowAgain')}
            checked={rememberFullKeyboardAccessNotice}
            onChange={(event) => setRememberFullKeyboardAccessNotice(event.currentTarget.checked)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeFullKeyboardAccessNotice}>
              {t('cancel')}
            </Button>
            <Button onClick={confirmShortcut}>{t('continueSend')}</Button>
          </Group>
        </Stack>
      </Modal>
      {contextMenu && (
        <Paper
          className="context-menu"
          shadow="lg"
          radius="md"
          style={{
            left: Math.max(
              6,
              Math.min(
                contextMenu.x,
                window.innerWidth - (contextMenu.type === 'device' ? 390 : 210)
              )
            ),
            top: Math.max(6, Math.min(contextMenu.y, window.innerHeight - 330))
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.type === 'blank' && (
            <>
              <button
                onClick={() => {
                  setDeviceDialog({ opened: true, groupId: null })
                  setContextMenu(null)
                }}
              >
                <IconDeviceDesktop size={15} />
                {t('addDevice')}
              </button>
              <button
                onClick={() => {
                  setGroupName('')
                  setGroupDialog({ opened: true })
                  setContextMenu(null)
                }}
              >
                <IconFolderPlus size={15} />
                {t('addGroup')}
              </button>
            </>
          )}
          {contextMenu.type === 'group' && (
            <>
              <button
                onClick={() => {
                  const group = library.groups.find((item) => item.id === contextMenu.id)
                  setGroupName(group?.name ?? '')
                  setGroupDialog({ opened: true, groupId: contextMenu.id })
                  setContextMenu(null)
                }}
              >
                <IconEdit size={15} />
                {t('rename')}
              </button>
              <button
                onClick={() => {
                  deleteGroup(contextMenu.id)
                  setContextMenu(null)
                }}
                className="danger"
              >
                <IconTrash size={15} />
                {t('deleteGroup')}
              </button>
              <Divider my={4} />
              <button
                onClick={() => {
                  setDeviceDialog({ opened: true, groupId: contextMenu.id })
                  setContextMenu(null)
                }}
              >
                <IconCirclePlus size={15} />
                {t('addDevice')}
              </button>
            </>
          )}
          {contextMenu.type === 'device' && (
            <>
              <button
                onClick={() => {
                  toggleDeviceConnection(contextMenu.id)
                  setContextMenu(null)
                }}
              >
                <IconPlugConnected size={15} />
                {selectedId === contextMenu.id && session.reconnectPending
                  ? t('cancelReconnect')
                  : selectedId === contextMenu.id &&
                      (session.isConnected || session.phase === 'connecting')
                    ? t('disconnect')
                    : t('connect')}
              </button>
              <Divider my={4} />
              <button
                onClick={() => {
                  const device = library.devices.find((item) => item.id === contextMenu.id)
                  setDeviceDialog({
                    opened: true,
                    deviceId: contextMenu.id,
                    groupId: device?.groupId ?? null
                  })
                  setContextMenu(null)
                }}
              >
                <IconEdit size={15} />
                {t('edit')}
              </button>
              <div className="context-submenu">
                <button className="context-submenu-trigger">
                  <IconFolder size={15} />
                  {t('moveTo')}
                  <IconChevronRight className="context-submenu-arrow" size={14} />
                </button>
                <Paper className="context-submenu-panel" shadow="lg" radius="md">
                  <button
                    onClick={() => {
                      moveDevice(contextMenu.id, null)
                      setContextMenu(null)
                    }}
                  >
                    {t('ungrouped')}
                  </button>
                  {library.groups.map((group) => (
                    <button
                      key={group.id}
                      onClick={() => {
                        moveDevice(contextMenu.id, group.id)
                        setContextMenu(null)
                      }}
                    >
                      {group.name}
                    </button>
                  ))}
                </Paper>
              </div>
              <Divider my={4} />
              <button
                className="danger"
                onClick={() => {
                  deleteDevice(contextMenu.id)
                  setContextMenu(null)
                }}
              >
                <IconTrash size={15} />
                {t('delete')}
              </button>
            </>
          )}
        </Paper>
      )}
    </div>
  )
}

export default App
