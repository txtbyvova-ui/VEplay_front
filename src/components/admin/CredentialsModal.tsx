import { useState } from 'react'
import type { ClientCredentials } from '../../api'
import { card, btn, btnPrimary, mono } from '../adminStyles'

// ── credentials modal (password is shown exactly once) ───────────────────────

export default function CredentialsModal({ creds, onClose }: { creds: ClientCredentials; onClose: () => void }) {
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
