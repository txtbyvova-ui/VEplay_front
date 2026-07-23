/**
 * mediaSession.ts — lock-screen / notification transport controls.
 *
 * Without action handlers the OS shows the controls but the next/prev buttons do
 * nothing once the screen is locked. Registering them here makes them drive the
 * same functions as the in-page buttons.
 */

export interface MediaHandlers {
  play: () => void
  pause: () => void
  next: () => void
  prev: () => void
}

const supported = (): boolean => typeof navigator !== 'undefined' && 'mediaSession' in navigator

export function setHandlers(h: MediaHandlers): void {
  if (!supported()) return
  const ms = navigator.mediaSession
  const set = (action: MediaSessionAction, fn: (() => void) | null) => {
    try { ms.setActionHandler(action, fn) } catch { /* action unsupported on this browser */ }
  }
  set('play',          () => h.play())
  set('pause',         () => h.pause())
  set('nexttrack',     () => h.next())
  set('previoustrack', () => h.prev())
  // Stop is mapped to pause: a venue player should never fully tear down.
  set('stop',          () => h.pause())
}

export function clearHandlers(): void {
  if (!supported()) return
  for (const a of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop'] as MediaSessionAction[]) {
    try { navigator.mediaSession.setActionHandler(a, null) } catch { /* ignore */ }
  }
}

/** Title/artist on the lock screen. Artwork is intentionally omitted (no covers). */
export function setMetadata(track: { title?: string; artist?: string } | null): void {
  if (!supported() || typeof MediaMetadata === 'undefined') return
  try {
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({ title: track.title ?? '', artist: track.artist ?? '', album: 'VEgroove' })
      : null
  } catch { /* ignore */ }
}

export function setPlaybackState(playing: boolean): void {
  if (!supported()) return
  try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused' } catch { /* ignore */ }
}

/** Keeps the OS scrubber in sync (harmless where unsupported). */
export function setPositionState(duration: number, position: number): void {
  if (!supported()) return
  const ms = navigator.mediaSession
  if (typeof ms.setPositionState !== 'function') return
  if (!isFinite(duration) || duration <= 0 || position < 0 || position > duration) return
  try { ms.setPositionState({ duration, position, playbackRate: 1 }) } catch { /* ignore */ }
}
