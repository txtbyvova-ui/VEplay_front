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
  singlePlaylist?: boolean
  weakPassword?: boolean
  // Per-client feature flags. Opt-out: the server normalises missing → true, so
  // an undefined value here (an old cached user) should also be read as allowed.
  allowFolderSelector?: boolean
  allowShuffle?: boolean
  /** Opt-IN, unlike the two above: the in-player track list is off unless enabled. */
  allowTrackList?: boolean
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
  singlePlaylist: boolean
  allowFolderSelector: boolean
  allowShuffle: boolean
  allowTrackList: boolean
  counts: Record<string, number>
  sizeBytes: number
}

export interface ClientCredentials {
  folderId: string
  name?: string
  username: string
  password: string   // shown ONCE — the server stores only the hash
  singlePlaylist?: boolean
}

export interface AdminTrack {
  filename: string
  title: string
  artist: string
  category: Category
  // scanFolder() attaches a playable src; used for the row preview player.
  src?: string
}

export interface UploadResult {
  accepted: { filename: string; category: string }[]
  rejected: { filename: string; reason: string }[]   // reason ∈ size | ext | name | write_error
}

// Human-readable text for the server's upload-rejection reason codes.
const UPLOAD_REJECT_TEXT: Record<string, string> = {
  size: 'больше 200 МБ',
  ext:  'неподдерживаемый формат',
  name: 'недопустимое имя файла',
  write_error: 'ошибка записи на диск',
}
export const uploadRejectText = (reason: string): string => UPLOAD_REJECT_TEXT[reason] ?? reason

// ── classify staging (admin) ─────────────────────────────────────────────────

export interface StagedTrack {
  filename: string
  title?: string
  artist?: string
  category: Category
  override: Category | null
  time_of_day?: Category
  mood?: string
  energy_score?: number
  tempo_bpm?: number
  librosa_ok?: boolean
}

export interface Batch {
  batchId: string
  folderId: string
  status: 'classifying' | 'ready' | 'error' | 'confirming'
  tracks: StagedTrack[]
  error?: string
  /** Set when the run finished but Gemini fell back — categories are not real classifications. */
  warning?: string | null
  uploaded?: number
  skipped?: string[]
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

export const createClient = (token: string | null, name: string, singlePlaylist = false) =>
  request<ClientCredentials>(token, '/admin/clients', { method: 'POST', body: JSON.stringify({ name, single_playlist: singlePlaylist }) })

export const deleteClient = (token: string | null, folderId: string) =>
  request<{ ok: true }>(token, `/admin/clients/${encodeURIComponent(folderId)}`, { method: 'DELETE' })

export const resetClientPassword = (token: string | null, folderId: string) =>
  request<ClientCredentials>(token, `/admin/clients/${encodeURIComponent(folderId)}/reset-password`, { method: 'POST' })

export const getClientTracks = (token: string | null, folderId: string) =>
  request<Record<string, AdminTrack[]>>(token, `/admin/clients/${encodeURIComponent(folderId)}/tracks`)

export const deleteTrack = (token: string | null, folderId: string, category: string, filename: string) =>
  request<{ ok: true }>(
    token,
    `/admin/clients/${encodeURIComponent(folderId)}/${category}/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  )

/** Fields `PUT /admin/users/:name` accepts. Omitted keys leave the stored value untouched. */
export interface UserPatch {
  password?: string
  allowFolderSelector?: boolean
  allowShuffle?: boolean
  allowTrackList?: boolean
}

export const updateUser = (token: string | null, username: string, patch: UserPatch) =>
  request<User>(token, `/admin/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(patch) })

/**
 * Multipart upload with progress — fetch can't report upload progress, so XHR.
 */
export function uploadTracks(
  token: string | null,
  folderId: string,
  category: string,
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

// ── classify helpers ──────────────────────────────────────────────────────────

/**
 * Upload a whole folder for classification. Multipart, file field name `tracks`
 * (matches the manual upload). XHR so we can report upload progress.
 */
export function classifyFolder(
  token: string | null,
  folderId: string,
  files: File[],
  onProgress?: (percent: number) => void,
): Promise<{ batchId: string; status: string; uploaded: number; skipped: string[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const f of files) form.append('tracks', f)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/admin/clients/${encodeURIComponent(folderId)}/classify`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as { batchId: string; status: string; uploaded: number; skipped: string[] })
        } else {
          reject(new Error(data.error || `Ошибка ${xhr.status}`))
        }
      } catch {
        reject(new Error(`Ошибка ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Сеть недоступна'))
    xhr.send(form)
  })
}

export const getBatch = (token: string | null, batchId: string) =>
  request<Batch>(token, `/admin/classify/${encodeURIComponent(batchId)}`)

export const retryBatch = (token: string | null, batchId: string) =>
  request<{ batchId: string; status: string }>(
    token, `/admin/classify/${encodeURIComponent(batchId)}`, { method: 'POST' })

export const setTrackCategory = (token: string | null, batchId: string, filename: string, category: Category) =>
  request<StagedTrack>(
    token, `/admin/classify/${encodeURIComponent(batchId)}/track/${encodeURIComponent(filename)}`,
    { method: 'PUT', body: JSON.stringify({ category }) })

export const confirmBatch = (token: string | null, batchId: string) =>
  request<{ ok: boolean; moved: { filename: string; category: string }[]; errors: { filename: string; error: string }[] }>(
    token, `/admin/classify/${encodeURIComponent(batchId)}/confirm`, { method: 'POST' })

export const cancelBatch = (token: string | null, batchId: string) =>
  request<{ ok: true }>(token, `/admin/classify/${encodeURIComponent(batchId)}`, { method: 'DELETE' })

export const moveTrack = (
  token: string | null,
  folderId: string,
  category: string,
  filename: string,
  toFolderId: string,
  toCategory: string,
) =>
  request<{ ok: true; filename: string; folderId: string; category: string }>(
    token,
    `/admin/clients/${encodeURIComponent(folderId)}/${encodeURIComponent(category)}/${encodeURIComponent(filename)}/move`,
    { method: 'POST', body: JSON.stringify({ toFolderId, toCategory }) })

/**
 * Preview URL for a still-staged track (audio streamed from `_incoming`). The
 * <audio> element can't send an Authorization header, so the token is a query param.
 */
export const stagedPreviewUrl = (batchId: string, filename: string, token: string | null): string =>
  `${API_BASE}/admin/classify/${batchId}/track/${encodeURIComponent(filename)}/audio?token=${encodeURIComponent(token ?? '')}`
