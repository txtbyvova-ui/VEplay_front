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

  const isAdmin = user.role === 'admin'
  const showAdmin = view === 'admin' && isAdmin

  // Плеер НИКОГДА не размонтируется при открытии админки — он прячется.
  //
  // Раньше AdminPanel рендерилась ВМЕСТО PlayerScreen: usePlayer размонтировался,
  // cleanup ставил оба <audio> на паузу, и музыка в зале обрывалась ровно в тот
  // момент, когда админ шёл заливать треки. Классификация папки, по тексту самого
  // UI, «может занять несколько минут» — всё это время была тишина. Вторым
  // эффектом каждое такое размонтирование добавляло в граф пару неотцепленных нод
  // (замерено: +2 MediaElementSource за заход).
  //
  // display:none звук не глушит — элементы создаются программно и к DOM не
  // привязаны, а CSS-анимация винила в скрытом поддереве просто не тратит кадры.
  return (
    <>
      <div style={{ display: showAdmin ? 'none' : 'contents' }}>
        <PlayerScreen onOpenAdmin={isAdmin ? () => setView('admin') : undefined} />
      </div>
      {showAdmin && <AdminPanel onBack={() => setView('player')} />}
    </>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
