import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'

export default function Login() {
  const { login, error } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy]         = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    await login(username.trim(), password)
    setBusy(false)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '14px 16px', fontSize: 15,
    background: 'rgba(255,255,255,0.05)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12,
    outline: 'none', WebkitTapHighlightColor: 'transparent',
  }

  return (
    <div style={{
      width: '100vw', height: '100dvh', background: '#0a0a0a',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <form
        onSubmit={onSubmit}
        style={{
          width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14,
          background: 'linear-gradient(135deg, #141414 0%, #0d0d0d 100%)',
          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 22, padding: 32,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', letterSpacing: '0.04em' }}>VEgroove</div>
          <div style={{ fontSize: 12, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.32)', marginTop: 4 }}>
            Play
          </div>
        </div>

        <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.08em' }}>
          Логин
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoCapitalize="none" autoCorrect="off" autoComplete="username"
          />
        </label>

        <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.08em' }}>
          Пароль
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && (
          <div style={{ fontSize: 13, color: '#ff6b6b', textAlign: 'center' }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          style={{
            marginTop: 6, padding: '14px', fontSize: 15, fontWeight: 700,
            borderRadius: 12, border: 'none', cursor: busy ? 'default' : 'pointer',
            background: busy || !username || !password ? 'rgba(255,255,255,0.3)' : '#fff',
            color: '#0a0a0a', transition: 'background 150ms',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
