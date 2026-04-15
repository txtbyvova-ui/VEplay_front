import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Pause, SkipForward } from '@phosphor-icons/react'
import NoiseOverlay from './NoiseOverlay'
import { usePlayer } from '../hooks/usePlayer'
import { useLibrary } from '../hooks/useLibrary'

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

type Category = 'morning' | 'day' | 'evening'

const CAT: Record<Category, { label: string }> = {
  morning: { label: 'Morning' },
  day:     { label: 'Day'     },
  evening: { label: 'Evening' },
}

function fmt(s: number): string {
  if (!isFinite(s) || isNaN(s) || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function randCover() { return COVERS[Math.floor(Math.random() * COVERS.length)] }

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
const CAT_ICONS = { morning: MoonIcon, day: SunIcon, evening: SunsetIcon }
function CatIcon({ cat, size, stroke }: { cat: Category; size?: number; stroke?: string }) {
  const Icon = CAT_ICONS[cat]
  return <Icon size={size} stroke={stroke} />
}

export default function PlayerScreen() {
  const {
    tracks, currentTrack, currentIndex,
    isPlaying, currentTime, duration,
    loading, togglePlay, next, seek, replaceQueueAndPlay,
    volume, setVolume,
  } = usePlayer()

  const { library, loading: libLoading } = useLibrary()

  const [activeCat, setActiveCat]     = useState<Category>('day')
  const [cover, setCover]             = useState(randCover())
  const [coverOpacity, setCoverOpacity] = useState(1)

  const swipeX    = useRef<number | null>(null)
  const progress  = duration > 0 ? currentTime / duration : 0
  const nextTrack = tracks.length > 0
    ? tracks[(currentIndex + 1) % tracks.length]
    : null

  // Crossfade cover on track change
  useEffect(() => {
    const newCover = randCover()
    setCoverOpacity(0)
    const t = setTimeout(() => { setCover(newCover); setCoverOpacity(1) }, 150)
    return () => clearTimeout(t)
  }, [currentTrack?.id])

  // Keep active category in sync with playing track
  useEffect(() => {
    const c = currentTrack?.category
    if (c === 'morning' || c === 'day' || c === 'evening') setActiveCat(c)
  }, [currentTrack?.category])

  const switchCategory = useCallback((cat: Category) => {
    if (libLoading || cat === activeCat) return
    setActiveCat(cat)
    const list = library[cat]
    if (list.length > 0) replaceQueueAndPlay(list, 0)
  }, [library, libLoading, activeCat, replaceQueueAndPlay])

  // Progress bar seek — touch
  function onProgressTouch(e: React.TouchEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    seek(Math.max(0, Math.min(1, (e.touches[0].clientX - r.left) / r.width)))
  }
  // Progress bar seek — mouse
  function onProgressClick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
  }

  // Volume seek — touch
  function onVolumeTouch(e: React.TouchEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    setVolume(Math.max(0, Math.min(1, (e.touches[0].clientX - r.left) / r.width)))
  }
  // Volume seek — mouse
  function onVolumeClick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    setVolume(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
  }

  // Swipe handlers on cover
  const onSwipeStart = (e: React.TouchEvent) => { swipeX.current = e.touches[0].clientX }
  const onSwipeEnd   = (e: React.TouchEvent) => {
    if (swipeX.current === null) return
    const d = e.changedTouches[0].clientX - swipeX.current
    swipeX.current = null
    if (Math.abs(d) < 50) return
    if (d < 0) next()
  }

  // Button tap feedback helpers
  const press   = (e: React.TouchEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(0.93)' }
  const release = (e: React.TouchEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1)' }

  const btnBase: React.CSSProperties = {
    width: 88, height: 88, borderRadius: '50%', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0,
    transition: 'transform 80ms ease, background 120ms ease',
    WebkitTapHighlightColor: 'transparent',
  }

  return (
    <div
      className="player-root"
      style={{
        display: 'flex', width: '100vw', height: '100vh',
        background: '#0a0a0a', overflow: 'hidden', position: 'relative',
      }}
    >
      <NoiseOverlay />

      {/* ── LEFT: Album cover (45%) ── */}
      <div
        className="player-left"
        style={{
          width: '45%', flexShrink: 0, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
          background: 'linear-gradient(135deg, #0f0f0f 0%, #1c1c1c 50%, #0d0d0d 100%)',
        }}
      >
        {/* Spinning vinyl */}
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
      </div>

      {/* ── RIGHT: Controls (55%) ── */}
      <div className="player-right" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', padding: '28px 36px 28px 32px',
        overflow: 'hidden',
      }}>

        {/* Track info */}
        <div style={{ minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <CatIcon cat={activeCat} size={14} stroke="rgba(255,255,255,0.28)" />
            <span style={{ fontSize: 11, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)' }}>
              {CAT[activeCat].label}
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
            {!loading && currentTrack ? currentTrack.artist : '\u00A0'}
          </p>
        </div>

        {/* Progress bar */}
        <div>
          {/* 48px touch target */}
          <div
            style={{ height: 48, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
            onTouchStart={onProgressTouch}
            onClick={onProgressClick}
          >
            <div style={{
              width: '100%', height: 8,
              background: 'rgba(255,255,255,0.1)', borderRadius: 4, position: 'relative',
            }}>
              <div style={{
                height: '100%', width: `${progress * 100}%`,
                background: '#ffffff', borderRadius: 4,
                transition: 'width 0.2s linear',
              }} />
              <div style={{
                position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
                left: `${progress * 100}%`,
                width: 18, height: 18, borderRadius: '50%',
                background: '#ffffff', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
              }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
              {fmt(currentTime)}
            </span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.32)', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
              {fmt(duration)}
            </span>
          </div>
        </div>

        {/* Volume */}
        <div className="player-volume-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SpeakerIcon size={18} stroke="rgba(255,255,255,0.4)" />
          <div
            className="player-volume-wrap"
            style={{ width: 200, height: 48, display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'manipulation' }}
            onTouchStart={onVolumeTouch}
            onClick={onVolumeClick}
          >
            <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, position: 'relative' }}>
              <div style={{ height: '100%', width: `${volume * 100}%`, background: 'rgba(255,255,255,0.65)', borderRadius: 3, transition: 'width 50ms linear' }} />
              <div style={{
                position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
                left: `${volume * 100}%`,
                width: 14, height: 14, borderRadius: '50%',
                background: '#fff', pointerEvents: 'none',
                boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
              }} />
            </div>
          </div>
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
          </div>

          {/* Next track hint */}
          <p style={{
            textAlign: 'center', marginTop: 14,
            fontSize: 13, color: 'rgba(255,255,255,0.28)',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {nextTrack ? `Следующий: ${nextTrack.title}` : '\u00A0'}
          </p>
        </div>

        {/* Playlist switcher */}
        <div className="player-cats" style={{ display: 'flex', gap: 10 }}>
          {(['morning', 'day', 'evening'] as Category[]).map(cat => {
            const active = cat === activeCat
            return (
              <button
                className="player-cat-btn"
                key={cat}
                onClick={() => switchCategory(cat)}
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
                  {CAT[cat].label}
                </span>
              </button>
            )
          })}
        </div>

      </div>
    </div>
  )
}
