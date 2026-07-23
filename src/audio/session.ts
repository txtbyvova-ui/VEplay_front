/**
 * session.ts — remember what was playing and where.
 *
 * Refreshing the page or backgrounding Safari must NOT restart the playlist from
 * the top. We persist {category, filename, position} and restore it on mount.
 *
 * Identity is the FILENAME, not the track id: ids are index-based
 * (`${folderId}-${category}-${i}`) and shift whenever the library changes.
 */

const KEY = 'veplay_session_v1'
/** Older than this and we start fresh — a venue reopening next day wants the schedule. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface SavedSession {
  username: string
  category: string
  filename: string
  position: number
  shuffle: boolean
  updatedAt: number
}

export function saveSession(s: Omit<SavedSession, 'updatedAt'>): void {
  try {
    const payload: SavedSession = { ...s, updatedAt: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch { /* private mode / quota — resume is a nice-to-have, never fatal */ }
}

/** The saved session for this user, or null when absent / stale / another user's. */
export function loadSession(username: string | undefined): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as SavedSession
    if (!s || typeof s.filename !== 'string') return null
    if (username && s.username && s.username !== username) return null
    if (!s.updatedAt || Date.now() - s.updatedAt > MAX_AGE_MS) return null
    return s
  } catch {
    return null
  }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
