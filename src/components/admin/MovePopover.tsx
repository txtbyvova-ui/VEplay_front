import type { ClientInfo } from '../../api'
import { CATEGORIES } from '../../api'
import { input, btn, btnPrimary, catLabel } from '../adminStyles'

// ── inline "move" popover — target client + category selectors ───────────────
// Rendered only for the currently-open row (so only that row re-renders when the
// target selectors change).

interface MovePopoverProps {
  cat: string
  filename: string
  allClients: ClientInfo[]
  currentFolderId: string
  moveTo: string
  moveCat: string
  onChangeTarget: (folderId: string) => void
  onChangeCategory: (category: string) => void
  onMove: (cat: string, filename: string) => void
  onCancel: () => void
}

export default function MovePopover({
  cat, filename, allClients, currentFolderId, moveTo, moveCat,
  onChangeTarget, onChangeCategory, onMove, onCancel,
}: MovePopoverProps) {
  const moveTargetCats = allClients.find(c => c.folderId === moveTo)?.singlePlaylist ? ['all'] : CATEGORIES

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px' }}>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>Куда:</span>
      <select
        style={{ ...input, padding: '6px 8px', fontSize: 12 }}
        value={moveTo}
        onChange={e => onChangeTarget(e.target.value)}
      >
        {allClients.map(c => (
          <option key={c.folderId} value={c.folderId}>
            {c.name}{c.folderId === currentFolderId ? ' (эта папка)' : ''}
          </option>
        ))}
      </select>
      <select
        style={{ ...input, padding: '6px 8px', fontSize: 12 }}
        value={moveCat}
        onChange={e => onChangeCategory(e.target.value)}
      >
        {moveTargetCats.map(c => (
          <option key={c} value={c}>{catLabel(c)}</option>
        ))}
      </select>
      <button style={{ ...btnPrimary, padding: '6px 12px', fontSize: 12 }} onClick={() => onMove(cat, filename)}>
        Перенести
      </button>
      <button style={{ ...btn, padding: '6px 12px', fontSize: 12 }} onClick={onCancel}>
        Отмена
      </button>
    </div>
  )
}
