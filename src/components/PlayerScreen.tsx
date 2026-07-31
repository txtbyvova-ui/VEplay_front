import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { Play, Pause, SkipForward } from '@phosphor-icons/react'
import NoiseOverlay from './NoiseOverlay'
import { usePlayer } from '../hooks/usePlayer'
import { useLibrary } from '../hooks/useLibrary'
import { useAuth } from '../auth/AuthContext'
import type { Category } from '../api'

const COVERS = [
  '/vinyl/030ccb9c4f039102b5ebac6fd7dd02f0.jpg',
  '/vinyl/096f8cc22e45903f005504f7a619bb77.jpg',
  '/vinyl/10a47b7cb24e38542c24d1d7557f2875.jpg',
  '/vinyl/15b63f40a5a71d37e3f8f940f1fcae2c.jpg',
  '/vinyl/16c36fbc665907fac7e1ab5e59f3d34e.jpg',
  '/vinyl/17e6ae811641d4f4f62fad57eaf0a589.jpg',
  '/vinyl/1d372446eb0498073acbe961320e2298.jpg',
  '/vinyl/1de016507a70c5aa9ac8391901eeb648.jpg',
  '/vinyl/249de981c7d09ed7e890111f6d04412a.jpg',
  '/vinyl/38eec90788cd3cd19cc29d923f51c591.jpg',
  '/vinyl/47fe43189b1117fbccb364b306a39942.jpg',
  '/vinyl/675c93cc17a3758dd32a070bce90e09b.jpg',
  '/vinyl/6a2a64f668f80f67c9d0334138d265a7.jpg',
  '/vinyl/74336c0e9f2fa4d6b0bd6167dff0839c.jpg',
  '/vinyl/7f26481985bd41b3253476f322a10359.jpg',
  '/vinyl/851cd639b1ea5d75575752dfb5dbd00a.jpg',
  '/vinyl/8c7c591087f49a7009c4ee939b8795d0.jpg',
  '/vinyl/8f5a59cbcfb758ff3b804185df83a3f5.jpg',
  '/vinyl/ab9ed7ace2a17d942517b9e884a6b4c4.jpg',
  '/vinyl/bc7f83bb4b7d99071519f7ae508cc056.jpg',
  '/vinyl/d49df90834c5226384f732c3f4e95263.jpg',
  '/vinyl/d73d8f2884276e5cf356653d505ea3dd.jpg',
  '/vinyl/d7506bc4a416857fefa8b52c839b2d77.jpg',
  '/vinyl/e7328f457a678182e36bf3d56d66a6fa.jpg',
]

const CAT: Record<Category, { label: string }> = {
  morning: { label: 'Morning' },
  day:     { label: 'Day'     },
  evening: { label: 'Evening' },
}
// Mode B single-playlist folder ('all') has no time-of-day label.
const catLabel = (c: string) => (c === 'all' ? 'Плейлист' : CAT[c as Category]?.label ?? c)

function fmt(s: number): string {
  if (!isFinite(s) || isNaN(s) || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function randCover() { return COVERS[Math.floor(Math.random() * COVERS.length)] }

function initialCat(allowed: string[]): string {
  if (allowed.length === 0) return 'day'
  const h = new Date().getHours()
  const t = h >= 6 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'day' : 'evening'
  return allowed.includes(t) ? t : allowed[0]
}

function MoonIcon({ size = 20, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}
function SunIcon({ size = 20, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
}
function SunsetIcon({ size = 20, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 18a5 5 0 0 0-10 0"/>
      <line x1="12" y1="9" x2="12" y2="2"/>
      <line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/>
      <line x1="1" y1="18" x2="23" y2="18"/>
      <line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/>
    </svg>
  )
}
function SpeakerIcon({ size = 18, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>
  )
}
function DiscIcon({ size = 20, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}
function ShuffleIcon({ size = 22, stroke = 'rgba(255,255,255,0.7)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5" /><path d="M4 20 21 3" />
      <path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" />
    </svg>
  )
}
const CAT_ICONS = { morning: MoonIcon, day: SunIcon, evening: SunsetIcon, all: DiscIcon }
function CatIcon({ cat, size, stroke }: { cat: string; size?: number; stroke?: string }) {
  const Icon = (CAT_ICONS as Record<string, typeof MoonIcon>)[cat] ?? SunIcon
  return <Icon size={size} stroke={stroke} />
}

// Hoisted: stable across renders so the player doesn't re-allocate it every tick.
const btnBase: React.CSSProperties = {
  width: 88, height: 88, borderRadius: '50%', border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flexShrink: 0,
  transition: 'transform 80ms ease, background 120ms ease',
  WebkitTapHighlightColor: 'transparent',
}
const topBtn: React.CSSProperties = {
  padding: '7px 12px', fontSize: 12, borderRadius: 10, cursor: 'pointer',
  background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)',
  border: '1px solid rgba(255,255,255,0.12)', WebkitTapHighlightColor: 'transparent',
}

// Tap feedback — pure DOM, hoisted so it's referentially stable for memoized children.
const press   = (e: React.TouchEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(0.93)' }
const release = (e: React.TouchEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1)' }

// ── Spinning vinyl — memoized so the ~4×/sec currentTime ticks never re-render
// its SVG grooves / gradients / cover. Re-renders only when cover / opacity /
// isPlaying change. ──
interface VinylProps {
  cover: string
  coverOpacity: number
  isPlaying: boolean
  onSwipeStart: (e: React.TouchEvent) => void
  onSwipeEnd: (e: React.TouchEvent) => void
}
const Vinyl = memo(function Vinyl({ cover, coverOpacity, isPlaying, onSwipeStart, onSwipeEnd }: VinylProps) {
  return (
    <div
      className="player-cover-wrapper"
      style={{ position: 'relative', zIndex: 1, width: 'min(calc(100% - 56px), 420px)', aspectRatio: '1 / 1' }}
      onTouchStart={onSwipeStart}
      onTouchEnd={onSwipeEnd}
    >
      {/* Spinning disc — border-radius 50% clips to circle */}
      <div style={{
        position: 'relative', width: '100%', height: '100%',
        borderRadius: '50%', overflow: 'hidden',
        animation: 'spin 8s linear infinite',
        animationPlayState: isPlaying ? 'running' : 'paused',
        boxShadow: 'inset 0 0 60px rgba(0,0,0,0.3), 0 0 40px rgba(0,0,0,0.5)',
        willChange: 'transform', transform: 'translateZ(0)',
      }}>
        <img
          src={cover}
          alt="cover"
          draggable={false}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            display: 'block', opacity: coverOpacity,
            transition: 'opacity 300ms ease',
          }}
        />
        {/* Vinyl groove lines overlay */}
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.18 }}
          viewBox="0 0 200 200"
        >
          {[18, 28, 38, 48, 58, 68, 76, 84, 90].map(r => (
            <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="rgba(0,0,0,0.9)" strokeWidth="0.8" />
          ))}
        </svg>
        {/* Depth sheen */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,0.07) 0%, transparent 55%), radial-gradient(circle at center, transparent 65%, rgba(0,0,0,0.35) 100%)',
        }} />
      </div>
      {/* Center spindle */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 18, height: 18, borderRadius: '50%',
        background: '#111', border: '2px solid rgba(255,255,255,0.2)',
        boxShadow: '0 0 12px rgba(0,0,0,0.9)', zIndex: 2, pointerEvents: 'none',
      }} />
    </div>
  )
})

// ── Category switcher — memoized so currentTime ticks don't re-render the buttons. ──
interface CategoryBarProps {
  allowed: string[]
  activeCat: string
  onSwitch: (cat: string) => void
}
const CategoryBar = memo(function CategoryBar({ allowed, activeCat, onSwitch }: CategoryBarProps) {
  return (
    <div className="player-cats" style={{ display: 'flex', gap: 10 }}>
      {allowed.map(cat => {
        const active = cat === activeCat
        return (
          <button
            className="player-cat-btn"
            key={cat}
            onClick={() => onSwitch(cat)}
            onTouchStart={press} onTouchEnd={release}
            style={{
              flex: 1, minHeight: 80, borderRadius: 16, border: 'none',
              background: active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.04)',
              outline: active ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(255,255,255,0.07)',
              cursor: 'pointer',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 5,
              opacity: active ? 1 : 0.55,
              transition: 'background 150ms, opacity 150ms, transform 80ms',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <CatIcon cat={cat} size={20} stroke={active ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.4)'} />
            <span style={{
              fontSize: 12, fontWeight: active ? 600 : 400,
              color: active ? '#ffffff' : 'rgba(255,255,255,0.7)',
              textTransform: 'uppercase', letterSpacing: '0.12em',
            }}>
              {catLabel(cat)}
            </span>
          </button>
        )
      })}
    </div>
  )
})

export default function PlayerScreen({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const { user, logout } = useAuth()
  const allowed = (user?.categories ?? []) as string[]
  const singlePlaylist = user?.singlePlaylist === true
  // Per-venue feature flags. Opt-out: undefined (old cached user) means allowed.
  const canFolders = user?.allowFolderSelector !== false
  const canShuffle = user?.allowShuffle !== false

  const {
    tracks, currentTrack, currentIndex,
    isPlaying, currentTime, duration,
    loading, togglePlay, next, seek, replaceQueueAndPlay,
    volume, setVolume, volumeControllable, shuffle, toggleShuffle,
  } = usePlayer()

  const { library, loading: libLoading } = useLibrary()

  const [activeCat, setActiveCat]     = useState<string>(() => initialCat(allowed))
  const [cover, setCover]             = useState(randCover())
  const [coverOpacity, setCoverOpacity] = useState(1)

  // Drag state of the two custom sliders. While a finger is down the bar shows the
  // LOCAL ratio, not the audio's — otherwise the ~4×/sec timeupdate ticks would
  // yank the handle back out from under the finger. null = not dragging.
  const [scrub, setScrub]     = useState<number | null>(null)
  const [volDrag, setVolDrag] = useState<number | null>(null)
  // Refs mirror the drag flags: a pointermove can arrive in the same frame as the
  // pointerdown, before the state re-render, and would otherwise be dropped.
  const scrubbing    = useRef(false)
  const volDragging  = useRef(false)

  const swipeX    = useRef<number | null>(null)
  const progress  = duration > 0 ? currentTime / duration : 0
  const shownProgress = scrub ?? progress
  const shownVolume   = volDrag ?? volume
  const nextTrack = tracks.length > 0
    ? tracks[(currentIndex + 1) % tracks.length]
    : null

  // Crossfade cover on track change (intentional: kicks off the fade on track swap)
  useEffect(() => {
    const newCover = randCover()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the crossfade
    setCoverOpacity(0)
    const t = setTimeout(() => { setCover(newCover); setCoverOpacity(1) }, 150)
    return () => clearTimeout(t)
  }, [currentTrack?.id])

  // Keep active category in sync with the playing track
  useEffect(() => {
    const c = currentTrack?.category
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync UI to external (audio) state
    if (c === 'morning' || c === 'day' || c === 'evening' || c === 'all') setActiveCat(c)
  }, [currentTrack?.category])

  const switchCategory = useCallback((cat: string) => {
    if (libLoading || cat === activeCat) return
    setActiveCat(cat)
    const list = library[cat] ?? []
    if (list.length > 0) replaceQueueAndPlay(list, 0)
  }, [library, libLoading, activeCat, replaceQueueAndPlay])

  // Both sliders run on Pointer Events, so one code path covers touch, mouse and
  // pen — and setPointerCapture keeps the events coming to the bar even when the
  // finger slides off it. A plain tap is just a down+up at the same spot, so the
  // old click-to-seek behaviour still works.
  const ratioAt = (el: HTMLElement, clientX: number): number => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const capture = (e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
  }

  // Timeline: the real currentTime is set only on release — seeking on every pixel
  // makes the element re-buffer and stutter under the finger.
  const onProgressDown = (e: React.PointerEvent<HTMLDivElement>) => {
    capture(e)
    scrubbing.current = true
    setScrub(ratioAt(e.currentTarget, e.clientX))
  }
  const onProgressMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return
    setScrub(ratioAt(e.currentTarget, e.clientX))
  }
  const onProgressUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return
    scrubbing.current = false
    const ratio = ratioAt(e.currentTarget, e.clientX)
    setScrub(null)
    seek(ratio)
  }
  const onProgressCancel = () => { scrubbing.current = false; setScrub(null) }

  // Volume is applied live while dragging: the master gain ramps over 15 ms, so
  // it costs nothing and the venue hears the change as it moves.
  const onVolumeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    capture(e)
    volDragging.current = true
    const ratio = ratioAt(e.currentTarget, e.clientX)
    setVolDrag(ratio)
    setVolume(ratio)
  }
  const onVolumeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volDragging.current) return
    const ratio = ratioAt(e.currentTarget, e.clientX)
    setVolDrag(ratio)
    setVolume(ratio)
  }
  const onVolumeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volDragging.current) return
    volDragging.current = false
    setVolume(ratioAt(e.currentTarget, e.clientX))
    setVolDrag(null)
  }
  const onVolumeCancel = () => { volDragging.current = false; setVolDrag(null) }

  // Swipe handlers on cover — stable so the memoized Vinyl doesn't re-render each tick.
  const onSwipeStart = useCallback((e: React.TouchEvent) => { swipeX.current = e.touches[0].clientX }, [])
  const onSwipeEnd = useCallback((e: React.TouchEvent) => {
    if (swipeX.current === null) return
    const d = e.changedTouches[0].clientX - swipeX.current
    swipeX.current = null
    if (Math.abs(d) < 50) return
    if (d < 0) next()
  }, [next])

  return (
    <div
      className="player-root"
      style={{
        display: 'flex', width: '100vw', height: '100dvh',
        background: '#0a0a0a', overflow: 'hidden', position: 'relative',
      }}
    >
      <NoiseOverlay />

      {/* Top-right: session controls. env() keeps them off the notch / Dynamic
          Island in portrait and off the rounded corner in landscape (0 on desktop). */}
      <div style={{
        position: 'absolute',
        top:   'calc(14px + env(safe-area-inset-top))',
        right: 'calc(16px + env(safe-area-inset-right))',
        zIndex: 10000, display: 'flex', gap: 8,
      }}>
        {onOpenAdmin && <button style={topBtn} onClick={onOpenAdmin}>Админка</button>}
        <button style={topBtn} onClick={logout}>Выйти</button>
      </div>

      {/* ── LEFT: Album cover (45%) ── */}
      <div
        className="player-left"
        style={{
          width: '45%', flexShrink: 0, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
          // Landscape is the iPad default layout — the left edge is where the
          // notch / rounded corner lives there.
          paddingLeft: 'env(safe-area-inset-left)',
          background: 'linear-gradient(135deg, #0f0f0f 0%, #1c1c1c 50%, #0d0d0d 100%)',
        }}
      >
        <Vinyl
          cover={cover}
          coverOpacity={coverOpacity}
          isPlaying={isPlaying}
          onSwipeStart={onSwipeStart}
          onSwipeEnd={onSwipeEnd}
        />
      </div>

      {/* ── RIGHT: Controls (55%) ── */}
      <div className="player-right" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between',
        // env() resolves to 0 on desktop; on iPhone/iPad it lifts the controls off
        // the home-indicator and away from the landscape right-edge cutout.
        padding: '28px calc(36px + env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom)) 32px',
        // A short screen used to clip the bottom of this column (space-between +
        // overflow:hidden). Let it scroll vertically instead of swallowing controls;
        // pan-y is required because html/body set touch-action: none.
        overflowX: 'hidden',
        overflowY: 'auto',
        touchAction: 'pan-y',
      }}>

        {/* Track info */}
        <div style={{ minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <CatIcon cat={activeCat} size={14} stroke="rgba(255,255,255,0.28)" />
            <span style={{ fontSize: 11, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)' }}>
              {catLabel(activeCat)}
            </span>
          </div>
          <h1 className="player-title" style={{
            fontSize: 30, fontWeight: 700, color: '#ffffff',
            lineHeight: 1.15, marginBottom: 8,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {loading ? '···' : (currentTrack?.title ?? 'No tracks')}
          </h1>
          <p className="player-artist" style={{
            fontSize: 17, color: 'rgba(255,255,255,0.48)',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {!loading && currentTrack ? currentTrack.artist : ' '}
          </p>
        </div>

        {/* Progress bar */}
        <div style={{ paddingInline: 8 }}>
          {/* 48px touch target. touchAction 'none' — without it the browser claims
              the gesture as a page pan and the bar can only be tapped, not dragged. */}
          <div
            style={{ height: 48, display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none' }}
            onPointerDown={onProgressDown}
            onPointerMove={onProgressMove}
            onPointerUp={onProgressUp}
            onPointerCancel={onProgressCancel}
          >
            <div style={{
              width: '100%', height: 8,
              background: 'rgba(255,255,255,0.1)', borderRadius: 4, position: 'relative',
            }}>
              <div style={{
                height: '100%', width: `${shownProgress * 100}%`,
                background: '#ffffff', borderRadius: 4,
                // No easing while dragging: the fill must sit exactly under the finger.
                transition: scrub === null ? 'width 0.2s linear' : 'none',
              }} />
              <div style={{
                position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
                left: `${shownProgress * 100}%`,
                width: scrub === null ? 18 : 22, height: scrub === null ? 18 : 22, borderRadius: '50%',
                background: '#ffffff', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
              }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
              {fmt(scrub !== null && duration > 0 ? scrub * duration : currentTime)}
            </span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
              {fmt(duration)}
            </span>
          </div>
        </div>

        {/* Volume */}
        <div className="player-volume-row" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingInline: 8 }}>
          <SpeakerIcon size={18} stroke="rgba(255,255,255,0.4)" />
          {/* Where the software volume cannot work (iOS plays straight to the
              hardware so background audio survives a screen lock), say so instead
              of showing a slider that moves and changes nothing. */}
          {!volumeControllable ? (
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.32)', letterSpacing: '0.04em' }}>
              Громкость — кнопками устройства
            </span>
          ) : (
          <div
            className="player-volume-wrap"
            // 'none', not 'manipulation': 'manipulation' still lets the browser pan
            // the page, which is what made this slider tap-only.
            style={{ width: 200, height: 48, display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none' }}
            onPointerDown={onVolumeDown}
            onPointerMove={onVolumeMove}
            onPointerUp={onVolumeUp}
            onPointerCancel={onVolumeCancel}
          >
            <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, position: 'relative' }}>
              <div style={{
                height: '100%', width: `${shownVolume * 100}%`, background: 'rgba(255,255,255,0.65)', borderRadius: 3,
                transition: volDrag === null ? 'width 50ms linear' : 'none',
              }} />
              <div style={{
                position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
                left: `${shownVolume * 100}%`,
                width: volDrag === null ? 14 : 18, height: volDrag === null ? 14 : 18, borderRadius: '50%',
                background: '#fff', pointerEvents: 'none',
                boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
              }} />
            </div>
          </div>
          )}
        </div>

        {/* Playback controls */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            {/* Play / Pause — main action */}
            <button
              className="player-btn-play"
              style={{ ...btnBase, background: '#ffffff', width: 96, height: 96 }}
              onClick={togglePlay}
              onTouchStart={press} onTouchEnd={release}
            >
              {isPlaying
                ? <Pause weight="fill" size={44} color="#0a0a0a" />
                : <Play  weight="fill" size={44} color="#0a0a0a" />
              }
            </button>

            {/* Next */}
            <button
              className="player-btn-next"
              style={{ ...btnBase, background: 'rgba(255,255,255,0.07)' }}
              onClick={next}
              onTouchStart={press} onTouchEnd={release}
            >
              <SkipForward weight="fill" size={40} color="rgba(255,255,255,0.72)" />
            </button>

            {/* Shuffle — hidden when the venue's allowShuffle flag is off */}
            {canShuffle && (
              <button
                className="player-btn-shuffle"
                aria-label="Случайный порядок"
                aria-pressed={shuffle}
                style={{
                  ...btnBase, width: 64, height: 64,
                  background: shuffle ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)',
                  outline: shuffle ? '1.5px solid rgba(255,255,255,0.45)' : 'none',
                }}
                onClick={toggleShuffle}
                onTouchStart={press} onTouchEnd={release}
              >
                <ShuffleIcon size={26} stroke={shuffle ? '#ffffff' : 'rgba(255,255,255,0.55)'} />
              </button>
            )}
          </div>

          {/* Next track hint */}
          <p style={{
            textAlign: 'center', marginTop: 14,
            fontSize: 13, color: 'rgba(255,255,255,0.28)',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {nextTrack ? `Следующий: ${nextTrack.title}` : ' '}
          </p>
        </div>

        {/* Playlist switcher — only categories this user may access (hidden in single-playlist mode) */}
        {!singlePlaylist && allowed.length > 1 && canFolders && (
          <CategoryBar allowed={allowed} activeCat={activeCat} onSwitch={switchCategory} />
        )}

      </div>
    </div>
  )
}
