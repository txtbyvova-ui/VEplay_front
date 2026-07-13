// Shared API config + auth helpers.

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

export type Category = 'morning' | 'day' | 'evening'

export const CATEGORIES: Category[] = ['morning', 'day', 'evening']

export interface User {
  username: string
  role: 'admin' | 'user'
  categories: Category[]
  folderId: string | null
  name: string | null
  weakPassword?: boolean
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

// ── clients (admin) ──────────────────────────────────────────────────────────

export interface ClientInfo {
  folderId: string
  name: string
  username: string | null
  counts: Record<Category, number>
  sizeBytes: number
}

export interface ClientCredentials {
  folderId: string
  name?: string
  username: string
  password: string   // shown ONCE — the server stores only the hash
}

export interface AdminTrack {
  filename: string
  title: string
  artist: string
  category: Category
}

export interface UploadResult {
  uploaded: { filename: string; category: Category }[]
  rejected: { filename: string; reason: string }[]
}

async function request<T>(token: string | null, pathname: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(token), ...(init?.headers || {}) },
  })
  if (!r.ok) {
    const e = await r.json().catch(() => ({} as { error?: string }))
    throw new Error(e.error || `Ошибка ${r.status}`)
  }
  return (r.status === 204 ? null : r.json()) as Promise<T>
}

export const listClients = (token: string | null) =>
  request<ClientInfo[]>(token, '/admin/clients')

export const createClient = (token: string | null, name: string) =>
  request<ClientCredentials>(token, '/admin/clients', { method: 'POST', body: JSON.stringify({ name }) })

export const deleteClient = (token: string | null, folderId: string) =>
  request<{ ok: true }>(token, `/admin/clients/${encodeURIComponent(folderId)}`, { method: 'DELETE' })

export const resetClientPassword = (token: string | null, folderId: string) =>
  request<ClientCredentials>(token, `/admin/clients/${encodeURIComponent(folderId)}/reset-password`, { method: 'POST' })

export const getClientTracks = (token: string | null, folderId: string) =>
  request<Record<Category, AdminTrack[]>>(token, `/admin/clients/${encodeURIComponent(folderId)}/tracks`)

export const deleteTrack = (token: string | null, folderId: string, category: Category, filename: string) =>
  request<{ ok: true }>(
    token,
    `/admin/clients/${encodeURIComponent(folderId)}/${category}/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  )

export const updateUser = (token: string | null, username: string, patch: { password?: string }) =>
  request<User>(token, `/admin/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(patch) })

/**
 * Multipart upload with progress — fetch can't report upload progress, so XHR.
 */
export function uploadTracks(
  token: string | null,
  folderId: string,
  category: Category,
  files: File[],
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const f of files) form.append('tracks', f)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/admin/clients/${encodeURIComponent(folderId)}/upload?category=${category}`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadResult)
        else reject(new Error(data.error || `Ошибка ${xhr.status}`))
      } catch {
        reject(new Error(`Ошибка ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Сеть недоступна'))
    xhr.send(form)
  })
}
