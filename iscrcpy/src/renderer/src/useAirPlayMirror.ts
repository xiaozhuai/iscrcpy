import { useEffect, useRef, useState } from 'react'
import type { AirplayState, AirplayVideoChunk } from '../../shared/airplay'

const MAX_DECODE_QUEUE = 12
const initialAirplayState: AirplayState = {
  phase: 'stopped',
  serviceName: null,
  error: null,
  pid: null
}

function annexBNalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let start = -1
  for (let index = 0; index + 2 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
      if (start >= 0) units.push(data.subarray(start, index))
      start = index + 3
      index += 2
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start))
  return units
}

function codecString(data: Uint8Array): string | null {
  const sps = annexBNalUnits(data).find((nal) => (nal[0] & 0x1f) === 7)
  if (!sps || sps.length < 4) return null
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

export interface AirPlayMirror {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  state: AirplayState
  decoderError: string | null
  hasVideo: boolean
  videoSize: { width: number; height: number } | null
}

export function useAirPlayMirror(): AirPlayMirror {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const decoderRef = useRef<VideoDecoder | null>(null)
  const codecRef = useRef<string | null>(null)
  const pendingFrameRef = useRef<VideoFrame | null>(null)
  const renderFrameRef = useRef(0)
  const hasVideoRef = useRef(false)
  const [state, setState] = useState<AirplayState>(initialAirplayState)
  const [decoderError, setDecoderError] = useState<string | null>(null)
  const [hasVideo, setHasVideo] = useState(false)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    let disposed = false

    const clearCanvas = (): void => {
      setHasVideo(false)
      hasVideoRef.current = false
      setVideoSize(null)
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
    }

    const closeDecoder = (clear = true): void => {
      if (renderFrameRef.current) {
        cancelAnimationFrame(renderFrameRef.current)
        renderFrameRef.current = 0
      }
      pendingFrameRef.current?.close()
      pendingFrameRef.current = null
      const decoder = decoderRef.current
      decoderRef.current = null
      codecRef.current = null
      if (decoder && decoder.state !== 'closed') decoder.close()
      if (clear) clearCanvas()
    }

    const clearVisibleFrame = (): void => {
      if (renderFrameRef.current) {
        cancelAnimationFrame(renderFrameRef.current)
        renderFrameRef.current = 0
      }
      pendingFrameRef.current?.close()
      pendingFrameRef.current = null
      clearCanvas()
      window.api.airplay.reportLog('Cleared visible frame while waiting')
    }

    const drawPendingFrame = (): void => {
      renderFrameRef.current = 0
      const frame = pendingFrameRef.current
      pendingFrameRef.current = null
      const canvas = canvasRef.current
      if (!frame || !canvas) {
        frame?.close()
        return
      }

      const context = canvas.getContext('2d', {
        alpha: false,
        desynchronized: true
      })
      if (!context) {
        frame.close()
        return
      }

      const targetWidth = frame.displayWidth
      const targetHeight = frame.displayHeight
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth
        canvas.height = targetHeight
      }
      context.drawImage(frame, 0, 0, targetWidth, targetHeight)
      const sourceWidth = frame.displayWidth
      const sourceHeight = frame.displayHeight
      frame.close()

      if (!hasVideoRef.current) {
        hasVideoRef.current = true
        setHasVideo(true)
        window.api.airplay.reportLog(`Decoded frame ${sourceWidth}x${sourceHeight}`)
      }
      setVideoSize((current) =>
        current?.width === sourceWidth && current.height === sourceHeight
          ? current
          : { width: sourceWidth, height: sourceHeight }
      )
    }

    const scheduleFrame = (frame: VideoFrame): void => {
      pendingFrameRef.current?.close()
      pendingFrameRef.current = frame
      if (!renderFrameRef.current) {
        renderFrameRef.current = requestAnimationFrame(drawPendingFrame)
      }
    }

    const decoderIsConfigured = (chunk: AirplayVideoChunk): VideoDecoder | null => {
      if (!chunk.keyframe) return decoderRef.current
      const nextCodec = codecString(chunk.data)
      if (!nextCodec) return decoderRef.current

      let decoder = decoderRef.current
      if (decoder && codecRef.current !== nextCodec) {
        closeDecoder(false)
        decoder = null
      }
      if (!decoder || decoder.state === 'closed') {
        decoder = new VideoDecoder({
          output: scheduleFrame,
          error: (error) => {
            if (disposed) return
            window.api.airplay.reportLog(`VideoDecoder error: ${error.message}`)
            setDecoderError(error.message)
            closeDecoder()
          }
        })
        window.api.airplay.reportLog('VideoDecoder created')
        decoderRef.current = decoder
        codecRef.current = nextCodec
      }
      if (decoder.state === 'unconfigured') {
        decoder.configure({
          codec: nextCodec,
          hardwareAcceleration: 'prefer-hardware',
          optimizeForLatency: true
        })
        window.api.airplay.reportLog(`VideoDecoder configured: ${nextCodec}`)
      }
      return decoder
    }

    const decode = (chunk: AirplayVideoChunk): void => {
      if (disposed) return
      const decoder = decoderIsConfigured(chunk)
      if (!decoder || decoder.state !== 'configured') return
      if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        closeDecoder()
        setDecoderError('AirPlay decoder fell behind; waiting for the next keyframe')
        return
      }
      try {
        if (chunk.keyframe) {
          window.api.airplay.reportLog(`Submitting keyframe: ${chunk.data.byteLength} bytes`)
        }
        decoder.decode(
          new EncodedVideoChunk({
            type: chunk.keyframe ? 'key' : 'delta',
            timestamp: chunk.timestampUs,
            data: chunk.data
          })
        )
        setDecoderError(null)
      } catch (error) {
        closeDecoder()
        setDecoderError(error instanceof Error ? error.message : String(error))
      }
    }

    const removeStateListener = window.api.airplay.onState((nextState) => {
      if (disposed) return
      setState(nextState)
      if (nextState.phase === 'waiting') {
        clearVisibleFrame()
      } else if (
        nextState.phase === 'starting' ||
        nextState.phase === 'stopped' ||
        nextState.phase === 'error'
      ) {
        closeDecoder()
      }
      if (nextState.phase === 'starting' || nextState.phase === 'stopped') {
        setDecoderError(null)
      } else if (nextState.phase === 'error') {
        setDecoderError(nextState.error)
      }
    })
    const removeVideoListener = window.api.airplay.onVideo(decode)

    return () => {
      disposed = true
      removeStateListener()
      removeVideoListener()
      closeDecoder(false)
    }
  }, [])

  return {
    canvasRef,
    state,
    decoderError,
    hasVideo,
    videoSize
  }
}
