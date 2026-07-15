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
const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken]     = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Validate any stored token once on mount.
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- no stored token → done loading
    if (!stored) { setLoading(false); return }
    let cancelled = false
    fetch(`${API_BASE}/auth/me`, { headers: authHeaders(stored) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('unauthorized'))))
      .then((data: { user: User }) => {
        if (cancelled) return
        setUser(data.user)
        setToken(stored)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setUser(null)
        setLoading(false)
      })
    return () => { cancelled = true }
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
