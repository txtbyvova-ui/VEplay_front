import { useState } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './components/Login'
import PlayerScreen from './components/PlayerScreen'
import AdminPanel from './components/AdminPanel'

function Splash() {
  return (
    <div style={{
      width: '100vw', height: '100dvh', background: '#0a0a0a',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.3)', fontSize: 13, letterSpacing: '0.3em', textTransform: 'uppercase',
    }}>
      VEgroove
    </div>
  )
}

function Shell() {
  const { user, loading } = useAuth()
  const [view, setView] = useState<'player' | 'admin'>('player')

  if (loading) return <Splash />
  if (!user)   return <Login />
  if (view === 'admin' && user.role === 'admin') return <AdminPanel onBack={() => setView('player')} />

  return <PlayerScreen onOpenAdmin={user.role === 'admin' ? () => setView('admin') : undefined} />
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
