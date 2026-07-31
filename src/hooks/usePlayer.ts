import { useState, useEffect, useRef, useCallback } from 'react'
import { API_BASE, authHeaders, resolveSrc } from '../api'
import type { Category } from '../api'
import { useAuth } from '../auth/AuthContext'
import * as graph from '../audio/graph'
import * as cache from '../audio/cache'
import * as ms from '../audio/mediaSession'
import { loadSession, saveSession } from '../audio/session'

export interface Track {
  id: string | number
  filename: string
  title: string
  artist: string
  src: string
  category?: string
}

/**
 * iOS plays straight to the hardware (see graph.bypassRecommended) — there are no
 * gain nodes to fade with, and el.volume is ignored there, so a 6 s "crossfade"
 * would just be two tracks at FULL volume on top of each other. Instead the next
 * track starts a hair before the end and the old one is cut at once: no silence,
 * no doubling.
 */
const DIRECT_AUDIO = graph.bypassRecommended()

/** Overlap between two tracks. The next one starts this many seconds before the
 *  end of the current one, so there is never silence. */
const CROSSFADE_SEC = 6
/** The same hand-off point when there is no gain to fade (DIRECT_AUDIO). */
const HANDOFF_SEC = 0.4
/** Quick fade for a manual next/prev — long enough to avoid a click. */
const SWITCH_SEC = 0.25
/** Minimum spacing between two actual skips; taps inside it are coalesced. */
const SKIP_MIN_GAP_MS = 350
/**
 * Сколько ждать события 'playing' после переключения, прежде чем считать трек
 * залипшим. Браузер на битом/зависшем источнике может молчать десятки секунд —
 * в зале это тишина без причины.
 */
const PLAY_WATCHDOG_MS = 2500
/** Больше стольких провалов подряд — останавливаемся, а не листаем папку вечно. */
const MAX_FAIL_STREAK = 5
/** How many upcoming tracks to pull into the offline cache. */
const PRELOAD_AHEAD = 3
/** Throttle for writing the resume-point to localStorage. */
const SAVE_EVERY_MS = 5000
/** Hard deadline for the one-time element priming (see warmUp). */
const WARMUP_TIMEOUT_MS = 600
/**
 * 0.05 s of 8-bit silence, as a data: URI.
 *
 * An <audio> with NO source cannot be primed at all: Chromium leaves such a
 * play() PENDING FOREVER (no resolve, no reject — networkState stays
 * NETWORK_EMPTY) and Safari rejects it. warmUp() is AWAITED by togglePlay, so
 * that pending promise wedged the Play button on every Chromium build. Giving
 * the idle element something — anything — to load makes the priming play()
 * actually settle, on every engine.
 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'

type Side = 'A' | 'B'

function getTimeCategory(): Category {
  const h = new Date().getHours()
  if (h >= 6  && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'day'
  return 'evening'
}

/** First category to play: current time-of-day if allowed, else the first one. */
function pickInitial(allowed: Category[]): Category | null {
  if (allowed.length === 0) return null
  const t = getTimeCategory()
  return allowed.includes(t) ? t : allowed[0]
}

const identityOrder = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

function shuffledOrder(n: number, startWith?: number): number[] {
  const idx = identityOrder(n)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  if (startWith !== undefined) {
    const at = idx.indexOf(startWith)
    if (at > 0) { idx.splice(at, 1); idx.unshift(startWith) }
  }
  return idx
}

export function usePlayer() {
  const { token, user } = useAuth()
  const allowed    = (user?.categories ?? []) as Category[]
  const allowedKey = allowed.join(',')

  const [tracks, setTracks]           = useState<Track[]>([])
  const [order, setOrder]             = useState<number[]>([])
  const [orderPos, setOrderPos]       = useState(0)
  const [isPlaying, setIsPlaying]     = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration]       = useState(0)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [volume, setVolumeState]      = useState(0.7)
  const [shuffle, setShuffle]         = useState(false)

  const currentIndex = order[orderPos] ?? 0
  const currentTrack = tracks[currentIndex] ?? null

  // ── audio elements + graph ────────────────────────────────────────────────
  const elA = useRef<HTMLAudioElement | null>(null)
  const elB = useRef<HTMLAudioElement | null>(null)
  const gainA = useRef<GainNode | null>(null)
  const gainB = useRef<GainNode | null>(null)
  const revokeA = useRef<() => void>(() => {})
  const revokeB = useRef<() => void>(() => {})
  const active = useRef<Side>('A')
  const graphOk = useRef(false)
  const crossfading = useRef(false)
  const lastSaved = useRef(0)

  // Mirrors for stable callbacks (never re-create handlers on every tick).
  const tracksRef   = useRef<Track[]>([])
  const orderRef    = useRef<number[]>([])
  const orderPosRef = useRef(0)
  /** Position the user has ASKED for, updated synchronously. orderPosRef only moves
   *  once a switch has actually landed, so computing "next" from it made every tap
   *  during an in-flight switch aim at the SAME track — eight quick taps advanced
   *  the queue by one and the rest were silently swallowed. */
  const intendedPos = useRef(0)
  /** Monotonic switch token — only the newest switch may finish (last write wins). */
  const switchSeq   = useRef(0)
  /** Pending trailing skip (see scheduleSkip) and when the last one actually ran. */
  const skipTimer   = useRef<number | null>(null)
  const lastSkipAt  = useRef(0)
  /** Ватчдог запуска трека (см. armWatchdog). `attemptSeq` — номер попытки
   *  воспроизведения, `playingToken` — номер попытки, на которой реально пришло
   *  событие 'playing'. Совпали — трек зазвучал. */
  const watchdog     = useRef<number | null>(null)
  const attemptSeq   = useRef(0)
  const playingToken = useRef(-1)
  /** Подряд идущие провалы источника — страховка от бесконечной карусели. */
  const failStreak   = useRef(0)
  /** Хук размонтирован: после этого ни переключаться, ни трогать состояние нельзя. */
  const disposed     = useRef(false)
  /** switchTo через ref — ватчдог и обработчик ошибок объявлены раньше него. */
  const switchToRef  = useRef<(pos: number, seconds: number) => void>(() => {})
  const volumeRef   = useRef(0.7)
  const shuffleRef  = useRef(false)
  const categoryRef = useRef<Category | null>(null)
  const playingRef  = useRef(false)
  useEffect(() => { tracksRef.current = tracks },     [tracks])
  useEffect(() => { orderRef.current = order },       [order])
  useEffect(() => { orderPosRef.current = orderPos }, [orderPos])
  useEffect(() => { shuffleRef.current = shuffle },   [shuffle])
  useEffect(() => { playingRef.current = isPlaying }, [isPlaying])

  const elFor   = (s: Side) => (s === 'A' ? elA.current : elB.current)
  const gainFor = (s: Side) => (s === 'A' ? gainA.current : gainB.current)
  const other   = (s: Side): Side => (s === 'A' ? 'B' : 'A')

  /** Apply gain either through Web Audio (mobile-safe) or the element (fallback). */
  const applyGain = useCallback((side: Side, value: number, seconds?: number) => {
    const g = gainFor(side)
    if (graphOk.current && g) {
      if (seconds && seconds > 0) graph.rampGain(g, value, seconds)
      else graph.setGain(g, value)
      return
    }
    const el = elFor(side)   // no Web Audio: fall back to element volume (desktop)
    if (el) el.volume = Math.min(1, Math.max(0, value * volumeRef.current))
  }, [])

  // Create the two elements once and wire them into the graph.
  useEffect(() => {
    disposed.current = false
    const make = (): HTMLAudioElement => {
      const el = new Audio()
      el.preload = 'auto'
      // REQUIRED: without CORS-clean media a MediaElementSource emits SILENCE
      // (dev runs vite:5173 against api:3001). The API sends ACAO: *.
      el.crossOrigin = 'anonymous'
      // Programmatic elements get no attributes from JSX. Without playsinline iOS
      // may hand playback to its own fullscreen player, which ends background audio.
      // Set as ATTRIBUTES: that is what WebKit honours, and lib.dom types the
      // matching property on HTMLVideoElement only — no cast needed this way.
      el.setAttribute('playsinline', '')
      el.setAttribute('webkit-playsinline', '')
      return el
    }
    elA.current = make()
    elB.current = make()
    try {
      // DIRECT_AUDIO (iOS): deliberately NOT attached. A MediaElementSource ties the
      // element's audio to the AudioContext, which iOS suspends on screen lock.
      if (!DIRECT_AUDIO && graph.isSupported()) {
        gainA.current = graph.attach(elA.current)
        gainB.current = graph.attach(elB.current)
        graphOk.current = true
        graph.setMasterVolume(volumeRef.current)
      }
    } catch {
      graphOk.current = false   // degrade to element volume; music still plays
    }
    applyGain('A', 0)
    applyGain('B', 0)

    // iOS starts the context suspended and only resumes inside a gesture.
    // Also kick off the one-time <audio> element blessing (warmUp, defined
    // below) right here: it needs a real play()/pause() cycle on both
    // elements, and starting that on the FIRST touch (pointerdown fires well
    // before the click that drives togglePlay) gives it a head start so it's
    // finished — not racing — by the time the real play() call happens.
    // No graph on DIRECT_AUDIO — resuming would create an AudioContext for nothing.
    const kick = () => { if (!DIRECT_AUDIO) void graph.resume(); void warmUpRef.current?.() }
    window.addEventListener('pointerdown', kick, { once: true })
    window.addEventListener('keydown', kick, { once: true })

    return () => {
      window.removeEventListener('pointerdown', kick)
      window.removeEventListener('keydown', kick)
      if (skipTimer.current !== null) { window.clearTimeout(skipTimer.current); skipTimer.current = null }
      disposed.current = true
      if (watchdog.current !== null) { window.clearTimeout(watchdog.current); watchdog.current = null }
      // Nothing downstream cares any more: drop the in-flight preload, stop both
      // elements and release their blob URLs.
      cache.cancelPreload()
      for (const el of [elA.current, elB.current]) {
        if (!el) continue
        el.pause()
        // Отцепить от графа ОБЯЗАТЕЛЬНО: следующее монтирование создаст новые
        // элементы и новую пару нод, а эта осталась бы подключённой к компрессору
        // и удерживала бы свой <audio>. Замерено: +2 MediaElementSource за каждый
        // заход в админку и обратно.
        graph.detach(el)
        // И освободить источник, иначе брошенный элемент продолжит докачивать трек.
        try { el.removeAttribute('src'); el.load() } catch { /* ignore */ }
      }
      revokeA.current(); revokeB.current()
    }
  }, [applyGain])

  // ── queue loading ─────────────────────────────────────────────────────────
  const loadTracks = useCallback(async (category: Category): Promise<Track[]> => {
    const res = await fetch(`${API_BASE}/tracks?category=${category}`, { headers: authHeaders(token) })
    if (!res.ok) throw new Error(`Server error: ${res.status}`)
    const data: Track[] = await res.json()
    return data.map(t => ({ ...t, src: resolveSrc(t.src, token) }))
  }, [token])

  /**
   * Put a track into one side, preferring the offline cache.
   *
   * `stillWanted` is checked AFTER the async cache lookup and BEFORE the element
   * is touched: during a burst of taps several loads are in flight at once, and a
   * late-arriving stale one used to overwrite src + call load() on the side a
   * newer switch had already started — aborting its play() and leaving the player
   * sitting on a paused track.
   */
  const loadInto = useCallback(async (side: Side, track: Track, stillWanted?: () => boolean) => {
    const el = elFor(side)
    if (!el) return
    const { src, revoke } = await cache.playableUrl(track.src)
    if (stillWanted && !stillWanted()) { revoke(); return }
    // blob: URLs are same-origin — crossOrigin must be cleared or Safari refuses.
    el.crossOrigin = src.startsWith('blob:') ? null : 'anonymous'
    if (side === 'A') { revokeA.current(); revokeA.current = revoke } else { revokeB.current(); revokeB.current = revoke }
    el.src = src
    el.load()
  }, [])

  /**
   * Cache the next few tracks in the background (never blocks playback).
   *
   * Two things keep a burst of skips from drowning the browser: cache.preload()
   * aborts whatever the previous run was still downloading, and a pending skip
   * suppresses the run entirely — there is no point pulling three tracks that the
   * very next tap makes irrelevant. The preload that matters starts once the
   * queue settles.
   */
  const preloadAhead = useCallback((fromPos: number) => {
    if (skipTimer.current !== null) { cache.cancelPreload(); return }
    const ord = orderRef.current, ts = tracksRef.current
    if (!ord.length) return
    const urls: string[] = []
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {
      const t = ts[ord[(fromPos + i) % ord.length]]
      if (t) urls.push(t.src)
    }
    void cache.preload(urls)
  }, [])

  // ── initial fetch (+ restore of the saved session) ────────────────────────
  useEffect(() => {
    const cat = pickInitial(allowed)
    if (!token || !cat) { setTracks([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    const saved = loadSession(user?.username)
    const startCat = (saved && allowed.includes(saved.category as Category) ? saved.category : cat) as Category
    categoryRef.current = startCat
    loadTracks(startCat)
      .then(list => {
        if (cancelled) return
        const startIdx = saved ? Math.max(0, list.findIndex(t => t.filename === saved.filename)) : 0
        const useShuffle = saved?.shuffle ?? false
        const ord = useShuffle ? shuffledOrder(list.length, startIdx) : identityOrder(list.length)
        setTracks(list)
        setShuffle(useShuffle)
        setOrder(ord)
        setOrderPos(Math.max(0, ord.indexOf(startIdx)))
        intendedPos.current = Math.max(0, ord.indexOf(startIdx))
        setLoading(false)
        // Restore the exact position; playback stays paused until the user taps
        // (browsers block un-gestured autoplay anyway).
        if (saved && list[startIdx]) {
          void loadInto(active.current, list[startIdx]).then(() => {
            const el = elFor(active.current)
            if (el && saved.position > 0) {
              const seekTo = () => { try { el.currentTime = saved.position } catch { /* ignore */ } }
              if (el.readyState >= 1) seekTo()
              else el.addEventListener('loadedmetadata', seekTo, { once: true })
              setCurrentTime(saved.position)
            }
          })
        } else if (list[0]) {
          // Fresh start: prime the active element's src NOW so the first Play tap
          // can call play() synchronously inside the gesture — an async load
          // between the tap and play() is what iOS treats as losing the gesture.
          void loadInto(active.current, list[0])
        }
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, allowedKey, loadTracks])

  // Time-of-day rotation: swap the queue when the slot changes.
  useEffect(() => {
    const id = setInterval(() => {
      const newCat = getTimeCategory()
      if (allowed.includes(newCat) && newCat !== categoryRef.current) {
        categoryRef.current = newCat
        loadTracks(newCat).then(list => {
          setTracks(list)
          const ord = shuffleRef.current ? shuffledOrder(list.length) : identityOrder(list.length)
          setOrder(ord)
          setOrderPos(0)
          intendedPos.current = 0
        }).catch(() => {})
      }
    }, 60_000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedKey, loadTracks])

  // ── volume ────────────────────────────────────────────────────────────────
  const setVolume = useCallback((v: number) => {
    const value = Math.min(1, Math.max(0, v))
    volumeRef.current = value
    setVolumeState(value)
    // The whole point of the Web Audio graph: iOS/Android ignore el.volume.
    if (graphOk.current) graph.setMasterVolume(value)
    else { const el = elFor(active.current); if (el) el.volume = value }
  }, [])

  // ── one-time iOS unlock ─────────────────────────────────────────────────────
  // iOS Safari blesses an <audio> element for *programmatic* playback only after
  // it has been .play()'d inside a user gesture. The idle crossfade element (B)
  // otherwise stays locked forever: the gapless switch silently fails and the
  // main Play/Pause button is left driving a permanently-paused element — the
  // "works exactly once" bug. Prime BOTH elements on the first gesture.
  // `warming` suppresses the play/pause events this priming emits so the UI
  // never flickers; it is awaited fully so the real play() that follows can
  // never race the priming pause().
  const warming = useRef(false)
  // Concurrent callers (e.g. the early pointerdown kick AND a fast togglePlay
  // tap) must all await the SAME run — otherwise the second caller saw the
  // "already primed" flag and returned immediately, before the first call's
  // priming pause() had actually happened, letting it land AFTER the real
  // play() and silently re-pause the element. Caching the promise fixes that.
  const warmUpPromise = useRef<Promise<void> | null>(null)

  /** Prime ONE element: a real play()/pause() pair inside the user gesture. */
  const primeElement = useCallback(async (el: HTMLAudioElement | null): Promise<void> => {
    if (!el) return
    // An element with nothing loaded cannot be primed at all (see SILENT_WAV) —
    // lend it the silence. Never clobber a side that already holds a real track.
    const borrowed = !el.getAttribute('src')
    if (borrowed) {
      // Safari refuses a same-origin (data:/blob:) source on a CORS-tagged
      // element; loadInto() sets crossOrigin again for every real track anyway.
      el.crossOrigin = null
      el.src = SILENT_WAV
    }
    try {
      await el.play()
      // If the deadline in warmUp() already fired, the REAL play() may have
      // started meanwhile — pausing here would be exactly the bug 05c3508 fixed.
      if (warming.current) el.pause()
    } catch { /* autoplay refused — the element is blessed for the session anyway */ }
    // Back to "empty" so togglePlay's `if (!el.src)` still loads the real track.
    // Skipped when something already replaced our placeholder.
    if (borrowed && el.getAttribute('src') === SILENT_WAV) {
      el.removeAttribute('src')
      el.load()
    }
  }, [])

  const warmUp = useCallback((): Promise<void> => {
    if (warmUpPromise.current) return warmUpPromise.current
    warming.current = true
    const primed = Promise.all([elA.current, elB.current].map(el => primeElement(el))).then(() => {})
    // Hard deadline. togglePlay and switchTo AWAIT this promise, so it must settle
    // whatever an engine does with a play() we do not control — a pending one used
    // to leave the Play button permanently dead.
    const deadline = new Promise<void>(resolve => { window.setTimeout(resolve, WARMUP_TIMEOUT_MS) })
    warmUpPromise.current = Promise.race([primed, deadline]).then(() => { warming.current = false })
    return warmUpPromise.current
  }, [primeElement])
  const warmUpRef = useRef(warmUp)
  useEffect(() => { warmUpRef.current = warmUp }, [warmUp])

  // ── ватчдог запуска ───────────────────────────────────────────────────────
  const clearWatchdog = useCallback(() => {
    if (watchdog.current !== null) { window.clearTimeout(watchdog.current); watchdog.current = null }
  }, [])

  /**
   * Сторожевой таймер на запуск трека.
   *
   * Симптом, ради которого он есть: элемент принял src, `play()` отработал без
   * ошибки, а звука нет — источник битый, сеть подвисла, декодер задумался. Сам
   * браузер в этом состоянии может молчать десятки секунд, и в зале это тишина
   * без видимой причины. Если за PLAY_WATCHDOG_MS не пришло 'playing' — рвём
   * источник и уходим на следующий трек.
   *
   * НЕ срабатывает на поставленном на паузу элементе, и это принципиально: пауза
   * означает либо решение пользователя, либо отказ iOS в автоплее вне жеста. В
   * обоих случаях уходить на следующий трек нельзя — иначе плеер прошуршит всю
   * папку за секунды, потому что каждый следующий play() отклонят так же.
   */
  const armWatchdog = useCallback((side: Side, attempt: number) => {
    clearWatchdog()
    watchdog.current = window.setTimeout(() => {
      watchdog.current = null
      if (disposed.current) return
      if (playingToken.current === attempt) return      // 'playing' пришёл — всё в порядке
      const el = elFor(side)
      if (!el || active.current !== side) return
      if (el.paused) return                             // см. комментарий выше
      failStreak.current++
      console.warn(`[player] трек не зазвучал за ${PLAY_WATCHDOG_MS} мс — обрываем источник`, {
        readyState: el.readyState, networkState: el.networkState,
        error: el.error?.code ?? null, подряд: failStreak.current,
      })
      try { el.pause(); el.removeAttribute('src'); el.load() } catch { /* ignore */ }
      if (failStreak.current > MAX_FAIL_STREAK) {
        console.error(`[player] ${failStreak.current} треков подряд не запустились — останавливаемся`)
        setIsPlaying(false)
        setError('Не удаётся воспроизвести треки — проверьте связь с сервером')
        return
      }
      switchToRef.current(intendedPos.current + 1, SWITCH_SEC)
    }, PLAY_WATCHDOG_MS)
  }, [clearWatchdog])

  // ── switching ─────────────────────────────────────────────────────────────
  /** Start `pos` on the idle side and cross-fade to it over `seconds`. */
  const switchTo = useCallback(async (pos: number, seconds: number) => {
    const ord = orderRef.current, ts = tracksRef.current
    if (!ord.length) return
    const nextPos = ((pos % ord.length) + ord.length) % ord.length
    const track = ts[ord[nextPos]]
    if (!track) return

    intendedPos.current = nextPos
    const my = ++switchSeq.current
    const superseded = () => switchSeq.current !== my

    const from = active.current
    const to   = other(from)
    try {
      await loadInto(to, track, () => !superseded())
      if (superseded()) return       // a newer tap already owns this side
      const elTo = elFor(to)
      if (!elTo) return

      if (!DIRECT_AUDIO) await graph.resume()
      await warmUp()                 // bless both elements if this is the first gesture
      if (superseded()) return
      // Without gain nodes there is nothing to ramp, so the hand-off is immediate:
      // the incoming track comes in at full level and the outgoing one is cut below
      // (fadeSec 0 → the stop timeout fires in 60 ms) instead of doubling for 6 s.
      const fadeSec = DIRECT_AUDIO ? 0 : seconds
      applyGain(to, 0)

      // `active` must move BEFORE play(): the play/playing/pause listeners ignore
      // every event that does not come from the ACTIVE side, so starting the new
      // element while `active` still pointed at the old one dropped its 'play'
      // event on the floor and left isPlaying frozen at whatever it was.
      active.current = to
      setOrderPos(nextPos)
      orderPosRef.current = nextPos
      setCurrentTime(0)

      // Ватчдог взводится ДО play(): если промис вообще не settle-ится (а такое
      // бывает), сработает он.
      const attempt = ++attemptSeq.current
      armWatchdog(to, attempt)
      try {
        await elTo.play()
      } catch (e) {
        const err = e as DOMException
        // AbortError = play() interrupted by a fast switch/reload — harmless.
        if (err?.name !== 'AbortError') {
          // Чаще всего NotAllowedError на iOS: автоплей вне жеста. Состояние ниже
          // всё равно сверяется с элементом, так что UI честно покажет паузу.
          console.error('[player] play() отклонён:', err?.name, err?.message)
        }
      }
      if (superseded()) return

      applyGain(to, 1, fadeSec)
      applyGain(from, 0, fadeSec)
      setDuration(isFinite(elTo.duration) ? elTo.duration : 0)

      // The authoritative moment: whatever the events did or did not deliver, the
      // element itself knows the truth. Without this a refused play() (iOS says no
      // to programmatic playback outside a gesture) left isPlaying stuck on true —
      // silence with a spinning vinyl, and a Play button that could no longer
      // recover it because togglePlay was pausing an already-paused element.
      setIsPlaying(!elTo.paused)

      const elFrom = elFor(from)
      window.setTimeout(() => {
        // A newer switch may have made THIS side active again — a manual next inside
        // the 6 s auto-crossfade window does exactly that (A→B, then B→A). Firing a
        // stale pause() then kills live playback and leaves the venue silent until
        // someone taps Play. Only ever pause a side that is no longer active.
        if (elFor(active.current) === elFrom) return
        if (!elFrom) return
        try {
          elFrom.pause()
          elFrom.currentTime = 0
          // Release the retired side's network + buffer. preload="auto" keeps an
          // element downloading its track even while paused, so during a burst of
          // skips every abandoned track kept pulling bytes in the background. The
          // next loadInto() assigns a fresh src, so nothing is lost.
          if (elFrom.getAttribute('src')) { elFrom.removeAttribute('src'); elFrom.load() }
        } catch { /* ignore */ }
      }, Math.ceil(fadeSec * 1000) + 60)

      preloadAhead(nextPos)
    } finally {
      crossfading.current = false    // never wedge the auto-crossfade trigger, even on a throw
    }
  }, [applyGain, loadInto, preloadAhead, warmUp, armWatchdog])

  // Ватчдог и обработчик 'error' объявлены выше switchTo, поэтому зовут его через ref.
  useEffect(() => { switchToRef.current = (pos, seconds) => { void switchTo(pos, seconds) } }, [switchTo])

  // Both step from the INTENDED position, not the playing one: during an in-flight
  // switch orderPosRef still holds the old value, so a burst of taps all resolved
  // to the same target and most of the skips were silently swallowed.
  const runSkip = useCallback(() => {
    skipTimer.current = null
    lastSkipAt.current = Date.now()
    void switchTo(intendedPos.current, SWITCH_SEC)
  }, [switchTo])

  /**
   * Spam guard for next/prev — COALESCING, not dropping.
   *
   * A lone tap runs immediately (a venue expects the button to answer). Taps that
   * land inside SKIP_MIN_GAP_MS only move the intended position and arm one
   * trailing switch, so five quick taps still end up five tracks further on, but
   * the browser loads exactly one track instead of five. Ignoring the extra taps
   * outright would be cheaper to write and worse to use: the operator would have
   * to wait out the lockout and would silently lose presses.
   */
  const scheduleSkip = useCallback((delta: number) => {
    intendedPos.current += delta          // switchTo normalises into range
    if (skipTimer.current !== null) return          // a trailing run is already armed
    const since = Date.now() - lastSkipAt.current
    if (since >= SKIP_MIN_GAP_MS) { runSkip(); return }
    skipTimer.current = window.setTimeout(runSkip, SKIP_MIN_GAP_MS - since)
  }, [runSkip])

  const next = useCallback(() => scheduleSkip(+1), [scheduleSkip])
  const prev = useCallback(() => scheduleSkip(-1), [scheduleSkip])
  const selectTrack = useCallback((index: number) => {
    const at = orderRef.current.indexOf(index)
    void switchTo(at >= 0 ? at : 0, SWITCH_SEC)
  }, [switchTo])

  // ── play / pause ──────────────────────────────────────────────────────────
  // The UI stays bound to the elements' native 'play'/'playing'/'pause' events, so
  // the icon mirrors what audio is really doing. But the DECISION here is taken
  // from the element, never from React state: if the two ever disagree, acting on
  // stale state made the button pause an already-paused element (no event, no
  // change) and it looked dead. Reading el.paused makes it impossible to wedge.
  const togglePlay = useCallback(() => {
    const cur = elFor(active.current)
    if (cur && !cur.paused) {
      // Really playing → pause. The native 'pause' event flips the UI.
      clearWatchdog()          // пауза — не залипание, сторожить нечего
      cur.pause()
      return
    }
    // Play: everything below must stay inside this user gesture for iOS.
    void (async () => {
      if (!DIRECT_AUDIO) await graph.resume()   // resumes the ctx iff suspended
      await warmUp()                // one-time: bless BOTH <audio> elements this session
      const el = elFor(active.current)
      if (!el) return
      const ts = tracksRef.current, ord = orderRef.current
      if (!el.src && ts.length) await loadInto(active.current, ts[ord[orderPosRef.current] ?? 0])
      applyGain(active.current, 1)
      const attempt = ++attemptSeq.current
      armWatchdog(active.current, attempt)
      try {
        await el.play()             // normally the UI flips via the 'play' event
      } catch (e) {
        const err = e as DOMException
        // AbortError = play() interrupted by a quick pause()/reload — harmless.
        if (err?.name !== 'AbortError') {
          console.error('[player] play() отклонён:', err?.name, err?.message)
        }
      }
      // Backstop for the case the event cannot deliver: an element that was ALREADY
      // playing fires no 'play', and a refused play() fires nothing at all. Either
      // way the element knows the truth, so take it from there.
      setIsPlaying(!el.paused)
    })()
  }, [applyGain, loadInto, warmUp, armWatchdog, clearWatchdog])

  // ── per-element events: progress, crossfade trigger, safety net ───────────
  useEffect(() => {
    const sides: Side[] = ['A', 'B']
    const offs: (() => void)[] = []

    for (const side of sides) {
      const el = elFor(side)
      if (!el) continue

      const onTime = () => {
        if (active.current !== side) return           // the fading-out side is ignored
        setCurrentTime(el.currentTime)
        const dur = el.duration
        if (isFinite(dur) && dur > 0) {
          // Start the next track before this one ends → no silence.
          const fade = Math.min(DIRECT_AUDIO ? HANDOFF_SEC : CROSSFADE_SEC, dur / 3)
          if (!crossfading.current && dur - el.currentTime <= fade && orderRef.current.length > 0) {
            crossfading.current = true
            void switchTo(intendedPos.current + 1, fade)
          }
          // Throttled resume-point.
          const now = Date.now()
          if (now - lastSaved.current > SAVE_EVERY_MS) {
            lastSaved.current = now
            const t = tracksRef.current[orderRef.current[orderPosRef.current]]
            if (t && user?.username) {
              saveSession({ username: user.username, category: categoryRef.current ?? '', filename: t.filename, position: el.currentTime, shuffle: shuffleRef.current })
            }
          }
          ms.setPositionState(dur, el.currentTime)
        }
      }
      const onDur = () => { if (active.current === side) setDuration(isFinite(el.duration) ? el.duration : 0) }
      // Safety net: if the crossfade never fired (unknown duration, stalled), keep going.
      // Safety net: the faded-OUT element also fires 'ended' (it plays to its
      // natural end behind the crossfade) — ignore it, `active` already moved on.
      // Only an 'ended' on the ACTIVE side means the crossfade never ran.
      const onEnded = () => { if (active.current === side) { crossfading.current = false; void switchTo(intendedPos.current + 1, SWITCH_SEC) } }
      // UI state is driven STRICTLY by the element's own events, so the icon can
      // never disagree with what audio is actually doing (even when iOS refuses a
      // play()). `warming` skips the one-time unlock priming; the `active` check
      // ignores the faded-OUT side. No `crossfading` gate — a mid-crossfade throw
      // must never be able to wedge the pause state.
      const onPlay  = () => { if (!warming.current && active.current === side) setIsPlaying(true) }
      const onPause = () => { if (!warming.current && active.current === side) setIsPlaying(false) }
      // Звук ПОШЁЛ. Только это снимает ватчдог — 'play' недостаточно, он означает
      // лишь «элемент согласился попробовать».
      const onPlaying = () => {
        if (warming.current || active.current !== side) return
        playingToken.current = attemptSeq.current
        failStreak.current = 0
        clearWatchdog()
      }
      // Элемент отверг источник: битые байты из кэша, пропавший файл, отказ
      // декодера. Ждать здесь нечего — ни 'ended', ни 'timeupdate' не придут, и
      // без этого обработчика плеер молча стоит.
      const onError = () => {
        if (disposed.current || active.current !== side) return
        console.error('[player] источник отвергнут элементом', {
          side, code: el.error?.code ?? null,
          src: (el.getAttribute('src') || '').slice(0, 80),
        })
        clearWatchdog()
        failStreak.current++
        // Байты в кэше могли докачаться битыми — выбрасываем, иначе следующий
        // круг плейлиста споткнётся о них снова.
        const t = tracksRef.current[orderRef.current[orderPosRef.current]]
        if (t) void cache.drop(t.src)
        if (failStreak.current > MAX_FAIL_STREAK) {
          console.error(`[player] ${failStreak.current} треков подряд не запустились — останавливаемся`)
          setIsPlaying(false)
          setError('Не удаётся воспроизвести треки — проверьте связь с сервером')
          return
        }
        switchToRef.current(intendedPos.current + 1, SWITCH_SEC)
      }

      el.addEventListener('timeupdate', onTime)
      el.addEventListener('durationchange', onDur)
      el.addEventListener('ended', onEnded)
      el.addEventListener('play', onPlay)
      el.addEventListener('playing', onPlay)
      el.addEventListener('pause', onPause)
      el.addEventListener('playing', onPlaying)
      el.addEventListener('error', onError)
      offs.push(() => {
        el.removeEventListener('timeupdate', onTime)
        el.removeEventListener('durationchange', onDur)
        el.removeEventListener('ended', onEnded)
        el.removeEventListener('play', onPlay)
        el.removeEventListener('playing', onPlay)
        el.removeEventListener('pause', onPause)
        el.removeEventListener('playing', onPlaying)
        el.removeEventListener('error', onError)
      })
    }
    return () => { for (const off of offs) off() }
  }, [switchTo, user?.username, clearWatchdog])

  // ── lock-screen controls + metadata ───────────────────────────────────────
  useEffect(() => {
    ms.setHandlers({
      play:  () => { if (!playingRef.current) togglePlay() },
      pause: () => { if (playingRef.current) togglePlay() },
      next,
      prev,
    })
    return () => ms.clearHandlers()
  }, [togglePlay, next, prev])

  useEffect(() => { ms.setMetadata(currentTrack) }, [currentTrack])
  useEffect(() => { ms.setPlaybackState(isPlaying) }, [isPlaying])

  // ── persist the resume point on background / unload ───────────────────────
  useEffect(() => {
    const persist = () => {
      const el = elFor(active.current)
      const t  = tracksRef.current[orderRef.current[orderPosRef.current]]
      if (el && t && user?.username) {
        saveSession({ username: user.username, category: categoryRef.current ?? '', filename: t.filename, position: el.currentTime, shuffle: shuffleRef.current })
      }
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') { persist(); return }
      // Back from the background: a browser may have suspended the AudioContext,
      // and everything routed through the graph stays silent until it is resumed.
      if (!DIRECT_AUDIO) void graph.resume()
    }
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onVis)
      persist()
    }
  }, [user?.username])

  // Cache the upcoming tracks as soon as a queue exists.
  useEffect(() => { if (tracks.length) preloadAhead(orderPos) }, [tracks, orderPos, preloadAhead])

  // ── public actions ────────────────────────────────────────────────────────
  const toggleShuffle = useCallback(() => {
    setShuffle(prevOn => {
      const on = !prevOn
      shuffleRef.current = on
      const cur = orderRef.current[orderPosRef.current] ?? 0
      const ord = on ? shuffledOrder(tracksRef.current.length, cur) : identityOrder(tracksRef.current.length)
      setOrder(ord)
      setOrderPos(Math.max(0, ord.indexOf(cur)))
      intendedPos.current = Math.max(0, ord.indexOf(cur))
      return on
    })
  }, [])

  const seek = useCallback((ratio: number) => {
    const el = elFor(active.current)
    if (el && isFinite(el.duration) && el.duration > 0) el.currentTime = ratio * el.duration
  }, [])

  const replaceQueueAndPlay = useCallback((newTracks: Track[], targetIndex: number) => {
    tracksRef.current = newTracks
    const ord = shuffleRef.current ? shuffledOrder(newTracks.length, targetIndex) : identityOrder(newTracks.length)
    orderRef.current = ord
    setTracks(newTracks)
    setOrder(ord)
    const pos = Math.max(0, ord.indexOf(targetIndex))
    void switchTo(pos, SWITCH_SEC)   // the new side's 'play' event sets isPlaying
  }, [switchTo])

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
    // False where the software volume cannot work (DIRECT_AUDIO: iOS ignores
    // el.volume and there is no master gain). The UI must not show a slider that
    // silently does nothing — volume there is the device's hardware buttons.
    volumeControllable: !DIRECT_AUDIO,
    shuffle,
    toggleShuffle,
  }
}
