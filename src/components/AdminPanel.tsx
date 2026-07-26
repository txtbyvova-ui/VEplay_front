import { useState } from 'react'
import type { ClientCredentials } from '../api'
import { updateUser } from '../api'
import { useAuth } from '../auth/AuthContext'
import { btn } from './adminStyles'
import { useAdminClients } from '../hooks/useAdminClients'
import CredentialsModal from './admin/CredentialsModal'
import CreateClientCard from './admin/CreateClientCard'
import ClientCard from './admin/ClientCard'

export default function AdminPanel({ onBack }: { onBack: () => void }) {
  const { token, user: me, logout } = useAuth()
  const { clients, error, setError, loading, reload } = useAdminClients(token)
  const [creds, setCreds]         = useState<ClientCredentials | null>(null)
  const [pwChanged, setPwChanged] = useState(false)

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

  const handleCreated = async (c: ClientCredentials) => {
    setCreds(c)
    await reload()
  }

  return (
    <div style={{ width: '100vw', height: '100dvh', background: '#0a0a0a', color: '#fff', overflowY: 'auto' }}>
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
            <CreateClientCard token={token} onCreated={handleCreated} onError={setError} />

            {/* client cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {clients.map(c => (
                <ClientCard
                  key={c.folderId} client={c} allClients={clients} token={token}
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
