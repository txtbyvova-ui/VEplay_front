import { useState, useEffect, useCallback } from 'react'
import { API_BASE, authHeaders } from '../api'
import type { Category, User } from '../api'
import { useAuth } from '../auth/AuthContext'

interface CatInfo { id: Category; exists: boolean; count: number }

const CAT_LABEL: Record<string, string> = { morning: 'Morning', day: 'Day', evening: 'Evening' }

export default function AdminPanel({ onBack }: { onBack: () => void }) {
  const { token, user: me, logout } = useAuth()
  const [users, setUsers]   = useState<User[]>([])
  const [cats, setCats]     = useState<CatInfo[]>([])
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoad]  = useState(true)

  // new-user form
  const [nu, setNu] = useState('')
  const [np, setNp] = useState('')
  const [ncats, setNcats] = useState<Category[]>([])

  const api = useCallback(async (pathname: string, init?: RequestInit) => {
    const r = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(token), ...(init?.headers || {}) },
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.error || `Ошибка ${r.status}`)
    }
    return r.status === 204 ? null : r.json()
  }, [token])

  const reload = useCallback(async () => {
    try {
      setError(null)
      const [u, c] = await Promise.all([api('/admin/users'), api('/admin/categories')])
      setUsers(u)
      setCats(c)
      setLoad(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setLoad(false)
    }
  }, [api])

  useEffect(() => { reload() }, [reload])

  const allCats: Category[] = cats.length ? cats.map(c => c.id) : ['morning', 'day', 'evening']

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await reload() }
    catch (e) { setError(String(e instanceof Error ? e.message : e)) }
  }

  const toggleCat = (u: User, cat: Category) => {
    const next = u.categories.includes(cat)
      ? u.categories.filter(c => c !== cat)
      : [...u.categories, cat]
    run(() => api(`/admin/users/${encodeURIComponent(u.username)}`, {
      method: 'PUT', body: JSON.stringify({ categories: next }),
    }))
  }

  const resetPassword = (u: User) => {
    const pwd = prompt(`Новый пароль для «${u.username}»:`)
    if (pwd) run(() => api(`/admin/users/${encodeURIComponent(u.username)}`, {
      method: 'PUT', body: JSON.stringify({ password: pwd }),
    }))
  }

  const removeUser = (u: User) => {
    if (confirm(`Удалить пользователя «${u.username}»?`))
      run(() => api(`/admin/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }))
  }

  const addUser = () => {
    if (!nu.trim() || !np) return
    run(async () => {
      await api('/admin/users', { method: 'POST', body: JSON.stringify({ username: nu.trim(), password: np, categories: ncats, role: 'user' }) })
      setNu(''); setNp(''); setNcats([])
    })
  }

  // ── styles ──
  const card: React.CSSProperties = {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
  }
  const btn: React.CSSProperties = {
    padding: '8px 14px', fontSize: 13, borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.06)', color: '#eee', cursor: 'pointer',
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

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a0a0a', color: '#fff', overflowY: 'auto' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 24px 60px' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Админка</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
              Доступ пользователей к папкам · вы вошли как {me?.username}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={btn} onClick={onBack}>← К плееру</button>
            <button style={btn} onClick={logout}>Выйти</button>
          </div>
        </div>

        {error && <div style={{ color: '#ff6b6b', fontSize: 14, marginBottom: 16 }}>{error}</div>}
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.4)' }}>Загрузка…</div>
        ) : (
          <>
            {/* add user */}
            <div style={{ ...card, marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>Новый пользователь</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder="логин" value={nu}
                  onChange={e => setNu(e.target.value)} autoCapitalize="none" />
                <input style={{ ...input, flex: 1, minWidth: 140 }} placeholder="пароль" value={np}
                  onChange={e => setNp(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {allCats.map(c => (
                  <span key={c} style={chip(ncats.includes(c))}
                    onClick={() => setNcats(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c])}>
                    {CAT_LABEL[c] ?? c}
                  </span>
                ))}
                <button style={{ ...btn, marginLeft: 'auto', background: '#fff', color: '#0a0a0a', fontWeight: 700, border: 'none' }}
                  onClick={addUser} disabled={!nu.trim() || !np}>
                  Добавить
                </button>
              </div>
            </div>

            {/* user list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {users.map(u => (
                <div key={u.username} style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>{u.username}</span>
                    <span style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.08em',
                      background: u.role === 'admin' ? 'rgba(120,170,255,0.18)' : 'rgba(255,255,255,0.08)',
                      color: u.role === 'admin' ? '#9cc2ff' : 'rgba(255,255,255,0.55)',
                    }}>
                      {u.role}
                    </span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button style={btn} onClick={() => resetPassword(u)}>Пароль</button>
                      <button
                        style={{ ...btn, color: '#ff8080', borderColor: 'rgba(255,80,80,0.3)' }}
                        onClick={() => removeUser(u)}
                        disabled={u.username === me?.username}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {allCats.map(c => (
                      <span key={c} style={chip(u.categories.includes(c))} onClick={() => toggleCat(u, c)}>
                        {CAT_LABEL[c] ?? c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
