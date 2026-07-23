import { useState } from 'react'

/**
 * Subtle film-grain / dither overlay.
 *
 * Rendered as a small noise TILE repeated at its native pixel size — NOT a 256px
 * canvas stretched across the whole viewport, which nearest-neighbour-upscaled
 * each noise pixel into a ~7px block ("8-bit" looking grain) and failed to dither
 * the dark background gradients (visible banding). At 1:1 the grain is fine and
 * breaks up gradient banding. Static → the browser composites it once and never
 * repaints it with the spinning vinyl.
 */
function makeNoiseUrl(size = 128): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() * 255
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

export default function NoiseOverlay() {
  // Generated once via a lazy state initializer (no effect, no re-render).
  const [url] = useState(makeNoiseUrl)
  if (!url) return null
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999,
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'repeat',
        backgroundSize: '128px 128px',   // native size → 1px grain, no upscaling blocks
        opacity: 0.045,
        contain: 'strict',
        transform: 'translateZ(0)',      // own layer, painted once
      }}
    />
  )
}
