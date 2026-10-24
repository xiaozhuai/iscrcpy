// Relative HID is not absolute touch input. Calibration measures counts across
// the screen; homing bounds accumulated error without trusting a stale position.
import { POINTER_MOTION, pointerSteps } from './pointerMotion'
export interface Point {
  x: number
  y: number
}
export interface PointerProfile {
  width: number
  height: number
  aspect: number
  offsetX?: number
  offsetY?: number
  motion?: string
}
export interface InputContext {
  key: string
  connected: boolean
  ready: boolean
  manual: boolean
  width: number
  height: number
  target: 'usb_preferred' | 'usb' | 'ble'
}
export interface InputPort {
  context(): InputContext
  send(message: Record<string, unknown>): boolean
  flush(): Promise<void>
  sleep?(ms: number): Promise<void>
  now?(): number
}

export class PhoneInput {
  private profiles = new Map<string, PointerProfile>()
  private position: Point | null = null
  private fingerprint = ''
  private operations = 0
  private homedAt = 0
  private preparedAt: number | null = null
  private target: Point | null = null
  private startedAt = 0
  private generation = 0
  private queue: Promise<unknown> = Promise.resolve()
  private queued = 0
  private active = false
  private probe: { key: string; aspect: number; units: number } | null = null
  private observations = new Map<string, { units: number; x: number; y: number }[]>()

  constructor(private port: InputPort) {}

  private profileKey(c: InputContext): string {
    return `${c.key}:${c.target}:${(c.width / c.height).toFixed(2)}`
  }
  status(): Record<string, unknown> {
    const context = this.port.context()
    const profile = this.profiles.get(this.profileKey(context))
    return {
      calibrated: !!this.profiles.get(this.profileKey(context)),
      profile: this.profiles.get(this.profileKey(context)) ?? null,
      position: this.position,
      positionUnits: 'hid-counts',
      busy: this.active,
      gesturesSinceHome: this.operations,
      rehomeEvery: 10,
      rehomeAfterMs: 30000,
      clickReady: this.clickReady(),
      motion: POINTER_MOTION,
      requestedTarget: this.target,
      nominalStep: profile
        ? {
            normalizedX: 1 / profile.width,
            normalizedY: 1 / profile.height,
            framePixelsX: context.width / profile.width,
            framePixelsY: context.height / profile.height
          }
        : null,
      probe: this.probe
    }
  }
  invalidate(): void {
    this.generation++
    this.position = null
    this.probe = null
    this.preparedAt = null
    this.target = null
    if (this.active) this.port.send({ type: 'release_all', target: this.port.context().target })
  }
  loadProfiles(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const entry of value.slice(0, 100)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      // A fit measured with another report size/speed is unsafe to reuse.
      if (entry[1]?.motion !== POINTER_MOTION.id) continue
      try {
        this.validateProfile(entry[1])
        this.profiles.set(entry[0], entry[1])
      } catch {
        /* Ignore invalid storage. */
      }
    }
  }
  savedProfiles(): unknown {
    return [...this.profiles.entries()]
  }
  private validateProfile(p: PointerProfile): void {
    if (
      !p ||
      (p.motion !== undefined && p.motion !== POINTER_MOTION.id) ||
      ![p.width, p.height].every((n) => Number.isFinite(n) && n >= 32 && n <= 12000) ||
      !Number.isFinite(p.aspect) ||
      p.aspect < 0.1 ||
      p.aspect > 10 ||
      ![p.offsetX ?? 0, p.offsetY ?? 0].every((n) => Number.isFinite(n) && Math.abs(n) < 0.1)
    )
      throw new Error('Invalid pointer calibration')
  }
  setProfile(p: PointerProfile): void {
    this.validateProfile(p)
    const c = this.port.context()
    if (Math.abs(p.aspect - c.width / c.height) > 0.03)
      throw new Error('Calibration orientation does not match the current frame')
    this.profiles.set(this.profileKey(c), { ...p, motion: POINTER_MOTION.id })
    this.position = null
    this.probe = null
    this.preparedAt = null
    this.target = null
  }
  private clickReady(): boolean {
    return (
      this.position !== null &&
      this.preparedAt !== null &&
      (this.port.now?.() ?? Date.now()) - this.preparedAt < 30000
    )
  }
  private check(generation: number, signal?: AbortSignal): InputContext {
    signal?.throwIfAborted()
    if (generation !== this.generation)
      throw new Error('Input cancelled: device, orientation or manual control changed')
    const c = this.port.context()
    if (!c.connected || !c.ready)
      throw new Error('Connect the controller and its USB/BLE HID transport first')
    if (c.manual) throw new Error('Manual pointer capture is active; exit it before AI input')
    if (this.fingerprint !== this.profileKey(c)) throw new Error('Input context changed')
    return c
  }
  private async wait(ms: number, generation: number, signal?: AbortSignal): Promise<void> {
    this.check(generation, signal)
    await (this.port.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms)))
    this.check(generation, signal)
  }
  private send(message: Record<string, unknown>, generation: number, signal?: AbortSignal): void {
    const c = this.check(generation, signal)
    if (!this.port.send({ ...message, target: c.target }))
      throw new Error('Controller disconnected during input')
  }
  private async move(
    dx: number,
    dy: number,
    generation: number,
    signal?: AbortSignal,
    durationMs = 0
  ): Promise<void> {
    const movementMs = (Math.abs(dx) + Math.abs(dy)) * POINTER_MOTION.intervalMs
    const elapsed = (this.port.now?.() ?? Date.now()) - this.startedAt
    if (elapsed + Math.max(movementMs, durationMs) > 32000)
      throw new Error(
        'Movement exceeds the 32s input budget; split the path into shorter operations'
      )
    for (const step of pointerSteps(dx, dy)) {
      this.send({ type: 'mouse_move', ...step, wheel: 0, pan: 0 }, generation, signal)
      await this.wait(POINTER_MOTION.intervalMs, generation, signal)
    }
    // durationMs is a minimum hold time; slowing the reports themselves would
    // change pointer gain and invalidate the calibration.
    if (durationMs > movementMs) await this.wait(durationMs - movementMs, generation, signal)
    await this.port.flush()
    this.check(generation, signal)
  }
  private async home(generation: number, signal?: AbortSignal): Promise<void> {
    this.position = null
    this.send({ type: 'release_all' }, generation, signal)
    // Saturate both axes, independent of initial position. No button is held.
    // Larger calibrated spans need more travel than the initial probe default.
    const profile = this.profiles.get(this.fingerprint)
    const distance = Math.max(3000, (profile ? Math.max(profile.width, profile.height) : 0) * 2)
    for (let travelled = 0; travelled < distance; travelled += 127) {
      this.send({ type: 'mouse_move', x: -127, y: -127, wheel: 0, pan: 0 }, generation, signal)
      await this.wait(16, generation, signal)
    }
    await this.port.flush()
    await this.wait(150, generation, signal)
    this.position = { x: 0, y: 0 }
    this.operations = 0
    this.homedAt = this.port.now?.() ?? Date.now()
  }
  private profile(): PointerProfile {
    const profile = this.profiles.get(this.fingerprint)
    if (!profile)
      throw new Error(
        'Pointer is not calibrated. Run pointer_probe and pointer_observe (or pointer_configure) before coordinate actions.'
      )
    return profile
  }
  private async point(p: Point, generation: number, signal?: AbortSignal): Promise<void> {
    const profile = this.profile()
    if (![p.x, p.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
      throw new Error('Coordinates must be normalized to 0..1')
    if (
      !this.position ||
      this.operations >= 10 ||
      (this.port.now?.() ?? Date.now()) - this.homedAt >= 30000
    )
      await this.home(generation, signal)
    const target = {
      x: Math.round(Math.max(0, p.x - (profile.offsetX ?? 0)) * profile.width),
      y: Math.round(Math.max(0, p.y - (profile.offsetY ?? 0)) * profile.height)
    }
    const position = this.position!
    this.position = null
    if (target.x !== position.x || target.y !== position.y) {
      await this.move(target.x - position.x, target.y - position.y, generation, signal)
      // A controller pong acknowledges dispatch, not iOS applying the report.
      // Let the host land before pressing; otherwise the click/drag can start
      // at the old location, especially after homing over BLE.
      await this.wait(180, generation, signal)
    }
    this.position = target
    this.operations++
  }
  async run<T>(operation: (generation: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.queued >= 12) throw new Error('Input queue is full')
    const generation = this.generation
    const fingerprint = this.profileKey(this.port.context())
    this.queued++
    const task = this.queue
      .then(async () => {
        if (generation !== this.generation || fingerprint !== this.profileKey(this.port.context()))
          throw new Error('Queued input context changed')
        if (this.fingerprint !== fingerprint) {
          this.position = null
          this.fingerprint = fingerprint
        }
        this.check(generation, signal)
        this.active = true
        this.startedAt = this.port.now?.() ?? Date.now()
        const cancel = (): void => this.invalidate()
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await operation(generation)
        } catch (error) {
          this.position = null
          throw error
        } finally {
          signal?.removeEventListener('abort', cancel)
          if (
            generation === this.generation &&
            fingerprint === this.profileKey(this.port.context())
          )
            this.port.send({ type: 'release_all', target: this.port.context().target })
          this.active = false
        }
      })
      .finally(() => {
        this.queued--
      })
    this.queue = task.catch(() => undefined)
    return task
  }
  async execute(
    method: string,
    p: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const result = await this.run(async (generation) => {
      const prepared = this.clickReady()
      const previousTarget = this.target
      this.preparedAt = null
      this.target = null
      if (method !== 'pointer_probe' && method !== 'pointer_observe') this.probe = null
      if (method === 'pointer_home') {
        await this.home(generation, signal)
        return this.status()
      }
      if (method === 'pointer_probe') {
        await this.home(generation, signal)
        const units = Number(p.units ?? 50)
        if (!Number.isInteger(units) || units < 25 || units > 500)
          throw new Error('Probe units must be 25..500')
        await this.move(units, units, generation, signal)
        // Firmware pong only acknowledges dispatch, not the BLE/iOS/AirPlay
        // round trip. Allow the probe's visible cursor to reach the mirror.
        await this.wait(300, generation, signal)
        const c = this.port.context()
        this.probe = { key: this.fingerprint, aspect: c.width / c.height, units }
        this.position = null
        return {
          ...this.status(),
          instruction:
            'Locate the pointer in a fresh screenshot and submit its normalized center to pointer_observe. Do not click during calibration.'
        }
      }
      if (method === 'pointer_observe') {
        const probe = this.probe
        if (!probe || probe.key !== this.fingerprint)
          throw new Error('Run pointer_probe in this orientation first')
        const x = Number(p.x),
          y = Number(p.y)
        if (![x, y].every((n) => Number.isFinite(n) && n > 0.03 && n < 0.97))
          throw new Error(
            'Probe pointer must be visible away from screen edges; retry with fewer units if clamped'
          )
        const samples = (this.observations.get(this.fingerprint) ?? []).filter(
          (sample) => sample.units !== probe.units
        )
        samples.push({ units: probe.units, x, y })
        const recent = samples.slice(-6)
        const fit = (axis: 'x' | 'y'): { span: number; offset: number } => {
          if (recent.length < 2) return { span: probe.units / (axis === 'x' ? x : y), offset: 0 }
          const meanUnits = recent.reduce((sum, p) => sum + p.units, 0) / recent.length
          const meanPosition = recent.reduce((sum, p) => sum + p[axis], 0) / recent.length
          const variance = recent.reduce((sum, p) => sum + (p.units - meanUnits) ** 2, 0)
          const slope =
            recent.reduce((sum, p) => sum + (p.units - meanUnits) * (p[axis] - meanPosition), 0) /
            variance
          if (!Number.isFinite(slope) || slope <= 0)
            throw new Error(
              'Probe observations are inconsistent; use two distinct distances and a visible unclamped cursor'
            )
          return { span: 1 / slope, offset: meanPosition - slope * meanUnits }
        }
        const horizontal = fit('x'),
          vertical = fit('y')
        this.setProfile({
          width: horizontal.span,
          height: vertical.span,
          aspect: probe.aspect,
          offsetX: horizontal.offset,
          offsetY: vertical.offset
        })
        this.observations.set(this.fingerprint, recent)
        return this.status()
      }
      if (method === 'pointer_configure') {
        const c = this.port.context()
        this.setProfile({
          width: Number(p.width),
          height: Number(p.height),
          aspect: c.width / c.height,
          offsetX: Number(p.offsetX ?? 0),
          offsetY: Number(p.offsetY ?? 0)
        })
        return this.status()
      }
      if (method === 'pointer_correct') {
        const profile = this.profile(),
          position = this.position
        if (!position || !previousTarget)
          throw new Error('Move to a target first, then observe the cursor in a fresh screenshot')
        const x = Number(p.x),
          y = Number(p.y)
        if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
          throw new Error('Observed cursor coordinates must be normalized to 0..1')
        const errorX = previousTarget.x - x,
          errorY = previousTarget.y - y
        if (Math.max(Math.abs(errorX), Math.abs(errorY)) > 0.06)
          throw new Error(
            'Observed drift is too large to correct safely; rehome or recalibrate instead'
          )
        // Anchor the estimate to the observation. A local landing error must not
        // poison the saved global calibration, especially after acceleration.
        const dx = Math.round(errorX * profile.width),
          dy = Math.round(errorY * profile.height)
        this.position = null
        await this.move(dx, dy, generation, signal)
        await this.wait(180, generation, signal)
        this.position = {
          x: Math.round((x - (profile.offsetX ?? 0)) * profile.width) + dx,
          y: Math.round((y - (profile.offsetY ?? 0)) * profile.height) + dy
        }
        this.target = previousTarget
        this.preparedAt = this.port.now?.() ?? Date.now()
        return this.status()
      }
      if (method === 'mouse_move_relative') {
        this.position = null
        await this.move(Number(p.x), Number(p.y), generation, signal)
      } else if (method === 'pointer_click') {
        if (!prepared)
          throw new Error(
            'No recent prepared cursor. Run pointer_move, inspect a fresh screenshot, then pointer_click within 30 seconds.'
          )
        // Intentionally no point()/home(): preserve the visually checked landing
        // even if the periodic homing deadline just passed.
        this.send(
          { type: 'mouse_button', button: p.button ?? 'left', pressed: true },
          generation,
          signal
        )
        await this.wait(60, generation, signal)
        this.send(
          { type: 'mouse_button', button: p.button ?? 'left', pressed: false },
          generation,
          signal
        )
        await this.wait(150, generation, signal)
      } else if (method === 'pointer_move' || method === 'tap' || method === 'long_press') {
        await this.point({ x: Number(p.x), y: Number(p.y) }, generation, signal)
        if (method === 'pointer_move') {
          this.preparedAt = this.port.now?.() ?? Date.now()
          this.target = { x: Number(p.x), y: Number(p.y) }
        }
        if (method !== 'pointer_move') {
          const count = Number(p.count ?? 1)
          for (let i = 0; i < count; i++) {
            this.send(
              { type: 'mouse_button', button: p.button ?? 'left', pressed: true },
              generation,
              signal
            )
            await this.wait(
              method === 'long_press' ? Number(p.durationMs ?? 700) : 60,
              generation,
              signal
            )
            this.send(
              { type: 'mouse_button', button: p.button ?? 'left', pressed: false },
              generation,
              signal
            )
            await this.wait(150, generation, signal)
          }
        }
      } else if (method === 'swipe' || method === 'drag') {
        const points = p.points as Point[]
        await this.point(points[0], generation, signal)
        const profile = this.profile()
        const segmentMs = Number(p.durationMs ?? 500) / (points.length - 1)
        const units = points.map((point) => ({
          x: Math.round(Math.max(0, point.x - (profile.offsetX ?? 0)) * profile.width),
          y: Math.round(Math.max(0, point.y - (profile.offsetY ?? 0)) * profile.height)
        }))
        const gestureMs = units
          .slice(1)
          .reduce(
            (total, point, index) =>
              total +
              Math.max(
                segmentMs,
                (Math.abs(point.x - units[index].x) + Math.abs(point.y - units[index].y)) *
                  POINTER_MOTION.intervalMs
              ),
            0
          )
        if ((this.port.now?.() ?? Date.now()) - this.startedAt + gestureMs > 32000)
          throw new Error('Gesture exceeds the 32s input budget; split the path before dragging')
        this.send({ type: 'mouse_button', button: 'left', pressed: true }, generation, signal)
        await this.wait(80, generation, signal)
        // Deliberately no homing while a drag holds the button down.
        for (const point of points.slice(1)) {
          const next = {
            x: Math.round(Math.max(0, point.x - (profile.offsetX ?? 0)) * profile.width),
            y: Math.round(Math.max(0, point.y - (profile.offsetY ?? 0)) * profile.height)
          }
          const previous = this.position!
          this.position = null
          await this.move(
            next.x - previous.x,
            next.y - previous.y,
            generation,
            signal,
            Number(p.durationMs ?? 500) / (points.length - 1)
          )
          this.position = next
        }
        if (p.settle !== false) await this.wait(250, generation, signal)
        this.send({ type: 'mouse_button', button: 'left', pressed: false }, generation, signal)
        // Edge clamping and iOS gestures can change the physical cursor mapping.
        if (
          points.some(
            (point) => point.x < 0.02 || point.y < 0.02 || point.x > 0.98 || point.y > 0.98
          )
        )
          this.position = null
      } else if (method === 'scroll') {
        if (p.x !== undefined && p.y !== undefined)
          await this.point({ x: Number(p.x), y: Number(p.y) }, generation, signal)
        let wheel = Number(p.wheel ?? 0),
          pan = Number(p.pan ?? 0)
        while (wheel || pan) {
          const w = Math.max(-8, Math.min(8, wheel)),
            h = Math.max(-8, Math.min(8, pan))
          this.send({ type: 'mouse_move', x: 0, y: 0, wheel: w, pan: h }, generation, signal)
          wheel -= w
          pan -= h
          await this.wait(30, generation, signal)
        }
      } else if (method === 'key_press') {
        const keys = p.usages as number[]
        for (const usage of keys) {
          this.send({ type: 'key', action: 'down', usage }, generation, signal)
          await this.wait(20, generation, signal)
        }
        await this.wait(Number(p.durationMs ?? 60), generation, signal)
        for (const usage of [...keys].reverse())
          this.send({ type: 'key', action: 'up', usage }, generation, signal)
      } else if (method === 'type_text') {
        const text = String(p.text)
        const strokes = [...text].map((character) => asciiKey(character)) // Validate everything before typing.
        for (const { usage, shift } of strokes) {
          if (shift) this.send({ type: 'key', action: 'down', usage: 0xe1 }, generation, signal)
          this.send({ type: 'key', action: 'down', usage }, generation, signal)
          await this.wait(25, generation, signal)
          this.send({ type: 'key', action: 'up', usage }, generation, signal)
          if (shift) this.send({ type: 'key', action: 'up', usage: 0xe1 }, generation, signal)
          await this.wait(25, generation, signal)
        }
      } else if (method === 'release_all') {
        this.position = null
      } else throw new Error('Unknown input operation')
      this.send({ type: 'release_all' }, generation, signal)
      await this.port.flush()
      this.check(generation, signal)
      return this.status()
    }, signal)
    return { ...result, busy: this.active }
  }
}

export function asciiKey(character: string): { usage: number; shift: boolean } {
  if (/^[a-z]$/i.test(character))
    return {
      usage: character.toLowerCase().charCodeAt(0) - 97 + 4,
      shift: character !== character.toLowerCase()
    }
  if (/^[0-9]$/.test(character))
    return { usage: character === '0' ? 0x27 : 0x1e + Number(character) - 1, shift: false }
  const plain = " -=[]\\;',./`",
    shifted = ' _+{}|:"<>?~'
  const usages = [0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x36, 0x37, 0x38, 0x35]
  let index = plain.indexOf(character)
  if (index >= 0) return { usage: usages[index], shift: false }
  index = shifted.indexOf(character)
  if (index >= 0) return { usage: usages[index], shift: true }
  index = '!@#$%^&*()'.indexOf(character)
  if (index >= 0) return { usage: index === 9 ? 0x27 : 0x1e + index, shift: true }
  if (character === '\n' || character === '\t')
    return { usage: character === '\n' ? 0x28 : 0x2b, shift: false }
  throw new Error(
    'type_text supports US-layout ASCII, newline and tab only; Unicode/IME text is not silently transliterated'
  )
}
