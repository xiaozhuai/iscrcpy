// Optional adapter for clients that support stdio but not Streamable HTTP.
// stdout is exclusively MCP JSON-RPC; credentials are never printed.
import { createInterface } from 'node:readline'
import { isIP } from 'node:net'

const endpoint = new URL(process.env.ISCRCPY_MCP_URL || 'http://127.0.0.1:2787/mcp')
const token = process.env.ISCRCPY_MCP_TOKEN
if (
  endpoint.protocol !== 'http:' ||
  (endpoint.hostname !== 'localhost' && !isIP(endpoint.hostname.replace(/^\[|\]$/g, ''))) ||
  endpoint.pathname !== '/mcp' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  !token
) {
  console.error(
    'Set ISCRCPY_MCP_TOKEN and an http://<IP-or-localhost>:<port>/mcp endpoint from desktop Settings. Remote HTTP requires a trusted network.'
  )
  process.exit(1)
}
const pending = new Map()
let version = '2025-11-25'
const output = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
async function forward(message) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40000)
  const key = message.id
  if (key !== undefined) pending.set(key, controller)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version
      },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: controller.signal
    })
    if (response.status === 202 || response.status === 204) return
    if (!response.ok) throw new Error(`Desktop MCP returned HTTP ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty MCP response')
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 20 * 1024 * 1024) {
        await reader.cancel()
        throw new Error('MCP response exceeds size limit')
      }
      chunks.push(Buffer.from(value))
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const replies = response.headers.get('content-type')?.includes('text/event-stream')
      ? body
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(body)]
    for (const reply of replies) {
      if (message.method === 'initialize' && reply.result?.protocolVersion)
        version = reply.result.protocolVersion
      output(reply)
    }
  } catch (error) {
    if (message.id !== undefined)
      output({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: controller.signal.aborted ? 'MCP request cancelled or timed out' : error.message
        }
      })
  } finally {
    clearTimeout(timer)
    if (pending.get(key) === controller) pending.delete(key)
  }
}
for await (const line of input) {
  try {
    if (Buffer.byteLength(line) > 65536) throw new Error('Request exceeds size limit')
    const message = JSON.parse(line)
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      throw new Error('Expected a JSON-RPC request/notification')
    if (message.method === 'notifications/cancelled') {
      pending.get(message.params?.requestId)?.abort()
      continue
    }
    if (pending.size >= 8 || (message.id !== undefined && pending.has(message.id)))
      throw new Error('Too many requests or duplicate request ID')
    void forward(message)
  } catch (error) {
    output({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } })
  }
}
for (const controller of pending.values()) controller.abort()
