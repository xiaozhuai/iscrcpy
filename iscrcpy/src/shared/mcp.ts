export interface McpState {
  enabled: boolean
  paused: boolean
  host: string
  port: number
  url: string | null
  token: string
  activeRequests: number
  lastTool: string | null
  lastActivityAt: number | null
  error: string | null
}

export interface McpRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface PhoneFrame {
  data: string
  mimeType: 'image/png'
  width: number
  height: number
  // Decoded AirPlay source dimensions before screenshot downscaling, NOT the
  // physical display resolution (e.g. iPhone 12 Pro is 1170 x 2532).
  sourceWidth: number
  sourceHeight: number
  capturedAt: number
}

export interface McpReply {
  id: string
  result?: unknown
  error?: string
}

export const DEFAULT_MCP_PORT = 2787
export const DEFAULT_MCP_HOST = '127.0.0.1'

export interface McpConfiguration {
  enabled: boolean
  host: string
  port: number
  rotateToken?: boolean
  restart?: boolean
  allowRemote?: boolean
}

// Accept explicit IP literals and localhost, not URLs, ports or arbitrary DNS
// names whose resolution could change after the user approves the warning.
export function normalizeMcpHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MCP address must be an IP address or localhost')
  let host = value.trim().toLowerCase()
  if (host === 'localhost') return host
  if (
    /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host) &&
    host.split('.').every((part) => Number(part) <= 255)
  )
    return host
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.includes(':') && /^[a-f0-9:.]+$/.test(host)) {
    try {
      return new URL(`http://[${host}]/`).hostname.slice(1, -1)
    } catch {
      /* Invalid IPv6. */
    }
  }
  throw new Error('MCP address must be an IPv4/IPv6 address or localhost, without a port')
}

export function mcpHostKey(value: string): string {
  const host = normalizeMcpHost(value)
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host)
  if (!mapped) return host
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16)
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.')
}

export function isMcpLoopback(value: string): boolean {
  const host = mcpHostKey(value)
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

export function mcpClientUrl(value: string, port: number): string {
  let host = normalizeMcpHost(value)
  // Wildcards are bind addresses, not usable addresses for a remote client.
  if (host === '0.0.0.0') host = DEFAULT_MCP_HOST
  if (host === '::') host = '::1'
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`
}

export function validateMcpConfiguration(
  value: unknown,
  current: Pick<McpState, 'enabled' | 'host' | 'port'>
): McpConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MCP configuration')
  const c = value as Record<string, unknown>
  const host = normalizeMcpHost(c.host ?? current.host)
  if (
    typeof c.enabled !== 'boolean' ||
    !Number.isInteger(c.port) ||
    Number(c.port) < 1 ||
    Number(c.port) > 65535
  )
    throw new Error('MCP requires enabled=true/false and a port from 1..65535')
  for (const key of ['rotateToken', 'restart', 'allowRemote'])
    if (c[key] !== undefined && typeof c[key] !== 'boolean')
      throw new Error('Invalid MCP confirmation')
  const changed = host !== current.host || c.port !== current.port
  if (current.enabled && c.enabled && changed && c.restart !== true)
    throw new Error('Confirm restarting MCP before changing its listener')
  if (
    !isMcpLoopback(host) &&
    (host !== current.host || (c.enabled && !current.enabled)) &&
    c.allowRemote !== true
  )
    throw new Error('Confirm the security warning before using a non-loopback MCP address')
  return {
    enabled: c.enabled,
    host,
    port: Number(c.port),
    rotateToken: c.rotateToken === true,
    restart: c.restart === true,
    allowRemote: c.allowRemote === true
  }
}
