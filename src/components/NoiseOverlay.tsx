import { useEffect, useRef } from 'react'

export default function NoiseOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const size = 256
    canvas.width = size
    canvas.height = size

    const imageData = ctx.createImageData(size, size)
    const data = imageData.data

    for (let i = 0; i < data.length; i += 4) {
      const value = Math.random() * 255
      data[i] = value     // R
      data[i + 1] = value // G
      data[i + 2] = value // B
      data[i + 3] = 255   // A (fully opaque — visibility controlled via CSS opacity)
    }

    ctx.putImageData(imageData, 0, 0)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[9999] w-full h-full"
      style={{
        // NOTE: previously used `mix-blend-mode: overlay`, which forced the
        // compositor to re-blend the WHOLE viewport on every frame of the vinyl
        // spin → jank on weaker GPUs / iPad. A static low-opacity grain on its own
        // promoted layer composites once and never repaints.
        opacity: 0.05,
        imageRendering: 'pixelated',
        contain: 'strict',
        transform: 'translateZ(0)',
      }}
    />
  )
}
