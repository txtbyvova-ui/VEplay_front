import { useState, useEffect } from 'react'
import type { Track } from './usePlayer'

export interface Library {
  morning: Track[]
  day:     Track[]
  evening: Track[]
}

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

export function useLibrary() {
  const [library, setLibrary]   = useState<Library>({ morning: [], day: [], evening: [] })
  const [loading, setLoading]   = useState(true)
  const [error,   setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/library`)
      .then(r => { if (!r.ok) throw new Error(`Server ${r.status}`); return r.json() })
      .then((data: Library) => { setLibrary(data); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  return { library, loading, error }
}
