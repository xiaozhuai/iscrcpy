import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconRobot, IconRobotOff } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Locale } from './types'
import { translate } from './i18n'
import {
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  normalizeMcpHost,
  isMcpLoopback,
  mcpClientUrl,
  type McpState,
  type McpConfiguration
} from '../../shared/mcp'

const labels = {
  'zh-CN': {
    title: 'AI 控制 / MCP',
    hint: '开启后，持有令牌的 AI 客户端可控制手机并获取 iPhone 画面和声音。默认仅监听本机；关闭会取消执行并释放输入。',
    host: '监听地址',
    hostHint: 'IPv4、IPv6 或 localhost；默认 127.0.0.1',
    apply: '保存监听设置',
    cancel: '取消',
    confirm: '确认更改',
    confirmRestart: '确认并重启',
    invalid: '请输入有效的 IPv4、IPv6 或 localhost，以及 1–65535 的端口。',
    remoteTitle: '监听地址安全警告',
    restartTitle: '需要重启 MCP',
    remoteWarning:
      '这不是本地回环地址，其他主机可能访问此 MCP 服务。持有令牌者可操控手机并获取画面和声音。HTTP 未加密，令牌和数据可能被窃听；请仅在可信网络使用，不要暴露到互联网。',
    restartWarning:
      '修改监听地址或端口需要重启 MCP，会取消当前 AI 请求并断开 MCP 连接。不会重启 AirPlay，暂停状态和令牌将保留。是否现在重启？',
    wildcardHint:
      '监听所有网卡时，远程客户端请使用这台电脑可访问的 IP 地址；下方配置使用本机回环地址。',
    port: '端口',
    config: '显示连接配置',
    hide: '隐藏连接配置',
    copy: '复制配置',
    rotate: '更换令牌',
    active: '正在执行',
    idle: '最近工具',
    disabled: '尚未开启',
    paused: 'AI 访问已暂停',
    pause: '暂停 AI 访问',
    resume: '恢复 AI 访问'
  },
  'zh-TW': {
    title: 'AI 控制 / MCP',
    hint: '開啟後，持有權杖的 AI 用戶端可控制手機並取得 iPhone 畫面和聲音。預設僅監聽本機；關閉會取消執行並釋放輸入。',
    host: '監聽位址',
    hostHint: 'IPv4、IPv6 或 localhost；預設 127.0.0.1',
    apply: '儲存監聽設定',
    cancel: '取消',
    confirm: '確認變更',
    confirmRestart: '確認並重新啟動',
    invalid: '請輸入有效的 IPv4、IPv6 或 localhost，以及 1–65535 的連接埠。',
    remoteTitle: '監聽位址安全警告',
    restartTitle: '需要重新啟動 MCP',
    remoteWarning:
      '這不是本機回環位址，其他主機可能存取此 MCP 服務。持有權杖者可操控手機並取得畫面和聲音。HTTP 未加密，權杖和資料可能遭竊聽；請僅在可信任網路使用，不要暴露至網際網路。',
    restartWarning:
      '變更監聽位址或連接埠需要重新啟動 MCP，將取消目前 AI 請求並中斷 MCP 連線。不會重新啟動 AirPlay，暫停狀態和權杖將保留。是否現在重新啟動？',
    wildcardHint:
      '監聽所有網路介面時，遠端用戶端請使用這台電腦可連線的 IP 位址；下方設定使用本機回環位址。',
    port: '連接埠',
    config: '顯示連線設定',
    hide: '隱藏連線設定',
    copy: '複製設定',
    rotate: '更換權杖',
    active: '執行中',
    idle: '最近工具',
    disabled: '尚未啟用',
    paused: 'AI 存取已暫停',
    pause: '暫停 AI 存取',
    resume: '恢復 AI 存取'
  },
  en: {
    title: 'AI control / MCP',
    hint: 'AI clients holding the token can control the phone and obtain its screen/audio. Defaults to loopback-only listening. Disabling cancels calls and releases input.',
    host: 'Listen address',
    hostHint: 'IPv4, IPv6 or localhost; default 127.0.0.1',
    apply: 'Save listener settings',
    cancel: 'Cancel',
    confirm: 'Confirm change',
    confirmRestart: 'Confirm and restart',
    invalid: 'Enter a valid IPv4/IPv6 address or localhost, and a port from 1 to 65535.',
    remoteTitle: 'Listener security warning',
    restartTitle: 'Restart MCP required',
    remoteWarning:
      'This is not a loopback address. Other hosts may reach MCP; anyone holding the token can control the phone and obtain its screen/audio. HTTP is not encrypted, so tokens and data may be intercepted. Use a trusted network only; do not expose this service to the Internet.',
    restartWarning:
      'Changing the listen address or port requires restarting MCP, cancelling active AI requests and disconnecting MCP clients. AirPlay will not restart; pause state and token are preserved. Restart now?',
    wildcardHint:
      'For wildcard listeners, remote clients must use a reachable IP address of this computer. The configuration below uses its loopback address.',
    port: 'Port',
    config: 'Show connection config',
    hide: 'Hide connection config',
    copy: 'Copy config',
    rotate: 'Rotate token',
    active: 'Executing',
    idle: 'Last tool',
    disabled: 'Disabled',
    paused: 'AI access is paused',
    pause: 'Pause AI access',
    resume: 'Resume AI access'
  }
}

interface McpPanelProps {
  locale: Locale
  autoPauseAiOnCapture: boolean
  onAutoPauseAiOnCaptureChange: (enabled: boolean) => void
}

export function McpPanel({
  locale,
  autoPauseAiOnCapture,
  onAutoPauseAiOnCaptureChange
}: McpPanelProps): React.JSX.Element {
  const [state, setState] = useState<McpState | null>(null)
  const [host, setHost] = useState(DEFAULT_MCP_HOST)
  const [port, setPort] = useState<number | string>(DEFAULT_MCP_PORT)
  const [busy, setBusy] = useState(false)
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<McpConfiguration | null>(null)
  const endpointRef = useRef<string | null>(null)
  const text = labels[locale]
  const acceptState = useCallback((value: McpState): void => {
    setState(value)
    const endpoint = `${value.host}:${value.port}`
    if (endpointRef.current !== endpoint) {
      endpointRef.current = endpoint
      setHost(value.host)
      setPort(value.port)
    }
  }, [])
  useEffect(() => {
    if (!window.api.mcp) return
    let alive = true
    void window.api.mcp
      .getState()
      .then((value) => {
        if (alive) {
          acceptState(value)
        }
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
    const remove = window.api.mcp.onState(acceptState)
    return () => {
      alive = false
      remove()
    }
  }, [acceptState])
  const configure = async (value: McpConfiguration): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      acceptState(await window.api.mcp.configure(value))
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const requestConfigure = (enabled: boolean, rotateToken = false, useDraft = true): void => {
    if (!state) return
    setError('')
    try {
      const address = useDraft ? normalizeMcpHost(host) : state.host
      const listenPort = useDraft ? Number(port) : state.port
      if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)
        throw new Error(text.invalid)
      const changed = address !== state.host || listenPort !== state.port
      const value: McpConfiguration = {
        enabled,
        host: address,
        port: listenPort,
        rotateToken,
        restart: state.enabled && enabled && changed,
        allowRemote:
          !isMcpLoopback(address) && (address !== state.host || (enabled && !state.enabled))
      }
      if (value.restart || value.allowRemote) setPending(value)
      else if (changed || enabled !== state.enabled || rotateToken) void configure(value)
      else {
        setHost(address)
        setPort(listenPort)
      }
    } catch {
      setError(text.invalid)
    }
  }
  let draftHost = host.trim()
  try {
    draftHost = normalizeMcpHost(host)
  } catch {
    /* Validate on save. */
  }
  const dirty = !!state && (draftHost !== state.host || Number(port) !== state.port)
  const config = JSON.stringify(
    {
      mcpServers: {
        iscrcpy: {
          url:
            state?.url ??
            mcpClientUrl(state?.host ?? DEFAULT_MCP_HOST, state?.port ?? DEFAULT_MCP_PORT),
          headers: { Authorization: `Bearer ${state?.token ?? ''}` }
        }
      }
    },
    null,
    2
  )
  return (
    <Paper className="utility-card" p="lg" radius="md" mt="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={650}>{text.title}</Text>
          <Text size="sm" c="dimmed" mt={4}>
            {text.hint}
          </Text>
        </div>
        <Switch
          aria-label={text.title}
          checked={state?.enabled ?? false}
          disabled={busy || !state}
          onChange={(event) =>
            requestConfigure(event.currentTarget.checked, false, event.currentTarget.checked)
          }
        />
      </Group>
      <Stack gap="sm" mt="md">
        <Group align="flex-start">
          <TextInput
            label={text.host}
            aria-label={text.host}
            description={text.hostHint}
            inputWrapperOrder={['label', 'input', 'description', 'error']}
            value={host}
            disabled={busy || !state}
            onChange={(event) => setHost(event.currentTarget.value)}
            w={280}
          />
          <NumberInput
            label={text.port}
            aria-label={text.port}
            value={port}
            min={1}
            max={65535}
            allowDecimal={false}
            w={150}
            disabled={busy || !state}
            onChange={setPort}
          />
        </Group>
        <Button
          size="compact-xs"
          variant="light"
          disabled={!dirty || busy || !state}
          onClick={() => requestConfigure(state!.enabled)}
        >
          {text.apply}
        </Button>
        {(state?.host === '0.0.0.0' || state?.host === '::') && (
          <Text size="xs" c="dimmed">
            {text.wildcardHint}
          </Text>
        )}
        <Text size="xs">{state?.url ?? text.disabled}</Text>
        {state?.paused && (
          <Text size="xs" c="orange">
            {text.paused}
          </Text>
        )}
        {state?.lastTool && (
          <Text size="xs" c={state.activeRequests ? 'orange' : 'dimmed'}>
            {state.activeRequests ? text.active : text.idle}: {state.lastTool}
          </Text>
        )}
        {(error || state?.error) && (
          <Text size="xs" c="red">
            {error || state?.error}
          </Text>
        )}
        <Group gap="xs">
          <Button size="compact-xs" variant="default" onClick={() => setShow(!show)}>
            {show ? text.hide : text.config}
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            disabled={!state || busy}
            onClick={() => requestConfigure(state?.enabled ?? false, true, false)}
          >
            {text.rotate}
          </Button>
        </Group>
        {show && (
          <>
            <Textarea
              aria-label="MCP client configuration"
              value={config}
              readOnly
              minRows={6}
              autosize
              maxRows={12}
            />
            <Button
              size="compact-xs"
              variant="light"
              onClick={() =>
                void navigator.clipboard.writeText(config).catch((error) => setError(String(error)))
              }
            >
              {text.copy}
            </Button>
          </>
        )}
      </Stack>
      <Divider my="lg" />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={650}>{translate(locale, 'autoPauseAiOnCapture')}</Text>
          <Text size="sm" c="dimmed" mt={4}>
            {translate(locale, 'autoPauseAiOnCaptureDescription')}
          </Text>
        </div>
        <Switch
          aria-label={translate(locale, 'autoPauseAiOnCapture')}
          checked={autoPauseAiOnCapture}
          onChange={(event) => onAutoPauseAiOnCaptureChange(event.currentTarget.checked)}
        />
      </Group>
      <Modal
        opened={pending !== null}
        onClose={() => setPending(null)}
        centered
        title={pending?.allowRemote ? text.remoteTitle : text.restartTitle}
      >
        <Stack gap="md">
          <Text size="sm" ff="monospace">
            {pending?.host} / {pending?.port}
          </Text>
          {pending?.allowRemote && (
            <Text size="sm" c="red">
              {text.remoteWarning}
            </Text>
          )}
          {pending?.restart && <Text size="sm">{text.restartWarning}</Text>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPending(null)}>
              {text.cancel}
            </Button>
            <Button
              color={pending?.allowRemote ? 'red' : 'blue'}
              onClick={() => {
                if (!pending) return
                const value = pending
                setPending(null)
                void configure(value)
              }}
            >
              {pending?.restart ? text.confirmRestart : text.confirm}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  )
}

export function McpAccessButton({ locale }: { locale: Locale }): React.JSX.Element | null {
  const [state, setState] = useState<McpState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!window.api.mcp) return
    let alive = true
    void window.api.mcp.getState().then((value) => {
      if (alive) setState(value)
    })
    const remove = window.api.mcp.onState(setState)
    return () => {
      alive = false
      remove()
    }
  }, [])
  if (!state?.enabled) return null
  const label = state.paused ? labels[locale].resume : labels[locale].pause
  return (
    <Tooltip label={label}>
      <ActionIcon
        size={26}
        aria-label={label}
        aria-pressed={state.paused}
        color={state.paused ? 'red' : undefined}
        variant={state.paused ? 'light' : 'default'}
        loading={busy}
        onClick={() => {
          setBusy(true)
          void window.api.mcp
            .setPaused(!state.paused)
            .catch((error) =>
              notifications.show({ color: 'red', title: label, message: String(error) })
            )
            .finally(() => setBusy(false))
        }}
      >
        {state.paused ? <IconRobotOff size={15} /> : <IconRobot size={15} />}
      </ActionIcon>
    </Tooltip>
  )
}
