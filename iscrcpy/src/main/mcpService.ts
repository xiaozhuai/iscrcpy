import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createPhoneTools, type McpBackend } from './mcpTools'
import {
  DEFAULT_MCP_PORT,
  DEFAULT_MCP_HOST,
  normalizeMcpHost,
  mcpHostKey,
  isMcpLoopback,
  mcpClientUrl,
  type McpState
} from '../shared/mcp'

export class McpService extends EventEmitter {
  private server: Server | null = null
  private controller = new AbortController()
  private accessController = new AbortController()
  private handler: ReturnType<typeof createMcpHandler> | null = null
  private state: McpState = {
    enabled: false,
    paused: false,
    host: DEFAULT_MCP_HOST,
    port: DEFAULT_MCP_PORT,
    url: null,
    token: randomBytes(32).toString('hex'),
    activeRequests: 0,
    lastTool: null,
    lastActivityAt: null,
    error: null
  }
  constructor(private backend: McpBackend) {
    super()
  }
  getState(): McpState {
    return { ...this.state }
  }
  setPaused(paused: boolean): McpState {
    if (!this.state.enabled) throw new Error('Enable MCP before pausing or resuming AI access')
    if (paused === this.state.paused) return this.getState()
    this.state.paused = paused
    if (paused) this.accessController.abort()
    else this.accessController = new AbortController()
    this.publish()
    return this.getState()
  }
  configureInactive(
    port: number,
    token: string,
    paused = this.state.paused,
    host = this.state.host
  ): McpState {
    host = normalizeMcpHost(host)
    if (
      this.server ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[a-f0-9]{64}$/.test(token) ||
      typeof paused !== 'boolean'
    )
      throw new Error('Invalid inactive MCP configuration')
    this.state.port = port
    this.state.token = token
    this.state.paused = paused
    this.state.host = host
    this.state.error = null
    this.publish()
    return this.getState()
  }
  private publish(): void {
    this.emit('state', this.getState())
  }
  async start(
    port = DEFAULT_MCP_PORT,
    token = this.state.token,
    paused = this.state.paused,
    host = this.state.host
  ): Promise<McpState> {
    host = normalizeMcpHost(host)
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !/^[a-f0-9]{64}$/.test(token) ||
      typeof paused !== 'boolean'
    )
      throw new Error('Invalid MCP port/token')
    await this.stop()
    this.controller = new AbortController()
    this.accessController = new AbortController()
    const controller = this.controller
    this.state = { ...this.state, host, port, token, paused, error: null }
    this.handler = createMcpHandler(
      () =>
        createPhoneTools(async (method, params, signal) => {
          if (this.state.paused)
            throw new Error(
              'AI access is paused by the user. Wait for the user to resume it in the desktop toolbar.'
            )
          const combined = AbortSignal.any([
            signal,
            controller.signal,
            this.accessController.signal,
            AbortSignal.timeout(35000)
          ])
          combined.throwIfAborted()
          this.state.activeRequests++
          this.state.lastTool = method
          this.state.lastActivityAt = Date.now()
          this.publish()
          try {
            return await this.backend(method, params, combined)
          } finally {
            this.state.activeRequests--
            this.publish()
          }
        }),
      { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: 65536, maxSubscriptions: 0 }
    )
    const handle = toNodeHandler(this.handler, { maxRequestBodySize: 65536 })
    const expected = Buffer.from(token)
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      const reject = (status: number): void => {
        response.writeHead(status)
        response.end()
      }
      const allowedAddress = (address: URL): boolean => {
        if (
          address.protocol !== 'http:' ||
          address.username ||
          address.password ||
          Number(address.port || 80) !== this.state.port
        )
          return false
        try {
          const requested = normalizeMcpHost(address.hostname)
          const local = normalizeMcpHost(request.socket.localAddress ?? host)
          return (
            mcpHostKey(requested) === mcpHostKey(local) ||
            requested === host ||
            (isMcpLoopback(requested) && isMcpLoopback(local))
          )
        } catch {
          return false
        }
      }
      let address: URL
      try {
        address = new URL(`http://${request.headers.host}`)
      } catch {
        reject(403)
        return
      }
      if (!allowedAddress(address) || address.pathname !== '/' || address.search || address.hash) {
        reject(403)
        return
      }
      if (request.headers.origin) {
        try {
          const origin = new URL(request.headers.origin)
          if (!allowedAddress(origin) || origin.pathname !== '/' || origin.search || origin.hash) {
            reject(403)
            return
          }
        } catch {
          reject(403)
          return
        }
      }
      const authorization = request.headers.authorization
      const auth = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '')
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="iscrcpy"')
        reject(401)
        return
      }
      if (request.url !== '/mcp') {
        reject(404)
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        reject(405)
        return
      }
      if (this.state.activeRequests >= 8) {
        reject(429)
        return
      }
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    server.requestTimeout = 40000
    server.headersTimeout = 5000
    server.maxConnections = 32
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('MCP listener has no address')
      this.state.port = address.port
      this.state.enabled = true
      this.state.url = mcpClientUrl(host, address.port)
      server.on('error', (error) => {
        this.state.error = error.message
        this.publish()
      })
      this.publish()
      return this.getState()
    } catch (error) {
      await this.stop()
      this.state.error = error instanceof Error ? error.message : 'MCP failed to start'
      this.publish()
      throw error
    }
  }
  async stop(): Promise<McpState> {
    this.controller.abort()
    const server = this.server
    this.server = null
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    await this.handler?.close()
    this.handler = null
    this.state.enabled = false
    this.state.url = null
    this.publish()
    return this.getState()
  }
}
