import { useEffect, useRef } from 'react'

interface Props {
  audioRef: React.RefObject<HTMLAudioElement>
  isPlaying: boolean
}

// Draw loop reads from this — updated when connection is established
let _analyser: AnalyserNode | null = null

// Keys stored directly on the audio element so they survive HMR module resets
const VIZ_CTX = '__vizCtx'
const VIZ_AN  = '__vizAnalyser'

type VizAudio = HTMLAudioElement & {
  __vizCtx?: AudioContext
  __vizAnalyser?: AnalyserNode
}

export default function AudioVisualizer({ audioRef, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) return
    const audio = audioRef.current as VizAudio | null
    if (!audio) return

    // Already connected (survives HMR) — just resume + expose analyser
    if (audio[VIZ_CTX] && audio[VIZ_AN]) {
      _analyser = audio[VIZ_AN]!
      audio[VIZ_CTX]!.resume().catch(() => {})
      return
    }

    // First connection — create ctx + analyser, then connect AFTER resume()
    // so that audio.play() (fired by usePlayer just after this effect) always runs first
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.12

    ctx.resume().then(() => {
      try {
        const source = ctx.createMediaElementSource(audio)
        source.connect(analyser)
        analyser.connect(ctx.destination)
        // Store on the element itself — survives HMR
        audio[VIZ_CTX] = ctx
        audio[VIZ_AN]  = analyser
        _analyser = analyser
      } catch (e) {
        console.error('[Visualizer] createMediaElementSource failed:', e)
      }
    }).catch(() => {})
  }, [isPlaying, audioRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.width = canvas.clientWidth || 560
    canvas.height = 90

    const ctxRaw = canvas.getContext('2d')
    if (!ctxRaw) return
    const ctx: CanvasRenderingContext2D = ctxRaw

    const W = canvas.width
    const H = canvas.height
    const dataArray = new Uint8Array(2048)
    let tick = 0

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      tick++

      // Background
      ctx.fillStyle = '#060606'
      ctx.fillRect(0, 0, W, H)

      // Faint grid
      ctx.strokeStyle = 'rgba(255,255,255,0.032)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([])
      for (let i = 1; i < 4; i++) {
        ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke()
      }
      for (let i = 1; i < 8; i++) {
        ctx.beginPath(); ctx.moveTo((W / 8) * i, 0); ctx.lineTo((W / 8) * i, H); ctx.stroke()
      }

      // Centre dashed guide
      ctx.strokeStyle = 'rgba(255,255,255,0.055)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2, 8])
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()
      ctx.setLineDash([])

      // Waveform data — _analyser is null until first play + resume
      if (_analyser) _analyser.getByteTimeDomainData(dataArray)

      // Glitch
      const isGlitch = tick % 61 === 0 && Math.random() > 0.38
      const glitchShift = isGlitch ? (Math.random() - 0.5) * 9 : 0

      const len = _analyser ? _analyser.frequencyBinCount : dataArray.length
      const sliceW = W / len

      ctx.strokeStyle = '#d0d0d0'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < len; i++) {
        const v = dataArray[i] / 128.0
        const y = (v * H) / 2 + glitchShift
        if (Math.random() < 0.0008) { ctx.moveTo(i * sliceW, y); continue }
        if (i === 0) ctx.moveTo(0, y)
        else ctx.lineTo(i * sliceW, y)
      }
      ctx.stroke()

      // Glitch artifact bar
      if (isGlitch && Math.random() > 0.45) {
        const gy = Math.random() * H
        ctx.fillStyle = `rgba(210,210,210,${0.04 + Math.random() * 0.06})`
        ctx.fillRect(0, gy, W * (0.15 + Math.random() * 0.7), 1 + Math.floor(Math.random() * 2))
      }

      // CRT scanlines
      for (let sy = 0; sy < H; sy += 3) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        ctx.fillRect(0, sy, W, 1)
      }

      // Edge vignette
      const grad = ctx.createLinearGradient(0, 0, W, 0)
      grad.addColorStop(0, 'rgba(0,0,0,0.35)')
      grad.addColorStop(0.08, 'rgba(0,0,0,0)')
      grad.addColorStop(0.92, 'rgba(0,0,0,0)')
      grad.addColorStop(1, 'rgba(0,0,0,0.35)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)
    }

    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="w-full block"
      style={{ height: '90px', imageRendering: 'pixelated' }}
    />
  )
}
