import { useState, useEffect, useCallback } from 'react'
import type { ClientInfo } from '../api'
import { listClients } from '../api'

// Loads the admin client list and exposes a stable `reload`. Shared error state
// lives here too, so cards / the create form can surface failures through one banner.
export function useAdminClients(token: string | null) {
  const [clients, setClients] = useState<ClientInfo[]>([])
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setError(null)
      setClients(await listClients(token))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { reload() }, [reload])

  return { clients, error, setError, loading, reload }
}
