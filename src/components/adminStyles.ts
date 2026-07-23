// Shared dark-glass style tokens for the admin UI (AdminPanel + ClassifyBatch).
// Extracted so both files render an identical look without duplicating values.

import type { Category } from '../api'

export const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
}
export const btn: React.CSSProperties = {
  padding: '8px 14px', fontSize: 13, borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)', color: '#eee', cursor: 'pointer',
}
export const btnPrimary: React.CSSProperties = {
  ...btn, background: '#fff', color: '#0a0a0a', fontWeight: 700, border: 'none',
}
export const btnDanger: React.CSSProperties = {
  ...btn, color: '#ff8080', borderColor: 'rgba(255,80,80,0.3)',
}
export const input: React.CSSProperties = {
  padding: '10px 12px', fontSize: 14, background: 'rgba(255,255,255,0.05)', color: '#fff',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, outline: 'none',
}
export const chip = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer', userSelect: 'none',
  border: on ? '1.5px solid rgba(255,255,255,0.55)' : '1.5px solid rgba(255,255,255,0.1)',
  background: on ? 'rgba(255,255,255,0.16)' : 'transparent',
  color: on ? '#fff' : 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em',
})
export const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' }

export const CAT_LABEL: Record<Category, string> = { morning: 'Morning', day: 'Day', evening: 'Evening' }
// 'all' is the single-playlist folder (Mode B); the others are the time-of-day folders (Mode A).
export const catLabel = (c: string) => (c === 'all' ? 'Плейлист' : CAT_LABEL[c as Category] ?? c)
