import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AirplayState, AirplayVideoChunk } from '../../shared/airplay'
import { AudioPlayout } from './audioPlayout'
import type { PhoneFrame } from '../../shared/mcp'

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
  frameInfo: () => { width: number; height: number; capturedAt: number } | null
  captureFrame: (maxWidth?: number, maxAgeMs?: number) => PhoneFrame
}

export function useAirPlayMirror(muted = false): AirPlayMirror {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastPreviewRef = useRef<HTMLCanvasElement | null>(null)
  const lastFrameAtRef = useRef(0)
  const decoderRef = useRef<VideoDecoder | null>(null)
  const codecRef = useRef<string | null>(null)
  const pendingFrameRef = useRef<VideoFrame[]>([])
  const renderFrameRef = useRef(0)
  const hasVideoRef = useRef(false)
  const audioRef = useRef<AudioPlayout | null>(null)
  const mutedRef = useRef(muted)
  const [state, setState] = useState<AirplayState>(initialAirplayState)
  const [decoderError, setDecoderError] = useState<string | null>(null)
  const [hasVideo, setHasVideo] = useState(false)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    mutedRef.current = muted
    audioRef.current?.setMuted(muted)
  }, [muted])

  // The player stays alive on the Settings page. Restore its last frame when
  // the preview remounts instead of waiting for the phone to change its screen.
  useLayoutEffect(() => {
    const preview = canvasRef.current,
      capture = captureCanvasRef.current
    if (preview !== lastPreviewRef.current && preview && capture && lastFrameAtRef.current) {
      preview.width = capture.width
      preview.height = capture.height
      preview.getContext('2d', { alpha: false })?.drawImage(capture, 0, 0)
    }
    lastPreviewRef.current = preview
  })

  useEffect(() => {
    let disposed = false
    let videoStreamId: number | null = null
    const audio = new AudioPlayout((message) => window.api.airplay.reportLog(message))
    audio.setMuted(mutedRef.current)
    audioRef.current = audio
    const resumeAudio = (): void => audio.resume()
    window.addEventListener('pointerdown', resumeAudio)
    window.addEventListener('keydown', resumeAudio)

    const clearCanvas = (): void => {
      lastFrameAtRef.current = 0
      const capture = captureCanvasRef.current
      capture?.getContext('2d')?.clearRect(0, 0, capture.width, capture.height)
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
      for (const frame of pendingFrameRef.current) frame.close()
      pendingFrameRef.current = []
      const decoder = decoderRef.current
      decoderRef.current = null
      codecRef.current = null
      if (decoder && decoder.state !== 'closed') decoder.close()
      if (clear) clearCanvas()
    }

    const drawPendingFrame = (): void => {
      renderFrameRef.current = 0
      const frames = pendingFrameRef.current
      if (!frames.length) return
      if ((audio.videoDelayMs(frames[0].timestamp) ?? 0) > 2) {
        renderFrameRef.current = requestAnimationFrame(drawPendingFrame)
        return
      }
      let frame = frames.shift()!
      while (frames.length && (audio.videoDelayMs(frames[0].timestamp) ?? 0) <= 2) {
        frame.close()
        frame = frames.shift()!
      }
      if (frames.length) renderFrameRef.current = requestAnimationFrame(drawPendingFrame)
      const canvas = (captureCanvasRef.current ??= document.createElement('canvas'))

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
      lastFrameAtRef.current = Date.now()
      const preview = canvasRef.current
      if (preview) {
        if (preview.width !== targetWidth) preview.width = targetWidth
        if (preview.height !== targetHeight) preview.height = targetHeight
        preview.getContext('2d', { alpha: false })?.drawImage(canvas, 0, 0)
      }
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
      if (disposed) {
        frame.close()
        return
      }
      pendingFrameRef.current.push(frame)
      while (pendingFrameRef.current.length > 12) pendingFrameRef.current.shift()!.close()
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
      if (videoStreamId !== chunk.streamId) {
        closeDecoder()
        videoStreamId = chunk.streamId
      }
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
      if (
        nextState.phase === 'waiting' ||
        nextState.phase === 'starting' ||
        nextState.phase === 'stopped' ||
        nextState.phase === 'error'
      ) {
        closeDecoder()
        audio.reset()
        videoStreamId = null
      }
      if (nextState.phase === 'starting' || nextState.phase === 'stopped') {
        setDecoderError(null)
      } else if (nextState.phase === 'error') {
        setDecoderError(nextState.error)
      }
    })
    const removeVideoListener = window.api.airplay.onVideo(decode)
    const removeAudioListener = window.api.airplay.onAudio((chunk) => {
      if (!disposed) audio.push(chunk)
    })

    return () => {
      disposed = true
      removeStateListener()
      removeVideoListener()
      removeAudioListener()
      window.removeEventListener('pointerdown', resumeAudio)
      window.removeEventListener('keydown', resumeAudio)
      audio.dispose()
      if (audioRef.current === audio) audioRef.current = null
      closeDecoder(false)
    }
  }, [])

  return {
    canvasRef,
    state,
    decoderError,
    hasVideo,
    videoSize,
    frameInfo: () => {
      const canvas = captureCanvasRef.current
      return canvas && lastFrameAtRef.current
        ? { width: canvas.width, height: canvas.height, capturedAt: lastFrameAtRef.current }
        : null
    },
    captureFrame: (maxWidth = 1024, maxAgeMs = 2500) => {
      const canvas = captureCanvasRef.current
      const capturedAt = lastFrameAtRef.current
      if (!canvas || !capturedAt || Date.now() - capturedAt > maxAgeMs)
        throw new Error(
          'No fresh iPhone frame. Connect AirPlay and update the phone screen before capturing.'
        )
      const scale = Math.min(1, maxWidth / canvas.width)
      const image = document.createElement('canvas')
      image.width = Math.max(1, Math.round(canvas.width * scale))
      image.height = Math.max(1, Math.round(canvas.height * scale))
      image.getContext('2d')!.drawImage(canvas, 0, 0, image.width, image.height)
      return {
        data: image.toDataURL('image/png').split(',')[1],
        mimeType: 'image/png',
        width: image.width,
        height: image.height,
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        capturedAt
      }
    }
  }
}
