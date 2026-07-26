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

/** Cached bytes for a track URL, or null. Touches lastUsed (LRU). */
export async function getCached(url: string): Promise<ArrayBuffer | null> {
  const db = await openDb()
  if (!db) return null
  const key = cacheKey(url)
  const rec = await wrap<CacheRecord>(tx(db, 'readonly').get(key) as IDBRequest<CacheRecord>)
  if (!rec) return null
  // touch (fire-and-forget)
  try { tx(db, 'readwrite').put({ ...rec, lastUsed: Date.now() }) } catch { /* ignore */ }
  return rec.buf
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
export async function putCached(url: string, buf: ArrayBuffer): Promise<void> {
  const db = await openDb()
  if (!db) return
  const rec: CacheRecord = { url: cacheKey(url), buf, size: buf.byteLength, lastUsed: Date.now() }
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
 */
export async function fetchAndCache(url: string): Promise<boolean> {
  try {
    if (await isCached(url)) return true
    const r = await fetch(url)
    if (!r.ok) return false
    const buf = await r.arrayBuffer()
    await putCached(url, buf)
    return true
  } catch {
    return false
  }
}

/**
 * Background preloader: pull the next few tracks into the cache, one at a time so
 * we never compete with the currently-playing stream for bandwidth.
 */
export async function preload(urls: string[]): Promise<void> {
  // Deliberately sequential: a preload must never compete with the playing stream.
  for (const url of urls) await fetchAndCache(url)
}

/**
 * A URL the <audio> element can play: a blob: URL when the track is cached
 * (also sidesteps CORS entirely), otherwise the network URL.
 * `revoke` must be called once the element is done with it.
 */
export async function playableUrl(url: string): Promise<{ src: string; revoke: () => void }> {
  const buf = await getCached(url)
  if (!buf) return { src: url, revoke: () => {} }
  const blobUrl = URL.createObjectURL(new Blob([buf]))
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
