/**
 * graph.ts — the single Web Audio graph for the player.
 *
 *   <audio A> → MediaElementSource A → gainA (crossfade) ┐
 *                                                        ├→ compressor → master → destination
 *   <audio B> → MediaElementSource B → gainB (crossfade) ┘
 *
 * Why Web Audio at all: iOS/Android ignore `HTMLAudioElement.volume`, so the UI
 * slider is wired to the master GainNode instead — that DOES work on mobile.
 *
 * The compressor sits on the MASTER (after the per-source crossfade gains), so
 * levelling never fights the crossfade: each source fades independently, the
 * compressor only evens out the mastering differences between tracks.
 */

/** Broadcast-limiter-ish settings: lift quiet tracks, shave peaks. */
const COMPRESSOR = { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }

type AudioCtor = typeof AudioContext
interface LegacyWindow extends Window { webkitAudioContext?: AudioCtor }

let ctx: AudioContext | null = null
let compressor: DynamicsCompressorNode | null = null
let master: GainNode | null = null

/**
 * MediaElementSource may be created only ONCE per element — remember them.
 *
 * DO NOT tear this graph down on a track change. The whole graph is a FIXED set —
 * one AudioContext, two MediaElementSource, two GainNode, a compressor and the
 * master — built once for the two <audio> elements and never grown, so skipping
 * tracks accumulates nothing to clean up. Calling disconnect()/close() per skip
 * would free nothing and would be unrecoverable: createMediaElementSource() on an
 * element that already has one throws InvalidStateError, so the next attach()
 * would kill audio for the rest of the session. What actually leaks during a
 * burst of skips is network and buffers, and that is handled in cache.ts
 * (AbortController) and usePlayer (the retired element's src is released).
 */
const sources = new WeakMap<HTMLAudioElement, { source: MediaElementAudioSourceNode; gain: GainNode }>()

function ensureCtx(): AudioContext {
  if (ctx) return ctx
  const Ctor: AudioCtor | undefined = window.AudioContext ?? (window as LegacyWindow).webkitAudioContext
  if (!Ctor) throw new Error('Web Audio API is not supported')
  ctx = new Ctor()

  compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = COMPRESSOR.threshold
  compressor.knee.value      = COMPRESSOR.knee
  compressor.ratio.value     = COMPRESSOR.ratio
  compressor.attack.value    = COMPRESSOR.attack
  compressor.release.value   = COMPRESSOR.release

  master = ctx.createGain()
  master.gain.value = 1

  compressor.connect(master)
  master.connect(ctx.destination)
  return ctx
}

/** True when the browser has a usable Web Audio implementation. */
export function isSupported(): boolean {
  return typeof window !== 'undefined' && !!(window.AudioContext ?? (window as LegacyWindow).webkitAudioContext)
}

/**
 * True where the graph must be BYPASSED and the element left to play straight to
 * the hardware.
 *
 * iOS suspends an AudioContext when the screen locks or Safari goes to the
 * background, and a MediaElementSource-connected <audio> falls silent with it.
 * That is fatal for the product's core scenario — iPad on the bar, screen off,
 * music keeps playing — so on iOS the whole graph is skipped. The cost is no
 * compressor and no software volume (iOS ignores HTMLAudioElement.volume anyway,
 * so volume belongs to the hardware buttons there).
 *
 * iPadOS 13+ reports itself as macOS, hence the touch-points check: a real Mac
 * has no touch screen.
 */
export function bypassRecommended(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/**
 * Attach an <audio> element to the graph, returning ITS crossfade gain node.
 * Idempotent per element.
 *
 * NOTE: the element must be CORS-clean (`crossOrigin = 'anonymous'`) or the graph
 * outputs SILENCE for cross-origin media (dev: vite:5173 → api:3001). Blob URLs
 * served from the IndexedDB cache are same-origin and always fine.
 */
export function attach(el: HTMLAudioElement): GainNode {
  const c = ensureCtx()
  const existing = sources.get(el)
  if (existing) return existing.gain

  const source = c.createMediaElementSource(el)
  const gain = c.createGain()
  gain.gain.value = 0            // faded in by the player
  source.connect(gain)
  gain.connect(compressor as DynamicsCompressorNode)
  sources.set(el, { source, gain })
  return gain
}

/**
 * Resume the context. iOS creates it 'suspended' and only allows resuming from
 * inside a user gesture — call this from the play/tap handler.
 */
export async function resume(): Promise<void> {
  const c = ensureCtx()
  if (c.state === 'suspended') { try { await c.resume() } catch { /* ignore */ } }
}

/** Master volume (0..1) — this is what the UI slider drives on mobile. */
export function setMasterVolume(v: number): void {
  if (!ctx || !master) return
  const value = Math.min(1, Math.max(0, v))
  // Short ramp instead of a jump: avoids clicks when dragging the slider.
  master.gain.setTargetAtTime(value, ctx.currentTime, 0.015)
}

/** Ramp one source's crossfade gain to `to` over `seconds`. */
export function rampGain(gain: GainNode, to: number, seconds: number): void {
  const c = ensureCtx()
  const now = c.currentTime
  gain.gain.cancelScheduledValues(now)
  gain.gain.setValueAtTime(gain.gain.value, now)
  gain.gain.linearRampToValueAtTime(Math.min(1, Math.max(0, to)), now + Math.max(0.01, seconds))
}

/** Set a source's crossfade gain immediately (no ramp). */
export function setGain(gain: GainNode, to: number): void {
  const c = ensureCtx()
  gain.gain.cancelScheduledValues(c.currentTime)
  gain.gain.value = Math.min(1, Math.max(0, to))
}

export function contextState(): AudioContextState | 'unavailable' {
  return ctx ? ctx.state : 'unavailable'
}
