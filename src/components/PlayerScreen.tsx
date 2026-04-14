import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, SkipForward, SpeakerSimpleHigh, SpeakerSimpleLow, SpeakerSimpleNone } from '@phosphor-icons/react'
import NoiseOverlay from './NoiseOverlay'
import ClientLibrary from './ClientLibrary'
import { usePlayer } from '../hooks/usePlayer'
import { useLibrary } from '../hooks/useLibrary'

const fontMono    = { fontFamily: "'IBM Plex Mono', monospace" }
const fontDisplay = { fontFamily: "'M PLUS 1', sans-serif" }

const VINYL_COVERS = [
  '/vinyl/030ccb9c4f039102b5ebac6fd7dd02f0.jpg',
  '/vinyl/096f8cc22e45903f005504f7a619bb77.jpg',
  '/vinyl/10a47b7cb24e38542c24d1d7557f2875.jpg',
  '/vinyl/15b63f40a5a71d37e3f8f940f1fcae2c.jpg',
  '/vinyl/16c36fbc665907fac7e1ab5e59f3d34e.jpg',
  '/vinyl/17e6ae811641d4f4f62fad57eaf0a589.jpg',
  '/vinyl/1975dd76793d2a62756f02f045ac0c80%20(1).jpg',
  '/vinyl/1d372446eb0498073acbe961320e2298.jpg',
  '/vinyl/1de016507a70c5aa9ac8391901eeb648.jpg',
  '/vinyl/249de981c7d09ed7e890111f6d04412a.jpg',
  '/vinyl/259b0191c50295355fe46f6fd63ac412.jpg',
  '/vinyl/38eec90788cd3cd19cc29d923f51c591.jpg',
  '/vinyl/47fe43189b1117fbccb364b306a39942.jpg',
  '/vinyl/675c93cc17a3758dd32a070bce90e09b.jpg',
  '/vinyl/6a2a64f668f80f67c9d0334138d265a7.jpg',
  '/vinyl/74336c0e9f2fa4d6b0bd6167dff0839c.jpg',
  '/vinyl/7f26481985bd41b3253476f322a10359.jpg',
  '/vinyl/851cd639b1ea5d75575752dfb5dbd00a.jpg',
  '/vinyl/8c7c591087f49a7009c4ee939b8795d0.jpg',
  '/vinyl/8f5a59cbcfb758ff3b804185df83a3f5.jpg',
  '/vinyl/a38cc7823b4e46addef749f3e71e1cb8_73bd1130-643b-4960-a6bf-68d3e766a342.png',
  '/vinyl/ab9ed7ace2a17d942517b9e884a6b4c4.jpg',
  '/vinyl/bc7f83bb4b7d99071519f7ae508cc056.jpg',
  '/vinyl/c4b554cccce45efdb63ef4a476956135%20(1).jpg',
  '/vinyl/d49df90834c5226384f732c3f4e95263.jpg',
  '/vinyl/d6db61d0d0c97f9898535e29f019a608%20(1).jpg',
  '/vinyl/d73d8f2884276e5cf356653d505ea3dd.jpg',
  '/vinyl/d7506bc4a416857fefa8b52c839b2d77.jpg',
  '/vinyl/e7328f457a678182e36bf3d56d66a6fa.jpg',
]

const TOD_LABELS: Record<string, string> = { morning: 'MORNING', day: 'DAY', evening: 'EVENING' }
const IDLE_MS = 30_000

function formatTime(s: number): string {
  if (!isFinite(s) || isNaN(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

type Mode = 'display' | 'control'

export default function PlayerScreen() {
  const {
    currentTrack,
    isPlaying, currentTime, duration,
    loading, togglePlay, next,
    replaceQueueAndPlay,
    volume, setVolume,
  } = usePlayer()

  const { library, loading: libLoading } = useLibrary()

  const [mode, setMode]           = useState<Mode>('display')
  const [time, setTime]           = useState('')
  const [currentVinyl, setCurrentVinyl] = useState(VINYL_COVERS[0])
  const volumeRef  = useRef<HTMLDivElement>(null)
  const idleTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  const progress   = duration > 0 ? currentTime / duration : 0
  const todLabel   = TOD_LABELS[currentTrack?.category ?? 'morning'] ?? ''

  useEffect(() => {
    setCurrentVinyl(VINYL_COVERS[Math.floor(Math.random() * VINYL_COVERS.length)])
  }, [currentTrack?.id])

  useEffect(() => {
    const update = () => {
      const now = new Date()
      setTime(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current) }, [])

  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setMode('display'), IDLE_MS)
  }, [])

  const handleInteraction = useCallback(() => {
    setMode(prev => {
      if (prev === 'display') return 'control'
      return prev
    })
    resetIdleTimer()
  }, [resetIdleTimer])

  function seekVolume(clientX: number) {
    if (!volumeRef.current) return
    const rect = volumeRef.current.getBoundingClientRect()
    setVolume(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)))
  }

  function onVolumeMouseDown(e: React.MouseEvent) {
    e.stopPropagation()
    seekVolume(e.clientX)
    const onMove = (ev: MouseEvent) => seekVolume(ev.clientX)
    const onUp   = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const vinylDisc = (
    <>
      <div
        className="w-full h-full rounded-full border border-[#252525] overflow-hidden"
        style={{
          boxShadow: '0 0 60px rgba(0,0,0,0.9), 0 0 120px rgba(0,0,0,0.5)',
          animation: 'spin 9s linear infinite',
          animationPlayState: isPlaying ? 'running' : 'paused',
        }}
      >
        <img
          src={currentVinyl}
          alt="vinyl"
          className="w-full h-full object-cover"
          style={{ filter: 'grayscale(15%) brightness(0.85)' }}
          draggable={false}
        />
      </div>
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: 'repeating-radial-gradient(circle at center, transparent 0, transparent 3px, rgba(0,0,0,0.12) 3px, rgba(0,0,0,0.12) 4px)',
        }}
      />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-[#111111] border border-[#252525] z-10" />
    </>
  )

  return (
    <div
      className="h-screen w-screen bg-[#111111] relative overflow-hidden select-none"
      style={{ maxHeight: '100vh' }}
      onClick={handleInteraction}
    >
      <NoiseOverlay />
      <div
        className="fixed inset-0 pointer-events-none z-[9998]"
        style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)' }}
      />

      {/* ── HEADER — always visible ── */}
      <header className="absolute top-0 left-0 right-0 px-8 h-10 flex items-center justify-between z-30">
        <span style={fontMono} className="text-sm tracking-[0.3em]">
          <span className="text-[#b0b0b0] font-semibold">VE</span>
          <span className="text-[#3b3b3b]">play</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#3b3b3b] animate-pulse" />
          <span style={fontMono} className="text-[10px] tracking-[0.25em] text-[#3b3b3b]">{time}</span>
        </div>
      </header>

      <AnimatePresence>

        {/* ══ DISPLAY MODE ══ */}
        {mode === 'display' && (
          <motion.div
            key="display"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="absolute inset-0 flex flex-col items-center justify-center z-10 cursor-pointer"
          >
            {/* Vinyl — big, centered */}
            <motion.div
              layoutId="vinyl"
              className="relative shrink-0"
              style={{ width: 'min(420px, 52vh)', height: 'min(420px, 52vh)' }}
              transition={{ duration: 0.35, ease: 'easeInOut' }}
            >
              {vinylDisc}
            </motion.div>

            {/* Track info */}
            <div className="text-center mt-10 max-w-[480px]">
              <p style={fontMono} className="text-[9px] tracking-[0.45em] uppercase text-[#292929] mb-3">NOW PLAYING</p>
              <h1
                style={{ ...fontDisplay, fontWeight: 800 }}
                className="text-[2rem] tracking-tight uppercase text-[#fafafa] leading-none truncate px-4"
              >
                {loading ? '···' : (currentTrack?.title ?? 'NO TRACKS')}
              </h1>
              <p style={fontMono} className="mt-2 text-[11px] tracking-[0.22em] uppercase text-[#4a4a4a] truncate px-4">
                {!loading && currentTrack ? currentTrack.artist : ''}
              </p>
            </div>

            {/* TOD indicator — bottom right */}
            {todLabel && (
              <div className="absolute bottom-6 right-8">
                <span style={fontMono} className="text-[8px] tracking-[0.45em] uppercase text-[#252525]">
                  {todLabel}
                </span>
              </div>
            )}

            {/* Hint — bottom center */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
              <span style={fontMono} className="text-[7px] tracking-[0.35em] uppercase text-[#1c1c1c]">
                tap to control
              </span>
            </div>
          </motion.div>
        )}

        {/* ══ CONTROL MODE ══ */}
        {mode === 'control' && (
          <motion.div
            key="control"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="absolute inset-0 flex z-10"
          >
            {/* LEFT — vinyl mini + big play + progress/volume */}
            <div className="flex-1 flex flex-col overflow-hidden relative">

              {/* Mini vinyl — top left */}
              <motion.div
                layoutId="vinyl"
                className="absolute top-12 left-8 relative shrink-0"
                style={{ width: 120, height: 120 }}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
              >
                {vinylDisc}
              </motion.div>

              {/* Track info — below mini vinyl */}
              <div className="absolute" style={{ top: '180px', left: '32px', maxWidth: '220px' }}>
                <h1
                  style={{ ...fontDisplay, fontWeight: 700, fontSize: '13px' }}
                  className="text-[#aaaaaa] truncate leading-tight"
                >
                  {loading ? '···' : (currentTrack?.title ?? 'NO TRACKS')}
                </h1>
                <p style={fontMono} className="text-[8px] tracking-[0.2em] uppercase text-[#383838] truncate mt-1">
                  {!loading && currentTrack ? currentTrack.artist : ''}
                </p>
              </div>

              {/* Big NEXT + small Play/Pause — center of left area */}
              <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-5">
                  {/* Small Play/Pause — unaccented, above Next */}
                  <motion.button
                    whileTap={{ scale: 0.88 }}
                    onClick={(e) => { e.stopPropagation(); togglePlay(); resetIdleTimer() }}
                    className="flex items-center gap-2 cursor-pointer opacity-40 hover:opacity-70 transition-opacity"
                  >
                    {isPlaying
                      ? <Pause weight="fill" size={18} color="#aaaaaa" />
                      : <Play  weight="fill" size={18} color="#aaaaaa" />
                    }
                    <span style={fontMono} className="text-[8px] tracking-[0.3em] uppercase text-[#555555]">
                      {isPlaying ? 'pause' : 'play'}
                    </span>
                  </motion.button>

                  {/* Big NEXT — main action */}
                  <motion.button
                    whileTap={{ scale: 0.92 }}
                    onClick={(e) => { e.stopPropagation(); next(); resetIdleTimer() }}
                    className="w-28 h-28 rounded-full border-2 border-[#c8c8c8] flex items-center justify-center cursor-pointer hover:bg-[#1a1a1a] transition-colors"
                  >
                    <SkipForward weight="fill" size={52} color="#c8c8c8" />
                  </motion.button>
                </div>
              </div>

              {/* Progress + Skip + Volume — bottom */}
              <div className="shrink-0 px-8 pb-8 flex flex-col gap-4">
                {/* Progress */}
                <div>
                  <div className="flex justify-between mb-1.5">
                    <span style={fontMono} className="text-[9px] text-[#3a3a3a]">{formatTime(currentTime)}</span>
                    <span style={fontMono} className="text-[9px] text-[#3a3a3a]">{formatTime(duration)}</span>
                  </div>
                  <div className="w-full h-[2px] bg-[#1e1e1e]">
                    <div
                      className="h-full bg-[#555555]"
                      style={{ width: `${progress * 100}%`, transition: 'width 0.2s linear' }}
                    />
                  </div>
                </div>

                {/* Volume */}
                <div className="flex items-center gap-4">
                  <div className="flex-1 flex items-center gap-3">
                    {volume === 0
                      ? <SpeakerSimpleNone weight="fill" size={13} color="#555555" />
                      : volume < 0.5
                        ? <SpeakerSimpleLow  weight="fill" size={13} color="#555555" />
                        : <SpeakerSimpleHigh weight="fill" size={13} color="#555555" />
                    }
                    <div
                      ref={volumeRef}
                      className="flex-1 h-[2px] bg-[#222222] relative cursor-pointer group"
                      onMouseDown={onVolumeMouseDown}
                    >
                      <div className="h-full bg-[#666666]" style={{ width: `${volume * 100}%` }} />
                      <div
                        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-[#b0b0b0] shadow transition-transform group-hover:scale-110"
                        style={{ left: `calc(${volume * 100}% - 6px)`, pointerEvents: 'none' }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT — Library full height */}
            <div className="w-[280px] shrink-0 flex flex-col overflow-hidden border-l border-[#1e1e1e]">
              <ClientLibrary
                library={library}
                loading={libLoading}
                currentTrack={currentTrack}
                replaceQueueAndPlay={replaceQueueAndPlay}
              />
            </div>

          </motion.div>
        )}

      </AnimatePresence>
    </div>
  )
}
