import { useState, useEffect, useCallback, useRef } from 'react'
import type { Category, ClientInfo, ClientCredentials, AdminTrack } from '../api'
import {
  CATEGORIES, listClients, createClient, deleteClient, resetClientPassword,
  getClientTracks, deleteTrack, uploadTracks, updateUser,
} from '../api'
import { useAuth } from '../auth/AuthContext'

const CAT_LABEL: Record<Category, string> = { morning: 'Morning', day: 'Day', evening: 'Evening' }

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ── shared styles (match the app's dark glass look) ──────────────────────────

const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
}
const btn: React.CSSProperties = {
  padding: '8px 14px', fontSize: 13, borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)', color: '#eee', cursor: 'pointer',
}
const btnPrimary: React.CSSProperties = {
  ...btn, background: '#fff', color: '#0a0a0a', fontWeight: 700, border: 'none',
}
const btnDanger: React.CSSProperties = {
  ...btn, color: '#ff8080', borderColor: 'rgba(255,80,80,0.3)',
}
const input: React.CSSProperties = {
  padding: '10px 12px', fontSize: 14, background: 'rgba(255,255,255,0.05)', color: '#fff',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, outline: 'none',
}
const chip = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer', userSelect: 'none',
  border: on ? '1.5px solid rgba(255,255,255,0.55)' : '1.5px solid rgba(255,255,255,0.1)',
  background: on ? 'rgba(255,255,255,0.16)' : 'transparent',
  color: on ? '#fff' : 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em',
})
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' }

// ── credentials modal (password is shown exactly once) ───────────────────────

function CredentialsModal({ creds, onClose }: { creds: ClientCredentials; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* clipboard unavailable (http) — user can select manually */ }
  }

  const row = (label: string, value: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 70, fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span style={{ ...mono, fontSize: 15, flex: 1, userSelect: 'all' }}>{value}</span>
      <button style={btn} onClick={() => copy(label, value)}>
        {copied === label ? '✓' : 'Скопировать'}
      </button>
    </div>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{ ...card, background: '#161616', width: 420, maxWidth: '100%', gap: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>Доступ клиента{creds.name ? ` — ${creds.name}` : ''}</div>
        {row('Логин', creds.username)}
        {row('Пароль', creds.password)}
        <div style={{ fontSize: 12, color: '#ffb347' }}>
          ⚠ Пароль показывается один раз — сервер хранит только хеш. Сохраните его сейчас.
        </div>
        <button style={btnPrimary} onClick={onClose}>Готово, сохранил</button>
      </div>
    </div>
  )
}

// ── client card ───────────────────────────────────────────────────────────────

interface ClientCardProps {
  client: ClientInfo
  token: string | null
  onChanged: () => void
  onCredentials: (c: ClientCredentials) => void
  onError: (msg: string) => void
}

function ClientCard({ client, token, onChanged, onCredentials, onError }: ClientCardProps) {
  const [expanded, setExpanded]   = useState(false)
  const [tracks, setTracks]       = useState<Record<Category, AdminTrack[]> | null>(null)
  const [uploadCat, setUploadCat] = useState<Category>('morning')
  const [progress, setProgress]   = useState<number | null>(null)
  const [dragOver, setDragOver]   = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

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

  const removeTrack = async (cat: Category, filename: string) => {
    if (!confirm(`Удалить «${filename}»?`)) return
    try {
      await deleteTrack(token, client.folderId, cat, filename)
      onChanged()
      await loadTracks()
    } catch (e) { onError(e instanceof Error ? e.message : String(e)) }
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

  const totalTracks = CATEGORIES.reduce((s, c) => s + (client.counts[c] ?? 0), 0)

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
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {client.username && <button style={btn} onClick={resetPassword}>Сбросить пароль</button>}
          <button style={btnDanger} onClick={remove}>Удалить</button>
        </div>
      </div>

      {/* stats */}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'rgba(255,255,255,0.55)', flexWrap: 'wrap' }}>
        {CATEGORIES.map(c => (
          <span key={c}>{CAT_LABEL[c]}: <b style={{ color: '#fff' }}>{client.counts[c] ?? 0}</b></span>
        ))}
        <span>Всего: <b style={{ color: '#fff' }}>{totalTracks}</b></span>
        <span>Размер: <b style={{ color: '#fff' }}>{fmtSize(client.sizeBytes)}</b></span>
      </div>

      {/* upload zone */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>Загрузить в:</span>
          {CATEGORIES.map(c => (
            <span key={c} style={chip(uploadCat === c)} onClick={() => setUploadCat(c)}>{CAT_LABEL[c]}</span>
          ))}
        </div>
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
            <>Перетащите mp3 сюда или нажмите (в «{CAT_LABEL[uploadCat]}», до 20MB на файл)</>
          )}
        </div>
        <input
          ref={fileInput} type="file" accept=".mp3,audio/mpeg" multiple style={{ display: 'none' }}
          onChange={e => { doUpload(Array.from(e.target.files ?? [])); e.target.value = '' }}
        />
      </div>

      {/* track list */}
      <button style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => setExpanded(v => !v)}>
        {expanded ? 'Скрыть треки' : `Треки (${totalTracks})`}
      </button>
      {expanded && tracks && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CATEGORIES.map(cat => (
            <div key={cat}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
                {CAT_LABEL[cat]} · {tracks[cat]?.length ?? 0}
              </div>
              {(tracks[cat] ?? []).map(t => (
                <div key={t.filename} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                  borderRadius: 8, background: 'rgba(255,255,255,0.03)', marginBottom: 4, fontSize: 13,
                }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.artist !== 'Unknown' ? `${t.artist} — ${t.title}` : t.title}
                  </span>
                  <button
                    style={{ ...btnDanger, padding: '4px 10px', fontSize: 12 }}
                    onClick={() => removeTrack(cat, t.filename)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!(tracks[cat]?.length) && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', padding: '2px 10px' }}>пусто</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── main panel ────────────────────────────────────────────────────────────────

export default function AdminPanel({ onBack }: { onBack: () => void }) {
  const { token, user: me, logout } = useAuth()
  const [clients, setClients] = useState<ClientInfo[]>([])
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoad]    = useState(true)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [creds, setCreds]     = useState<ClientCredentials | null>(null)
  const [pwChanged, setPwChanged] = useState(false)

  const reload = useCallback(async () => {
    try {
      setError(null)
      setClients(await listClients(token))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoad(false)
    }
  }, [token])

  useEffect(() => { reload() }, [reload])

  const addClient = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const c = await createClient(token, name)
      setNewName('')
      setCreds(c)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const changeOwnPassword = async () => {
    if (!me) return
    const pwd = prompt('Новый пароль администратора (мин. 8 символов):')
    if (!pwd) return
    if (pwd.length < 8) { setError('Пароль слишком короткий — минимум 8 символов'); return }
    try {
      await updateUser(token, me.username, { password: pwd })
      setPwChanged(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a0a0a', color: '#fff', overflowY: 'auto' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 24px 60px' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Клиенты</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
              1 клиент = 1 папка · вы вошли как {me?.username}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button style={btn} onClick={changeOwnPassword}>Мой пароль</button>
            <button style={btn} onClick={onBack}>← К плееру</button>
            <button style={btn} onClick={logout}>Выйти</button>
          </div>
        </div>

        {/* default-password warning */}
        {me?.weakPassword && !pwChanged && (
          <div style={{
            border: '1px solid rgba(255,179,71,0.4)', background: 'rgba(255,179,71,0.08)',
            color: '#ffb347', borderRadius: 12, padding: '12px 16px', marginBottom: 18, fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ flex: 1 }}>⚠ Вы используете пароль по умолчанию (admin/admin). Смените его немедленно.</span>
            <button style={{ ...btn, borderColor: 'rgba(255,179,71,0.5)', color: '#ffb347' }} onClick={changeOwnPassword}>
              Сменить пароль
            </button>
          </div>
        )}

        {error && (
          <div style={{ color: '#ff6b6b', fontSize: 13, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.4)' }}>Загрузка…</div>
        ) : (
          <>
            {/* create client */}
            <div style={{ ...card, marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>Создать клиента</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input
                  style={{ ...input, flex: 1, minWidth: 180 }} placeholder="название заведения"
                  value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addClient()}
                />
                <button style={btnPrimary} onClick={addClient} disabled={!newName.trim() || creating}>
                  {creating ? 'Создаю…' : 'Создать'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                Будут созданы папка с подпапками morning/day/evening, логин и случайный пароль.
              </div>
            </div>

            {/* client cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {clients.map(c => (
                <ClientCard
                  key={c.folderId} client={c} token={token}
                  onChanged={reload} onCredentials={setCreds} onError={setError}
                />
              ))}
              {!clients.length && (
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, textAlign: 'center', padding: 30 }}>
                  Клиентов пока нет — создайте первого выше.
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {creds && <CredentialsModal creds={creds} onClose={() => setCreds(null)} />}
    </div>
  )
}
