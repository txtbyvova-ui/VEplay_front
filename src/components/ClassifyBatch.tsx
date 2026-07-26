import { useState, useEffect, useRef, useCallback, memo } from 'react'
import type { Batch, Category, StagedTrack } from '../api'
import {
  CATEGORIES, getBatch, retryBatch, setTrackCategory, confirmBatch, cancelBatch, stagedPreviewUrl,
} from '../api'
import { card, btn, btnPrimary, btnDanger, chip, mono, CAT_LABEL } from './adminStyles'

interface Props {
  batchId: string
  folderId: string
  token: string | null
  /** How many files the upload accepted — shown while the classifier runs. */
  expectedCount?: number
  onDone: (moved: number) => void
  onClose: () => void
  onError: (msg: string) => void
}

const ORDER: Record<Category, number> = { morning: 0, day: 1, evening: 2 }
const effCat = (t: StagedTrack): Category => t.override ?? t.category
const trackTitle = (t: StagedTrack): string =>
  t.artist && t.artist !== 'Unknown' ? `${t.artist} — ${t.title ?? ''}` : (t.title ?? t.filename)

// grid template shared by the header and every body row so columns line up
const GRID = 'minmax(0,1.1fr) minmax(0,1.4fr) 214px minmax(48px,0.7fr) 54px 34px'

// Cheap signature of a batch — status + error + each track's filename & effective
// category. The 2s poll only replaces state when this changes, so an unchanged
// 'classifying' response (fired every 2s for minutes) triggers zero re-renders.
function batchSig(b: Batch | null): string {
  if (!b) return ''
  return `${b.status}|${b.error ?? ''}|${b.warning ?? ''}|${b.tracks.map(t => `${t.filename}:${t.override ?? t.category}`).join(',')}`
}

// ── one table row, memoized so a status poll or a sibling row's change never
// re-renders it. Only re-renders when its own track / eff / isPlaying change,
// which requires the parent to pass stable onToggleCat / onPreview callbacks. ──
interface RowProps {
  track: StagedTrack
  eff: Category
  isPlaying: boolean
  onToggleCat: (filename: string, category: Category) => void
  onPreview: (filename: string) => void
}

const TrackRow = memo(function TrackRow({ track, eff, isPlaying, onToggleCat, onPreview }: RowProps) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center',
      padding: '6px 4px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', fontSize: 13,
    }}>
      <span style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {track.filename}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {trackTitle(track)}
      </span>
      <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {CATEGORIES.map(c => (
          <span key={c} style={{ ...chip(eff === c), padding: '4px 8px', letterSpacing: '0.03em' }}
            onClick={() => eff !== c && onToggleCat(track.filename, c)}>
            {CAT_LABEL[c]}
          </span>
        ))}
      </span>
      <span style={{ color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {track.mood ?? '—'}
      </span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>
        {typeof track.energy_score === 'number' ? `${Math.round(track.energy_score * 100)}%` : '—'}
      </span>
      <button style={{ ...btn, padding: '4px 8px', fontSize: 13 }} onClick={() => onPreview(track.filename)}>
        {isPlaying ? '⏸' : '▶'}
      </button>
    </div>
  )
})

export default function ClassifyBatch({ batchId, folderId, token, expectedCount, onDone, onClose, onError }: Props) {
  const [batch, setBatch]     = useState<Batch | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [busy, setBusy]       = useState(false)
  const [pollKey, setPollKey] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playingRef = useRef<string | null>(null)   // mirrors `playing` for the stable callback
  // In-flight category PUTs: confirm() waits for them, so a click immediately
  // followed by "применить" can't distribute a track to its previous category.
  const inflight = useRef(new Set<Promise<unknown>>())
  // Per-track request counter: only the newest PUT's response may touch state,
  // otherwise a slow earlier response overwrites a newer click.
  const seq = useRef(new Map<string, number>())

  // Poll while classifying; stop once ready/error. `pollKey` bump restarts it after a retry.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const tick = async () => {
      try {
        const b = await getBatch(token, batchId)
        if (cancelled) return
        failures = 0
        setPollError(null)
        // Bail the re-render entirely when nothing changed (steady 'classifying').
        setBatch(prev => (batchSig(prev) === batchSig(b) ? prev : b))
        if (b.status === 'classifying' || b.status === 'confirming') timer = setTimeout(tick, 2000)
      } catch (e) {
        if (cancelled) return
        // A single failed poll (server restart, proxy hiccup, flaky wifi) must not
        // end the polling loop — that used to strand the modal on its spinner with
        // no way forward. Keep retrying with a backoff and show the last error.
        failures++
        setPollError(e instanceof Error ? e.message : String(e))
        timer = setTimeout(tick, Math.min(2000 * failures, 15000))
      }
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [batchId, token, pollKey])

  // Pause any preview when the modal unmounts.
  useEffect(() => () => { audioRef.current?.pause() }, [])

  // Stable across renders (reads current track via a ref, not state) so the
  // memoized rows don't all re-render when the playing track changes. Audio side
  // effects stay OUT of the state updater (StrictMode double-invokes updaters).
  const togglePlay = useCallback((filename: string) => {
    const audio = audioRef.current
    if (!audio) return
    if (playingRef.current === filename) {
      audio.pause()
      playingRef.current = null
      setPlaying(null)
      return
    }
    audio.src = stagedPreviewUrl(batchId, filename, token)
    audio.play().catch(() => { /* autoplay/network — ignore */ })
    playingRef.current = filename
    setPlaying(filename)
  }, [batchId, token])

  const changeCat = useCallback(async (filename: string, category: Category) => {
    setBatch(prev => prev
      ? { ...prev, tracks: prev.tracks.map(t => t.filename === filename ? { ...t, override: category } : t) }
      : prev)
    const mine = (seq.current.get(filename) ?? 0) + 1
    seq.current.set(filename, mine)
    const p = setTrackCategory(token, batchId, filename, category)
      .then(updated => {
        // A newer click on the same track already went out — its answer wins.
        if (seq.current.get(filename) !== mine) return
        setBatch(prev => prev
          ? { ...prev, tracks: prev.tracks.map(t => t.filename === filename ? updated : t) }
          : prev)
      })
      .catch(e => {
        onError(e instanceof Error ? e.message : String(e))
        setPollKey(k => k + 1) // re-sync from server on failure
      })
    inflight.current.add(p)
    p.finally(() => inflight.current.delete(p))
    await p
  }, [token, batchId, onError])

  const confirm = useCallback(async () => {
    setBusy(true)
    try {
      // Let every pending category change land first: confirm reads the server's
      // copy of the batch, so an unfinished PUT would file the track under the
      // category the admin just replaced.
      if (inflight.current.size) await Promise.allSettled([...inflight.current])
      const res = await confirmBatch(token, batchId)
      if (res.errors.length) {
        // Partial failure: the server keeps the batch 'ready' with just the
        // tracks that failed to move (files still staged), so the admin can
        // retry. Keep the modal open and re-sync the leftover list instead of
        // closing — closing here would orphan the staged files (disk leak).
        onError('Часть треков не перенесена: ' + res.errors.map(e => `${e.filename}: ${e.error}`).join(' · '))
        setPollKey(k => k + 1)
        setBusy(false)
        return
      }
      onDone(res.moved.length)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }, [token, batchId, onDone, onError])

  const cancel = useCallback(async () => {
    setBusy(true)
    try { await cancelBatch(token, batchId); onClose() }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }, [token, batchId, onClose, onError])

  // Closing the modal is a cancel, not a "minimise": the batch is only reachable
  // through this modal, so just hiding it would strand the staged files in
  // _incoming with no way to remove them from the UI.
  const closeAndCancel = useCallback(() => {
    if (busy) return
    const staged = batch?.tracks.length ?? 0
    const question = staged
      ? `Отменить классификацию? ${staged} загруженных файлов будут удалены (в папку клиента ничего не попадёт).`
      : 'Отменить классификацию и удалить загруженные файлы?'
    if (!window.confirm(question)) return
    cancel()
  }, [busy, batch, cancel])

  const retry = useCallback(async () => {
    setBusy(true)
    try {
      await retryBatch(token, batchId)
      setBatch(prev => prev ? { ...prev, status: 'classifying', error: undefined } : prev)
      setPollKey(k => k + 1)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, batchId, onError])

  const status = batch?.status
  const counts: Record<Category, number> = { morning: 0, day: 0, evening: 0 }
  const sorted = batch ? [...batch.tracks].sort((a, b) => ORDER[effCat(a)] - ORDER[effCat(b)]) : []
  if (batch) for (const t of batch.tracks) counts[effCat(t)]++

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        ...card, background: '#161616', width: 860, maxWidth: '100%', maxHeight: '86vh',
        gap: 14, overflow: 'hidden',
      }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Классификация папки</div>
          <span style={{ ...mono, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{folderId}</span>
          <button style={{ ...btn, marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={closeAndCancel} disabled={busy}>
            ✕
          </button>
        </div>

        {/* a failing poll is retried, not fatal — say so instead of spinning silently */}
        {pollError && status !== 'error' && (
          <div style={{ fontSize: 12, color: '#ffb347' }}>
            Нет связи с сервером ({pollError}) — продолжаем попытки…
          </div>
        )}

        {/* classifying / confirming */}
        {(status === 'classifying' || status === 'confirming' || !batch) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,0.7)' }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)',
                borderTopColor: '#fff', animation: 've-spin 0.8s linear infinite',
              }} />
              <span>
                {status === 'confirming'
                  ? 'Применяем…'
                  // batch.tracks is empty until the classifier returns, so fall back
                  // to the count the upload reported — "Классифицируем 0 треков" read
                  // like nothing had been uploaded at all.
                  : `Классифицируем ${batch?.tracks.length || expectedCount || ''} треков… (может занять несколько минут)`}
              </span>
              <style>{'@keyframes ve-spin { to { transform: rotate(360deg) } }'}</style>
            </div>
            {/* Cancelling has to be possible mid-classification too (spec: at any
                stage before confirm), otherwise a wrong folder can only be escaped
                by leaving its files staged forever. */}
            {status !== 'confirming' && (
              <button style={{ ...btnDanger, alignSelf: 'flex-start' }} onClick={cancel} disabled={busy}>
                Отменить
              </button>
            )}
          </div>
        )}

        {/* error */}
        {status === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              border: '1px solid rgba(255,80,80,0.3)', background: 'rgba(255,80,80,0.08)',
              color: '#ff8080', borderRadius: 12, padding: '12px 14px', fontSize: 13,
              whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', ...mono,
            }}>
              {batch?.error || 'Классификация завершилась с ошибкой.'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={btnPrimary} onClick={retry} disabled={busy}>Повторить</button>
              <button style={btnDanger} onClick={cancel} disabled={busy}>Отменить</button>
            </div>
          </div>
        )}

        {/* ready — the review table */}
        {status === 'ready' && batch && (
          <>
            {batch.warning && (
              <div style={{
                border: '1px solid rgba(255,190,80,0.35)', background: 'rgba(255,190,80,0.10)',
                color: '#ffc766', borderRadius: 12, padding: '10px 14px', fontSize: 13,
              }}>
                ⚠ {batch.warning}
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'rgba(255,255,255,0.6)', flexWrap: 'wrap' }}>
              <span>Morning: <b style={{ color: '#fff' }}>{counts.morning}</b></span>
              <span>Day: <b style={{ color: '#fff' }}>{counts.day}</b></span>
              <span>Evening: <b style={{ color: '#fff' }}>{counts.evening}</b></span>
              <span style={{ marginLeft: 'auto' }}>Всего: <b style={{ color: '#fff' }}>{batch.tracks.length}</b></span>
            </div>

            {/* header row */}
            <div style={{
              display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '0 4px',
              fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)',
            }}>
              <span>Файл</span><span>Артист / Название</span><span>Категория</span><span>Mood</span><span>Energy</span><span />
            </div>

            {/* body */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto', paddingRight: 4 }}>
              {sorted.map(t => (
                <TrackRow
                  key={t.filename}
                  track={t}
                  eff={effCat(t)}
                  isPlaying={playing === t.filename}
                  onToggleCat={changeCat}
                  onPreview={togglePlay}
                />
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button style={btnPrimary} onClick={confirm} disabled={busy}>Всё верно, применить</button>
              <button style={btnDanger} onClick={cancel} disabled={busy}>Отменить</button>
            </div>
          </>
        )}

        <audio
          ref={audioRef}
          onLoadedMetadata={() => {
            const a = audioRef.current
            if (a) a.currentTime = Math.min(40, (a.duration || 80) / 2)
          }}
          onEnded={() => { playingRef.current = null; setPlaying(null) }}
        />
      </div>
    </div>
  )
}
