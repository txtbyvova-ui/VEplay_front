// Shared API config + auth helpers.

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

export type Category = 'morning' | 'day' | 'evening'

export interface User {
  username: string
  role: 'admin' | 'user'
  categories: Category[]
}

export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Normalise a track src to the configured API origin and attach the auth token
 * as a query param (the <audio> element can't send an Authorization header).
 */
export function resolveSrc(src: string, token: string | null): string {
  const fixed = src.replace(/^https?:\/\/[^/]+/, API_BASE)
  if (!token) return fixed
  return fixed + (fixed.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}
