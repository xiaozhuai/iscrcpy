import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAirPlayMirror } from '../src/renderer/src/useAirPlayMirror'

function Probe(): ReturnType<typeof createElement> {
  const [muted, setMuted] = useState(false)
  const mirror = useAirPlayMirror(muted)
  useEffect(() => {
    Object.assign(window, {
      setAudioMuted: setMuted,
      mirrorProbe: {
        muted,
        hasVideo: mirror.hasVideo,
        size: mirror.videoSize,
        error: mirror.decoderError,
        phase: mirror.state.phase
      }
    })
  }, [mirror.hasVideo, mirror.videoSize, mirror.decoderError, mirror.state, muted])
  return createElement('canvas', { ref: mirror.canvasRef, id: 'preview' })
}

createRoot(document.getElementById('root')!).render(createElement(Probe))
