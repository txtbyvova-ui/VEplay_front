import { useState, useEffect, useCallback, useRef } from 'react'
import type { ClientInfo, ClientCredentials, AdminTrack } from '../../api'
import {
  API_BASE, CATEGORIES, resolveSrc, deleteClient, resetClientPassword,
  getClientTracks, deleteTrack, uploadTracks, classifyFolder, moveTrack,
} from '../../api'
import { card, btn, btnDanger, chip, mono, catLabel } from '../adminStyles'
import ClassifyBatch from '../ClassifyBatch'
import ClientTrackRow from './ClientTrackRow'
import MovePopover from './MovePopover'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface ClientCardProps {
  client: ClientInfo
  allClients: ClientInfo[]
  token: string | null
  onChanged: () => void
  onCredentials: (c: ClientCredentials) => void
  onError: (msg: string) => void
}

export default function ClientCard({ client, allClients, token, onChanged, onCredentials, onError }: ClientCardProps) {
  // Mode B → one "all" folder; Mode A → the three time-of-day folders.
  const cats: string[] = client.singlePlaylist ? ['all'] : CATEGORIES
  const [expanded, setExpanded]   = useState(false)
  const [tracks, setTracks]       = useState<Record<string, AdminTrack[]> | null>(null)
  const [uploadCat, setUploadCat] = useState<string>(cats[0])
  const [progress, setProgress]   = useState<number | null>(null)
  const [dragOver, setDragOver]   = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // classify-folder flow
  const [classifyProgress, setClassifyProgress] = useState<number | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  // webkitdirectory/directory are non-standard input attributes not in the DOM types;
  // set them via setAttribute (fully typed) instead of a cast or @ts-expect-error.
  useEffect(() => {
    const el = dirInput.current
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') }
  }, [])

  // shared preview player + inline "move" popover
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const playingRef = useRef<string | null>(null)   // mirrors playingKey for the stable callback
  const [moveKey, setMoveKey] = useState<string | null>(null)
  const [moveTo, setMoveTo]   = useState<string>('')
  const [moveCat, setMoveCat] = useState<string>('')

  const loadTracks = useCallback(async () => {
    try { setTracks(await getClientTracks(token, client.folderId)) }
    catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }, [token, client.folderId, onError])

  useEffect(() => { if (expanded) loadTracks() }, [expanded, loadTracks])

  const doUpload = async (files: File[]) => {
    if (!files.length || progress !== null) return
    setProgress(0)
    try {
      const result = await uploadTracks(token, client.folderId, uploadCat, files, setProgress)
      if (result.rejected.length) {
        onError(result.rejected.map(r => `${r.filename}: ${r.reason}`).join(' · '))
      }
      onChanged()
      if (expanded) await loadTracks()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    doUpload(Array.from(e.dataTransfer.files))
  }

  const removeTrack = useCallback(async (cat: string, filename: string) => {
    if (!confirm(`Удалить «${filename}»?`)) return
    try {
      await deleteTrack(token, client.folderId, cat, filename)
      onChanged()
      await loadTracks()
    } catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }, [token, client.folderId, onChanged, onError, loadTracks])

  // Upload a picked folder for classification, then open the review modal.
  const doClassify = async (files: File[]) => {
    if (classifyProgress !== null) return
    const mp3s = files.filter(f => /\.mp3$/i.test(f.name))
    if (!mp3s.length) { onError('В выбранной папке нет mp3-файлов'); return }
    setClassifyProgress(0)
    try {
      const res = await classifyFolder(token, client.folderId, mp3s, setClassifyProgress)
      // Surface any server-rejected files so they don't vanish without a trace.
      if (res.skipped?.length) {
        onError(`Пропущено файлов: ${res.skipped.length} — ${res.skipped.join(' · ')}`)
      }
      setBatchId(res.batchId)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setClassifyProgress(null)
    }
  }

  // Preview any placed track from ~40s in, sharing one <audio>. Click again to
  // pause. Stable (functional updater reads latest playingKey) so memoized rows
  // don't all re-render when the playing row changes.
  const togglePreview = useCallback((cat: string, t: AdminTrack) => {
    const audio = previewAudio.current
    if (!audio) return
    const key = `${cat}/${t.filename}`
    if (playingRef.current === key) {
      audio.pause()
      playingRef.current = null
      setPlayingKey(null)
      return
    }
    audio.src = t.src
      ? resolveSrc(t.src, token)
      : `${API_BASE}/music/${encodeURIComponent(client.folderId)}/${cat}/${encodeURIComponent(t.filename)}`
        + (token ? `?token=${encodeURIComponent(token)}` : '')
    audio.play().catch(() => { /* autoplay/network — ignore */ })
    playingRef.current = key
    setPlayingKey(key)
  }, [token, client.folderId])

  // Toggle the inline move popover for a row; on open, default the target to this
  // same client. Stable so it doesn't churn the memoized rows.
  const onToggleMove = useCallback((key: string) => {
    setMoveKey(prev => {
      if (prev === key) return null
      const target = allClients.find(c => c.folderId === client.folderId) ?? allClients[0]
      setMoveTo(target?.folderId ?? client.folderId)
      setMoveCat(target?.singlePlaylist ? 'all' : 'day')
      return key
    })
  }, [allClients, client.folderId])

  const doMove = async (cat: string, filename: string) => {
    if (!moveTo || !moveCat) return
    try {
      await moveTrack(token, client.folderId, cat, filename, moveTo, moveCat)
      setMoveKey(null)
      onChanged()
      await loadTracks()
    } catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }

  // Pick a new move target and default its category (single-playlist → all, else day).
  const changeMoveTarget = (folderId: string) => {
    setMoveTo(folderId)
    const tc = allClients.find(c => c.folderId === folderId)
    setMoveCat(tc?.singlePlaylist ? 'all' : 'day')
  }

  const resetPassword = async () => {
    if (!confirm(`Сбросить пароль клиента «${client.name}»? Старый пароль перестанет работать.`)) return
    try { onCredentials({ ...(await resetClientPassword(token, client.folderId)), folderId: client.folderId, name: client.name }) }
    catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }

  const remove = async () => {
    if (!confirm(`Удалить клиента «${client.name}»?\n\nПапка ${client.folderId} со ВСЕЙ музыкой и пользователь ${client.username ?? ''} будут удалены безвозвратно.`)) return
    try { await deleteClient(token, client.folderId); onChanged() }
    catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }

  const totalTracks = cats.reduce((s, c) => s + (client.counts[c] ?? 0), 0)

  return (
    <div style={card}>
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{client.name}</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
            <span style={mono}>{client.folderId}</span>
            {client.username && <> · логин: <span style={mono}>{client.username}</span></>}
            {!client.username && <span style={{ color: '#ffb347' }}> · ⚠ нет пользователя</span>}
            {' · '}<span style={{ color: 'rgba(255,255,255,0.55)' }}>{client.singlePlaylist ? 'единый плейлист' : 'по времени суток'}</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {client.username && <button style={btn} onClick={resetPassword}>Сбросить пароль</button>}
          <button style={btnDanger} onClick={remove}>Удалить</button>
        </div>
      </div>

      {/* stats */}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'rgba(255,255,255,0.55)', flexWrap: 'wrap' }}>
        {cats.map(c => (
          <span key={c}>{catLabel(c)}: <b style={{ color: '#fff' }}>{client.counts[c] ?? 0}</b></span>
        ))}
        <span>Всего: <b style={{ color: '#fff' }}>{totalTracks}</b></span>
        <span>Размер: <b style={{ color: '#fff' }}>{fmtSize(client.sizeBytes)}</b></span>
      </div>

      {/* upload zone */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cats.length > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>Загрузить в:</span>
            {cats.map(c => (
              <span key={c} style={chip(uploadCat === c)} onClick={() => setUploadCat(c)}>{catLabel(c)}</span>
            ))}
          </div>
        )}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => progress === null && fileInput.current?.click()}
          style={{
            border: `1.5px dashed ${dragOver ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.15)'}`,
            borderRadius: 12, padding: '16px 12px', textAlign: 'center', cursor: 'pointer',
            fontSize: 13, color: 'rgba(255,255,255,0.5)',
            background: dragOver ? 'rgba(255,255,255,0.05)' : 'transparent',
          }}
        >
          {progress !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>Загрузка… {progress}%</span>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)' }}>
                <div style={{ height: 4, borderRadius: 2, width: `${progress}%`, background: '#fff', transition: 'width .2s' }} />
              </div>
            </div>
          ) : (
            <>Перетащите mp3 сюда или нажмите (в «{catLabel(uploadCat)}», до 20MB на файл)</>
          )}
        </div>
        <input
          ref={fileInput} type="file" accept=".mp3,audio/mpeg" multiple style={{ display: 'none' }}
          onChange={e => { doUpload(Array.from(e.target.files ?? [])); e.target.value = '' }}
        />
        {/* Auto-classify a whole folder (time-of-day clients only). */}
        {!client.singlePlaylist && (
          <div>
            <button
              style={{ ...btn, alignSelf: 'flex-start' }}
              disabled={classifyProgress !== null}
              onClick={() => classifyProgress === null && dirInput.current?.click()}
            >
              {classifyProgress !== null ? `Загрузка папки… ${classifyProgress}%` : '✨ Классифицировать папку'}
            </button>
            <input
              ref={dirInput} type="file" multiple accept=".mp3,audio/mpeg" style={{ display: 'none' }}
              onChange={e => { doClassify(Array.from(e.target.files ?? [])); e.target.value = '' }}
            />
          </div>
        )}
      </div>

      {/* track list */}
      <button style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => setExpanded(v => !v)}>
        {expanded ? 'Скрыть треки' : `Треки (${totalTracks})`}
      </button>
      {expanded && tracks && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cats.map(cat => (
            <div key={cat}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
                {catLabel(cat)} · {tracks[cat]?.length ?? 0}
              </div>
              {(tracks[cat] ?? []).map(t => {
                const key = `${cat}/${t.filename}`
                return (
                  <ClientTrackRow
                    key={t.filename}
                    cat={cat}
                    track={t}
                    isPlaying={playingKey === key}
                    moveOpen={moveKey === key}
                    movePopover={moveKey === key ? (
                      <MovePopover
                        cat={cat}
                        filename={t.filename}
                        allClients={allClients}
                        currentFolderId={client.folderId}
                        moveTo={moveTo}
                        moveCat={moveCat}
                        onChangeTarget={changeMoveTarget}
                        onChangeCategory={setMoveCat}
                        onMove={doMove}
                        onCancel={() => setMoveKey(null)}
                      />
                    ) : null}
                    onPreview={togglePreview}
                    onRemove={removeTrack}
                    onToggleMove={onToggleMove}
                  />
                )
              })}
              {!(tracks[cat]?.length) && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', padding: '2px 10px' }}>пусто</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* one shared preview player for the whole card; seek to ~40s on metadata load */}
      <audio
        ref={previewAudio}
        onLoadedMetadata={() => {
          const a = previewAudio.current
          if (a) a.currentTime = Math.min(40, (a.duration || 80) / 2)
        }}
        onEnded={() => { playingRef.current = null; setPlayingKey(null) }}
      />

      {batchId && (
        <ClassifyBatch
          batchId={batchId}
          folderId={client.folderId}
          token={token}
          onError={onError}
          onClose={() => setBatchId(null)}
          onDone={() => { setBatchId(null); onChanged(); if (expanded) loadTracks() }}
        />
      )}
    </div>
  )
}
