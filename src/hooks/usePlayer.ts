import { useState, useEffect, useRef, useCallback } from 'react'

export interface Track {
  id: string | number
  filename: string
  title: string
  artist: string
  src: string
  category?: string
}

function getTimeCategory(): string {
  const h = new Date().getHours()
  if (h >= 6  && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'day'
  return 'evening'
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function fixSrc(track: Track): Track {
  return { ...track, src: track.src.replace(/^https?:\/\/[^/]+/, API_BASE) }
}

async function loadTracks(category?: string): Promise<Track[]> {
  const cat = category ?? getTimeCategory()
  const res = await fetch(`${API_BASE}/tracks?category=${cat}`)
  if (!res.ok) throw new Error(`Server error: ${res.status}`)
  const tracks: Track[] = await res.json()
  return tracks.map(fixSrc)
}

export function usePlayer() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [volume, setVolume] = useState(0.7)

  const FADE_MS = 1600

  const audioRef    = useRef<HTMLAudioElement>(new Audio())
  const tracksRef   = useRef(tracks)
  const categoryRef = useRef(getTimeCategory())
  const volumeRef   = useRef(0.7)   // mirrors volume state
  const fadeRef     = useRef(1)     // 0–1 multiplier applied on top of volumeRef
  const fadeTm      = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { tracksRef.current = tracks }, [tracks])

  const applyVol = () => {
    audioRef.current.volume = Math.min(1, Math.max(0, volumeRef.current * fadeRef.current))
  }

  const clearFadeTm = () => {
    if (fadeTm.current !== null) { clearInterval(fadeTm.current); fadeTm.current = null }
  }

  const startFadeIn = (durationMs: number) => {
    clearFadeTm()
    fadeRef.current = 0
    applyVol()
    const steps = 40
    const stepMs = durationMs / steps
    let step = 0
    fadeTm.current = setInterval(() => {
      step++
      fadeRef.current = Math.min(1, step / steps)
      applyVol()
      if (step >= steps) clearFadeTm()
    }, stepMs)
  }

  const startFadeOutThen = (durationMs: number, cb: () => void) => {
    clearFadeTm()
    const start = fadeRef.current
    const steps = 30
    const stepMs = durationMs / steps
    let step = 0
    fadeTm.current = setInterval(() => {
      step++
      fadeRef.current = Math.max(0, start * (1 - step / steps))
      applyVol()
      if (step >= steps) { clearFadeTm(); cb() }
    }, stepMs)
  }

  const currentTrack = tracks[currentIndex] ?? null

  // Initial fetch — load tracks for current time of day
  useEffect(() => {
    loadTracks()
      .then(t => { setTracks(t); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  // Time-of-day auto rotation: check every minute; swap queue when period changes
  // Current track keeps playing — only future tracks in queue change
  useEffect(() => {
    const id = setInterval(() => {
      const newCat = getTimeCategory()
      if (newCat !== categoryRef.current) {
        categoryRef.current = newCat
        loadTracks(newCat).then(newTracks => {
          setTracks(newTracks)
          setCurrentIndex(0)
        }).catch(() => {})
      }
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // Sync user volume — respect current fade multiplier
  useEffect(() => { volumeRef.current = volume; applyVol() }, [volume])

  // Wire audio events once
  useEffect(() => {
    const audio = audioRef.current
    const onTime = () => setCurrentTime(audio.currentTime)
    const onDuration = () => setDuration(isFinite(audio.duration) ? audio.duration : 0)
    const onEnded = () => setCurrentIndex(i => (i + 1) % (tracksRef.current.length || 1))

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  // Load src when track changes — reset fade to 0, fade-in triggered by play effect
  useEffect(() => {
    if (!currentTrack) return
    clearFadeTm()
    fadeRef.current = 0
    applyVol()
    audioRef.current.src = currentTrack.src
    setCurrentTime(0)
    setDuration(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id])

  // Sync play / pause state — fade in on play, no fade on unpause
  useEffect(() => {
    if (!currentTrack) return
    const audio = audioRef.current
    if (isPlaying) {
      if (fadeRef.current < 0.05) startFadeIn(FADE_MS)   // new track: fade in
      const p = audio.play()
      if (p) p.catch(() => setIsPlaying(false))
    } else {
      audio.pause()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTrack?.id])

  const togglePlay = useCallback(() => setIsPlaying(v => !v), [])

  const next = useCallback(() => {
    startFadeOutThen(FADE_MS * 0.6, () => {
      setCurrentIndex(i => (i + 1) % (tracksRef.current.length || 1))
      setIsPlaying(true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const prev = useCallback(() => {
    startFadeOutThen(FADE_MS * 0.6, () => {
      setCurrentIndex(i => (i - 1 + (tracksRef.current.length || 1)) % (tracksRef.current.length || 1))
      setIsPlaying(true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration
    }
  }, [])

  const selectTrack = useCallback((index: number) => {
    startFadeOutThen(FADE_MS * 0.6, () => {
      setCurrentIndex(index)
      setIsPlaying(true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Replace the entire queue with new tracks and start playing at targetIndex
  const replaceQueueAndPlay = useCallback((newTracks: Track[], targetIndex: number) => {
    startFadeOutThen(FADE_MS * 0.6, () => {
      setTracks(newTracks)
      setCurrentIndex(targetIndex)
      setIsPlaying(true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    tracks,
    currentTrack,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    loading,
    error,
    togglePlay,
    replaceQueueAndPlay,
    next,
    prev,
    seek,
    selectTrack,
    volume,
    setVolume,
  }
}
