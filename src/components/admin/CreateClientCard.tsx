import { useState } from 'react'
import type { ClientCredentials } from '../../api'
import { createClient } from '../../api'
import { card, btnPrimary, input } from '../adminStyles'

interface CreateClientCardProps {
  token: string | null
  onCreated: (creds: ClientCredentials) => void | Promise<void>
  onError: (msg: string) => void
}

export default function CreateClientCard({ token, onCreated, onError }: CreateClientCardProps) {
  const [newName, setNewName]     = useState('')
  const [newSingle, setNewSingle] = useState(false)
  const [creating, setCreating]   = useState(false)

  const addClient = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const c = await createClient(token, name, newSingle)
      setNewName('')
      setNewSingle(false)
      await onCreated(c)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
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
      {/* Playback mode: A = time-of-day schedule (default), B = single all-day playlist */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <input type="radio" name="mode" checked={!newSingle} onChange={() => setNewSingle(false)} />
          <span>По времени суток <span style={{ color: 'rgba(255,255,255,0.4)' }}>(morning / day / evening)</span></span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <input type="radio" name="mode" checked={newSingle} onChange={() => setNewSingle(true)} />
          <span>Единый плейлист <span style={{ color: 'rgba(255,255,255,0.4)' }}>(одна папка, весь день)</span></span>
        </label>
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
        {newSingle
          ? 'Будет создана папка с подпапкой all, логин и случайный пароль. Плеер играет всё из неё по кругу без привязки ко времени.'
          : 'Будут созданы папка с подпапками morning/day/evening, логин и случайный пароль.'}
      </div>
    </div>
  )
}
