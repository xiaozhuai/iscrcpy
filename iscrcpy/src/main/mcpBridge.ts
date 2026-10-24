import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { McpReply } from '../shared/mcp'

export class McpBridge {
  private target: WebContents | null = null
  private available = false
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()

  attach(target: WebContents): void {
    this.cancelAll()
    this.target = target
    this.available = false
    target.on('did-start-loading', () => {
      if (this.target === target) {
        this.available = false
        this.cancelAll()
      }
    })
    target.once('destroyed', () => {
      if (this.target === target) {
        this.available = false
        this.cancelAll()
        this.target = null
      }
    })
  }
  ready(sender: WebContents): void {
    if (sender === this.target) this.available = true
  }
  reply(sender: WebContents, reply: McpReply): void {
    if (sender !== this.target || !reply || typeof reply.id !== 'string') return
    const request = this.pending.get(reply.id)
    if (!request) return
    if (typeof reply.error === 'string') request.reject(new Error(reply.error.slice(0, 500)))
    else request.resolve(reply.result)
  }
  call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const target = this.target
    if (!this.available || !target || target.isDestroyed())
      return Promise.reject(new Error('Desktop UI is not ready'))
    if (this.pending.size >= 16)
      return Promise.reject(new Error('Desktop MCP request limit reached'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.pending.delete(id)
        signal.removeEventListener('abort', cancel)
      }
      const cancel = (): void => {
        cleanup()
        if (!target.isDestroyed()) target.send('mcp:cancel', id)
        reject(new Error('MCP operation cancelled or timed out'))
      }
      this.pending.set(id, {
        resolve(value) {
          cleanup()
          resolve(value)
        },
        reject(error) {
          cleanup()
          reject(error)
        }
      })
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
        return
      }
      try {
        target.send('mcp:request', { id, method, params })
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
  cancelAll(): void {
    for (const [id, request] of [...this.pending]) {
      if (this.target && !this.target.isDestroyed()) this.target.send('mcp:cancel', id)
      request.reject(new Error('Desktop connection closed'))
    }
  }
}
