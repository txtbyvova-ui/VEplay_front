import { memo } from 'react'
import type { AdminTrack } from '../../api'
import { btn, btnDanger } from '../adminStyles'

// ── one track row in a client's list, memoized ──────────────────────────────
// Re-renders only when its own track / isPlaying / moveOpen / popover change, so
// frequent parent updates (folder-upload progress, previewing another row) don't
// re-render the whole list. Requires the parent to pass stable callbacks.

interface ClientTrackRowProps {
  cat: string
  track: AdminTrack
  isPlaying: boolean
  moveOpen: boolean
  movePopover: React.ReactNode
  onPreview: (cat: string, track: AdminTrack) => void
  onRemove: (cat: string, filename: string) => void
  onToggleMove: (key: string) => void
}

const ClientTrackRow = memo(function ClientTrackRow(
  { cat, track, isPlaying, moveOpen, movePopover, onPreview, onRemove, onToggleMove }: ClientTrackRowProps,
) {
  const key = `${cat}/${track.filename}`
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderRadius: 8, background: 'rgba(255,255,255,0.03)', fontSize: 13,
      }}>
        <button style={{ ...btn, padding: '4px 8px', fontSize: 13 }} onClick={() => onPreview(cat, track)}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {track.artist !== 'Unknown' ? `${track.artist} — ${track.title}` : track.title}
        </span>
        <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} onClick={() => onToggleMove(key)}>
          переместить
        </button>
        <button style={{ ...btnDanger, padding: '4px 10px', fontSize: 12 }} onClick={() => onRemove(cat, track.filename)}>
          ✕
        </button>
      </div>
      {moveOpen && movePopover}
    </div>
  )
})

export default ClientTrackRow
