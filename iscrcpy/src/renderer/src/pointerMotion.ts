// Keep report magnitude AND cadence identical for probes and coordinate input.
// Simultaneous x/y reports have a larger vector magnitude than axis reports;
// interleave unit axis steps instead so iOS sees the same speed in every direction.
export const POINTER_MOTION = {
  id: 'axis-unit-16ms-v1',
  countsPerReport: 1,
  intervalMs: 16
} as const

export function* pointerSteps(dx: number, dy: number): Generator<{ x: number; y: number }> {
  if (![dx, dy].every(Number.isSafeInteger))
    throw new Error('HID displacement must be integer counts')
  const width = Math.abs(dx),
    height = Math.abs(dy)
  let x = 0,
    y = 0
  while (x < width || y < height) {
    if (x < width && (y === height || (x + 0.5) * height <= (y + 0.5) * width)) {
      x++
      yield { x: Math.sign(dx), y: 0 }
    } else {
      y++
      yield { x: 0, y: Math.sign(dy) }
    }
  }
}
