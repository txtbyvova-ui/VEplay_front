import { useState, useEffect } from 'react'
import type { Track } from './usePlayer'
import { API_BASE, authHeaders, resolveSrc } from '../api'
import { useAuth } from '../auth/AuthContext'

// Keys are category names: 'morning'|'day'|'evening' (Mode A) or 'all' (Mode B single playlist).
export type Library = Partial<Record<string, Track[]>>

export function useLibrary() {
  const { token } = useAuth()
  const [library, setLibrary] = useState<Library>({})
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading when signed out
    if (!token) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    fetch(`${API_BASE}/library`, { headers: authHeaders(token) })
      .then(r => { if (!r.ok) throw new Error(`Server ${r.status}`); return r.json() })
      .then((data: Record<string, Track[]>) => {
        if (cancelled) return
        const fixed: Library = {}
        for (const cat of Object.keys(data)) {
          fixed[cat] = data[cat].map(t => ({ ...t, src: resolveSrc(t.src, token) }))
        }
        setLibrary(fixed)
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [token])

  return { library, loading, error }
}
