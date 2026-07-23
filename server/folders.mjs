// @ts-check
/**
 * folders.mjs — multi-tenant folder layout (1 client = 1 folder) and track scanning.
 *
 *   MUSIC_ROOT/<folderId>/{morning,day,evening}/*.mp3
 *
 * Functions that need the users store take it as a callback parameter — this
 * module never imports users (keeps the dependency graph acyclic).
 */
import fs     from 'node:fs'
import path   from 'node:path'
import crypto from 'node:crypto'
import {
  MUSIC_ROOT, PORT, CATEGORIES, ALL_CATEGORY, VALID_CATEGORIES, AUDIO_EXTS,
} from './config.mjs'

/**
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} filename
 * @property {string} title
 * @property {string} artist
 * @property {string} category
 * @property {string} folderId
 * @property {string} src
 */

// decodeURIComponent throws URIError on malformed %-escapes (e.g. "%zz").
// Return null instead so a bad URL becomes a 400/404, not a process crash.
/**
 * @param {unknown} s
 * @returns {string | null}
 */
export function safeDecode(s) {
  try { return decodeURIComponent(String(s)) } catch { return null }
}

// One path segment from user input: basename + reject '', '.' and '..'
// (path.basename('..') === '..', so basename alone does NOT stop traversal)
/**
 * @param {unknown} s
 * @returns {string | null}
 */
export function safeSegment(s) {
  const b = path.basename(String(s ?? ''))
  return b === '' || b === '.' || b === '..' ? null : b
}

// Resolve a client folder path strictly under MUSIC_ROOT
/**
 * @param {unknown} folderId
 * @returns {string}
 */
export function folderPath(folderId) {
  return path.join(MUSIC_ROOT, safeSegment(folderId) ?? ' ')
}

/** @returns {string[]} */
export function listFolderIds() {
  try {
    return fs.readdirSync(MUSIC_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      // Names starting with '_' are reserved internals (e.g. _incoming staging),
      // never client folders — keep them out of every folder listing / scan.
      .filter(name => !name.startsWith('_'))
      .sort()
  } catch {
    return []
  }
}

// A valid client folder: a real segment, NOT a reserved internal name (leading
// '_', e.g. _incoming staging), and present on disk. The reserved-name guard
// mirrors listFolderIds() so every mutating route (classify / move / delete /
// upload) refuses to treat _incoming as a client folder.
/**
 * @param {unknown} folderId
 * @returns {boolean}
 */
export const folderExists = (folderId) => {
  const seg = safeSegment(folderId)
  return !!seg && !seg.startsWith('_') && fs.existsSync(folderPath(folderId))
}

// Cyrillic → latin for readable folder slugs
/** @type {Record<string, string>} */
export const TRANSLIT = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
  х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
}

/**
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const lat = String(name).toLowerCase().split('').map(ch => TRANSLIT[ch] ?? ch).join('')
  return lat.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/**
 * @param {string} name
 * @param {(id: string) => boolean} [folderIdTakenByUser]  true if a user is bound to this folderId
 * @returns {string}
 */
export function uniqueFolderId(name, folderIdTakenByUser = () => false) {
  const base = slugify(name) || `client-${crypto.randomBytes(2).toString('hex')}`
  let id = base
  for (let n = 2; folderExists(id) || folderIdTakenByUser(id); n++) id = `${base}-${n}`
  return id
}

/**
 * @param {string} base
 * @param {(name: string) => boolean} [userExists]  true if a user with this username exists
 * @returns {string}
 */
export function uniqueUsername(base, userExists = () => false) {
  let name = base
  for (let n = 2; userExists(name); n++) name = `${base}-${n}`
  return name
}

// Track filename → { title, artist } ("Artist - Title.mp3")
/**
 * @param {string} folderId
 * @param {string} category
 * @returns {Track[]}
 */
export function scanFolder(folderId, category) {
  if (!VALID_CATEGORIES.includes(category)) return []
  const dir = path.join(folderPath(folderId), category)
  try {
    return fs.readdirSync(dir)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .map((filename, i) => {
        const base   = path.basename(filename, path.extname(filename))
        const dash   = base.indexOf(' - ')
        const title  = dash > 0 ? base.slice(dash + 3).trim() : base
        const artist = dash > 0 ? base.slice(0, dash).trim()  : 'Unknown'
        return {
          id:       `${folderId}-${category}-${i}`,
          filename,
          title,
          artist,
          category,
          folderId,
          src: `http://localhost:${PORT}/music/${encodeURIComponent(folderId)}/${category}/${encodeURIComponent(filename)}`,
        }
      })
  } catch {
    return []
  }
}

// Folders visible to a user: admin → all, client → own folder only
/**
 * @param {{ role: string, folderId?: string | null }} user
 * @returns {string[]}
 */
export function visibleFolders(user) {
  if (user.role === 'admin') return listFolderIds()
  return user.folderId && folderExists(user.folderId) ? [user.folderId] : []
}

/**
 * @param {{ role: string, folderId?: string | null }} user
 * @param {string} category
 * @returns {Track[]}
 */
export function tracksForCategory(user, category) {
  const out = []
  for (const f of visibleFolders(user)) out.push(...scanFolder(f, category))
  return out
}

/**
 * @param {string} folderId
 * @returns {{ counts: Record<string, number>, sizeBytes: number }}
 */
export function folderStats(folderId) {
  /** @type {Record<string, number>} */
  const counts = {}
  let sizeBytes = 0
  for (const cat of VALID_CATEGORIES) {
    const dir = path.join(folderPath(folderId), cat)
    let n = 0
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!AUDIO_EXTS.has(path.extname(f).toLowerCase())) continue
        n++
        try { sizeBytes += fs.statSync(path.join(dir, f)).size } catch { /* skip */ }
      }
    } catch { /* folder may not exist */ }
    counts[cat] = n
  }
  return { counts, sizeBytes }
}

/**
 * @param {string} folderId
 * @param {boolean} [singlePlaylist]
 */
export function createClientFolders(folderId, singlePlaylist = false) {
  const cats = singlePlaylist ? [ALL_CATEGORY] : CATEGORIES
  for (const cat of cats) fs.mkdirSync(path.join(folderPath(folderId), cat), { recursive: true })
}

// Strip anything dangerous from an uploaded filename; keep unicode letters
/**
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  const base = path.basename(String(name || ''))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200)
  return base
}

// Time-of-day → schedule category. 18-23 and 0-5 are treated as evening.
/** @returns {string} */
export function getTimeCategory() {
  const h = new Date().getHours()
  if (h >= 6  && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'day'
  return 'evening'   // 18-23 and 0-5 treated as evening
}
