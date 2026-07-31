import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { API_BASE, authHeaders } from '../api'
import type { User } from '../api'

interface AuthState {
  user:    User | null
  token:   string | null
  loading: boolean
  error:   string | null
  login:   (username: string, password: string) => Promise<boolean>
  logout:  () => void
}

const TOKEN_KEY = 'veplay_token'
/** Последний подтверждённый сервером профиль — чтобы пережить старт без сети. */
const USER_KEY  = 'veplay_user'
/** Пауза между повторными попытками валидации, пока связи нет. */
const REVALIDATE_MS = 15_000
const AuthCtx = createContext<AuthState | null>(null)

const readCachedUser = (): User | null => {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch { return null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken]     = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Validate any stored token once on mount.
  //
  // КЛЮЧЕВОЕ: сессия сбрасывается ТОЛЬКО когда сервер прямо сказал 401. Раньше
  // один `.catch` ловил всё подряд — и настоящий 401, и реджект fetch при
  // поднимающемся Wi-Fi, и 502/503 от Caddy во время нашего же deploy.sh — и
  // безусловно стирал токен. Пароль клиента выдаётся ОДИН раз и хранится хешем,
  // так что после такого сбоя войти уже нечем: зал остаётся без музыки до
  // приезда админа. Поэтому при сетевой ошибке профиль поднимается из кэша, а
  // валидация повторяется в фоне.
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- no stored token → done loading
    if (!stored) { setLoading(false); return }
    let cancelled = false
    let retry: number | null = null

    const accept = (u: User) => {
      try { localStorage.setItem(USER_KEY, JSON.stringify(u)) } catch { /* private mode */ }
      setUser(u)
      setToken(stored)
      setLoading(false)
    }

    const validate = () => {
      fetch(`${API_BASE}/auth/me`, { headers: authHeaders(stored) })
        .then(r => (r.ok
          ? r.json()
          : Promise.reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }))))
        .then((data: { user: User }) => { if (!cancelled) accept(data.user) })
        .catch((e: { status?: number }) => {
          if (cancelled) return
          if (e?.status === 401) {
            // Сервер отверг токен — это единственный случай, когда сессию можно рвать.
            localStorage.removeItem(TOKEN_KEY)
            localStorage.removeItem(USER_KEY)
            setToken(null)
            setUser(null)
            setLoading(false)
            return
          }
          // Сеть, 502/503, что угодно ещё — токен НЕ трогаем. Поднимаем последний
          // known-good профиль, чтобы плеер запустился, и пробуем снова.
          const cached = readCachedUser()
          if (cached) { setUser(cached); setToken(stored) }
          setLoading(false)
          retry = window.setTimeout(validate, REVALIDATE_MS)
        })
    }

    validate()
    // Вернулась сеть — не ждём следующего тика ретрая.
    const onOnline = () => { if (retry !== null) { window.clearTimeout(retry); retry = null } validate() }
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      if (retry !== null) window.clearTimeout(retry)
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setError(null)
    try {
      const r = await fetch(`${API_BASE}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        setError(e.error || 'Не удалось войти')
        return false
      }
      const data = (await r.json()) as { token: string; user: User }
      localStorage.setItem(TOKEN_KEY, data.token)
      // Профиль тоже кладём: с него поднимется сессия, если следующий старт
      // страницы случится раньше, чем поднимется сеть.
      try { localStorage.setItem(USER_KEY, JSON.stringify(data.user)) } catch { /* private mode */ }
      setUser(data.user)
      setToken(data.token)
      return true
    } catch {
      setError('Сервер недоступен')
      return false
    }
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setToken(null)
    setUser(null)
  }, [])

  return (
    <AuthCtx.Provider value={{ user, token, loading, error, login, logout }}>
      {children}
    </AuthCtx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
