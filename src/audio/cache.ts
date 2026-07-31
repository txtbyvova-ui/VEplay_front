/**
 * cache.ts — offline audio cache (IndexedDB) + background preloader.
 *
 * Stores the COMPRESSED bytes (ArrayBuffer of the mp3/…) — never decoded PCM.
 * Playback happens through `<audio>` + a blob: URL, so a cached track costs the
 * same RAM as a streamed one. (Decoding to AudioBuffer would be ~30-50 MB per
 * track and would blow up an iPad after a handful of songs.)
 *
 * Cache key = the track URL WITHOUT its query string: `/music/...` carries a
 * `?token=` that changes on every login, and keying on it would miss every time.
 */

const DB_NAME  = 'vegrooveDB'
const STORE    = 'audioCache'
const DB_VER   = 1
const MAX_ENTRIES = 50          // LRU ceiling — keeps us well clear of QuotaExceededError

export interface CacheRecord {
  url: string          // key: origin+pathname (no query)
  buf: ArrayBuffer
  size: number
  lastUsed: number
  /** Content-Type ответа. Пустой у записей, сделанных до появления поля. */
  mime?: string
}

/**
 * Запасной MIME по расширению — зеркало таблицы в server/config.mjs.
 *
 * Blob без типа отдаётся элементу вообще без Content-Type: Chromium в этом
 * случае снифферит контейнер и играет, а WebKit у `blob:` не имеет ни типа, ни
 * расширения, по которым выбрать декодер. Хардкодить 'audio/mpeg' нельзя —
 * сервер принимает семь форматов, и WAV, помеченный как mp3, сломается вернее,
 * чем WAV без пометки.
 */
const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
}

export function mimeByExt(url: string): string {
  const path = (() => { try { return new URL(url, location.href).pathname } catch { return url } })()
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? ''
}

/** Strip the query (auth token) so a track keeps one stable cache key. */
export function cacheKey(url: string): string {
  try { const u = new URL(url, location.href); return u.origin + u.pathname } catch { return url }
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null)   // private mode / unsupported
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB_NAME, DB_VER) } catch { return resolve(null) }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'url' })
        store.createIndex('lastUsed', 'lastUsed')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => resolve(null)
  })
  return dbPromise
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE)
}

const wrap = <T>(req: IDBRequest<T>): Promise<T | null> =>
  new Promise(resolve => { req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null) })

/** Cached record for a track URL, or null. Touches lastUsed (LRU). */
export async function getCached(url: string): Promise<CacheRecord | null> {
  const db = await openDb()
  if (!db) return null
  const key = cacheKey(url)
  const rec = await wrap<CacheRecord>(tx(db, 'readonly').get(key) as IDBRequest<CacheRecord>)
  if (!rec) return null
  // touch (fire-and-forget)
  try { tx(db, 'readwrite').put({ ...rec, lastUsed: Date.now() }) } catch { /* ignore */ }
  return rec
}

/**
 * Выбросить запись из кэша.
 *
 * Нужно, когда элемент отверг источник: байты могли докачаться битыми, и без
 * этого плеер будет спотыкаться об них на каждом круге плейлиста.
 */
export async function drop(url: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try { tx(db, 'readwrite').delete(cacheKey(url)) } catch { /* ignore */ }
}

export async function isCached(url: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  const rec = await wrap<CacheRecord>(tx(db, 'readonly').get(cacheKey(url)) as IDBRequest<CacheRecord>)
  return !!rec
}

/** Drop least-recently-used records until at most MAX_ENTRIES remain. */
export async function evictLRU(max = MAX_ENTRIES): Promise<void> {
  const db = await openDb()
  if (!db) return
  const store = tx(db, 'readwrite')
  const count = await wrap<number>(store.count() as IDBRequest<number>)
  if (count === null || count <= max) return
  let toDrop = count - max
  await new Promise<void>(resolve => {
    // lastUsed index, ascending → oldest first
    const cursorReq = store.index('lastUsed').openCursor()
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result
      if (!cur || toDrop <= 0) return resolve()
      cur.delete()
      toDrop--
      cur.continue()
    }
    cursorReq.onerror = () => resolve()
  })
}

/** Store bytes. Quota-safe: on QuotaExceededError, evict hard and retry once. */
export async function putCached(url: string, buf: ArrayBuffer, mime = ''): Promise<void> {
  const db = await openDb()
  if (!db) return
  const rec: CacheRecord = { url: cacheKey(url), buf, size: buf.byteLength, lastUsed: Date.now(), mime: mime || mimeByExt(url) }
  const write = () => new Promise<boolean>(resolve => {
    try {
      const req = tx(db, 'readwrite').put(rec)
      req.onsuccess = () => resolve(true)
      req.onerror   = () => resolve(false)
    } catch { resolve(false) }
  })
  if (await write()) { await evictLRU(); return }
  // Probably out of quota — free half the cache and try again once.
  await evictLRU(Math.floor(MAX_ENTRIES / 2))
  await write()
}

/**
 * Fetch a track and cache it. Returns true when the bytes ended up in the cache.
 * Never throws — a failed preload must never disturb playback.
 *
 * `signal` aborts BOTH the request and the body download: `r.arrayBuffer()` pulls
 * the whole track into memory, and that is the expensive half.
 */
export async function fetchAndCache(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (signal?.aborted) return false
    if (await isCached(url)) return true
    const r = await fetch(url, { signal })
    if (!r.ok) return false
    // Заголовок надо снять ДО чтения тела — потом ответ уже израсходован.
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim()
    const buf = await r.arrayBuffer()
    // Aborted while the body was streaming in: drop the bytes instead of paying
    // for an IndexedDB write (and an evictLRU pass) nobody is waiting for.
    if (signal?.aborted) return false
    await putCached(url, buf, mime)
    return true
  } catch {
    return false   // AbortError lands here too — a cancelled preload is not an error
  }
}

/** In-flight preload run, so a newer one can cancel it. */
let preloadAbort: AbortController | null = null

/**
 * Abort whatever the preloader is currently downloading.
 *
 * Skipping a track makes every byte still in flight useless: without this, a
 * burst of Next taps left one full-file download per tap racing the track the
 * user actually wants, each holding an ArrayBuffer of the whole file.
 */
export function cancelPreload(): void {
  preloadAbort?.abort()
  preloadAbort = null
}

/**
 * Background preloader: pull the next few tracks into the cache, one at a time so
 * we never compete with the currently-playing stream for bandwidth.
 *
 * Starting a new run cancels the previous one — only the newest queue matters.
 */
export async function preload(urls: string[]): Promise<void> {
  cancelPreload()
  const ac = new AbortController()
  preloadAbort = ac
  // Deliberately sequential: a preload must never compete with the playing stream.
  for (const url of urls) {
    if (ac.signal.aborted) return
    await fetchAndCache(url, ac.signal)
  }
  if (preloadAbort === ac) preloadAbort = null
}

/**
 * A URL the <audio> element can play: a blob: URL when the track is cached
 * (also sidesteps CORS entirely), otherwise the network URL.
 * `revoke` must be called once the element is done with it.
 */
export async function playableUrl(url: string): Promise<{ src: string; revoke: () => void }> {
  const rec = await getCached(url)
  if (!rec) return { src: url, revoke: () => {} }
  // Тип ОБЯЗАТЕЛЕН: по сети сервер отдаёт Content-Type, и blob без него — это
  // регресс относительно сетевого пути (см. MIME_BY_EXT выше).
  const type = rec.mime || mimeByExt(url)
  const blobUrl = URL.createObjectURL(type ? new Blob([rec.buf], { type }) : new Blob([rec.buf]))
  return { src: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) }
}

/** Diagnostics: how many tracks and how many bytes are cached. */
export async function stats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb()
  if (!db) return { count: 0, bytes: 0 }
  const all = await wrap<CacheRecord[]>(tx(db, 'readonly').getAll() as IDBRequest<CacheRecord[]>)
  const list = all ?? []
  return { count: list.length, bytes: list.reduce((s, r) => s + (r.size || 0), 0) }
}
