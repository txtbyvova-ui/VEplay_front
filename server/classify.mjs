// @ts-check
/**
 * classify.mjs — VEclassify bridge: stage a folder, run the Python classifier,
 * hold reviewable batches in memory, persist 'ready' state across restarts.
 *
 * batchId -> { batchId, folderId, status, tracks, error?, createdAt, canceled }
 *   status: 'classifying' | 'ready' | 'error' | 'confirming'
 */
import fs   from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  INCOMING_DIR, PENDING_FILE, CATEGORIES, PYTHON_BIN, CLASSIFY_SCRIPT, CLASSIFY_TIMEOUT_MS,
} from './config.mjs'

/**
 * @typedef {Object} Batch
 * @property {string} batchId
 * @property {string} folderId
 * @property {'classifying'|'ready'|'error'|'confirming'} status
 * @property {any[]} tracks
 * @property {string=} error
 * @property {string=} warning   classifier finished but its output is degraded (Gemini fell back)
 * @property {number} createdAt
 * @property {boolean} canceled
 */

/** @type {Map<string, Batch>} */
const batches = new Map()

// Running classifier children, kept OUT of the Batch objects so they never reach
// JSON.stringify in persistBatches(). Used to actually kill the process when a
// batch is cancelled — otherwise librosa keeps chewing CPU on a staging folder
// that is being deleted, and on Windows its open handles make rmSync fail.
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const runningChildren = new Map()

// A batchId only ever comes from crypto.randomUUID(). Anything else (a tampered
// pending_batches.json, a crafted URL) must never reach path.join.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** @param {unknown} id @returns {boolean} */
export const isValidBatchId = (id) => typeof id === 'string' && UUID_RE.test(id)

/**
 * Remove a batch's staging dir, killing the classifier first. Windows keeps the
 * mp3s locked while python reads them, so a single rmSync right after the kill
 * loses the race — retry a few times, then leave it for the next boot sweep.
 * @param {string} batchId
 */
export function purgeStagingDir(batchId) {
  if (!isValidBatchId(batchId)) return
  const child = runningChildren.get(batchId)
  if (child) {
    try { child.kill() } catch { /* already gone */ }
    runningChildren.delete(batchId)
  }
  const dir = path.join(INCOMING_DIR, batchId)
  /** @param {number} n */
  const attempt = (n) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      if (n < 4) setTimeout(() => attempt(n + 1), 250 * (n + 1)).unref?.()
    }
  }
  attempt(0)
}

// ── batch store accessors (map kept module-private) ──────────────────────────
/** @param {string} id @returns {Batch | undefined} */
export const getBatch = (id) => batches.get(id)
/** @param {string} id @param {Batch} batch */
export const setBatch = (id, batch) => { batches.set(id, batch) }
/** @param {string} id @returns {boolean} */
export const deleteBatch = (id) => batches.delete(id)

/** @param {string} c @returns {string} */
export const normalizeCat = (c) => (CATEGORIES.includes(c) ? c : 'evening')

// Only the persistable fields (never the transient `canceled` flag).
/** @param {Batch} b */
export function batchSnapshot(b) {
  return { batchId: b.batchId, folderId: b.folderId, status: b.status, tracks: b.tracks, error: b.error, warning: b.warning, createdAt: b.createdAt }
}

// Public view returned to the admin frontend.
/** @param {Batch} b */
export function batchView(b) {
  return { batchId: b.batchId, folderId: b.folderId, status: b.status, tracks: b.tracks, error: b.error ?? null, warning: b.warning ?? null }
}

let pendingWriteQueue = Promise.resolve()
/** @returns {Promise<void>} */
export function persistBatches() {
  const data = JSON.stringify({ batches: [...batches.values()].map(batchSnapshot) }, null, 2)
  pendingWriteQueue = pendingWriteQueue
    .then(() => {
      const tmp = PENDING_FILE + '.tmp'
      return fs.promises.writeFile(tmp, data).then(() => fs.promises.rename(tmp, PENDING_FILE))
    })
    .catch(e => console.error('pending_batches.json write failed:', e))
  return pendingWriteQueue
}

// On boot: recover reviewable batches whose staging dir still exists; treat every
// other staged dir as stale and purge it (a crash mid-classify leaves junk).
//
// 'confirming' is recovered too, as 'ready': a crash mid-confirm leaves the files
// that had not been moved yet still sitting in staging, and dropping the record
// would delete them for good. Tracks are re-checked against the actual directory,
// so the ones already moved don't come back as phantom rows.
export function recoverBatches() {
  let saved = []
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
    if (Array.isArray(data.batches)) saved = data.batches
  } catch { /* no pending file yet, or a truncated write — start clean */ }

  const keep = new Set()
  for (const b of saved) {
    if (!isValidBatchId(b?.batchId)) continue          // never let a tampered id reach path.join
    if (b.status !== 'ready' && b.status !== 'confirming') continue
    const dir = path.join(INCOMING_DIR, b.batchId)
    if (!fs.existsSync(dir)) continue
    let staged
    try { staged = new Set(fs.readdirSync(dir)) } catch { continue }
    const tracks = (Array.isArray(b.tracks) ? b.tracks : []).filter(/** @param {any} t */ t => staged.has(t?.filename))
    if (!tracks.length) continue                        // nothing left to review → let the sweep remove it
    batches.set(b.batchId, { ...batchSnapshot(b), status: 'ready', tracks, canceled: false })
    keep.add(b.batchId)
  }

  // Sweep orphan staging dirs (not recovered) so _incoming never leaks disk.
  try {
    for (const name of fs.readdirSync(INCOMING_DIR)) {
      if (!keep.has(name)) fs.rmSync(path.join(INCOMING_DIR, name), { recursive: true, force: true })
    }
  } catch { /* _incoming may not exist yet */ }

  if (batches.size) persistBatches()
}

// Reserve a non-colliding filename inside destDir: "name.mp3" -> "name_2.mp3".
//
// The reservation is the atomic open(..., 'wx') itself, not a preceding
// existsSync check. A check-then-act version raced every other writer: an upload
// picked a free name, and before its stream actually created the file a confirm
// or move renamed ITS file onto the same path — rename overwrites silently, so
// one of the two tracks vanished while both requests reported success.
//
// The caller receives a name it exclusively owns (an empty placeholder file is
// already on disk) and is expected to write over it.
/**
 * @param {string} destDir
 * @param {string} filename
 * @returns {string}
 */
export function claimName(destDir, filename) {
  const ext  = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  for (let n = 1; n < 10000; n++) {
    const name = n === 1 ? filename : `${stem}_${n}${ext}`
    try {
      fs.closeSync(fs.openSync(path.join(destDir, name), 'wx'))
      return name
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e
    }
  }
  throw new Error(`Не удалось подобрать свободное имя для ${filename}`)
}

// Move a file, falling back to copy+unlink when src/dest sit on different volumes.
/**
 * @param {string} src
 * @param {string} dest
 */
export function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EXDEV') {
      fs.copyFileSync(src, dest)
      fs.unlinkSync(src)
    } else {
      throw e
    }
  }
}

/**
 * @param {Batch} batch
 * @param {unknown} message
 */
export function markBatchError(batch, message) {
  if (batch.canceled || !batches.has(batch.batchId)) return
  // Keep the FIRST error. A failed spawn reports the precise cause via the
  // 'error' event ("python3 ENOENT"), and the 'close' event that follows would
  // otherwise overwrite it with the useless "завершился с кодом null".
  if (batch.status === 'error' && batch.error) return
  batch.status = 'error'
  batch.error  = String(message || 'Ошибка классификации').slice(-2000)
  persistBatches()
}

// Spawn VEclassify on a staged folder; parse its stdout JSON into batch.tracks.
/**
 * @param {Batch} batch
 */
export function runClassify(batch) {
  const dir = path.join(INCOMING_DIR, batch.batchId)
  batch.status = 'classifying'
  batch.error  = undefined
  persistBatches()

  let out = '', err = ''
  let child
  try {
    child = spawn(PYTHON_BIN, [CLASSIFY_SCRIPT, '--folder', dir, '--json'], {
      cwd: path.dirname(CLASSIFY_SCRIPT),   // so VEclassify/config.py finds its .env
      // Force UTF-8 I/O so non-ASCII filenames/tags survive the pipe on Windows
      // (belt-and-suspenders with the script's own sys.stdout.reconfigure).
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
  } catch (e) {
    markBatchError(batch, `Не удалось запустить классификатор: ${/** @type {Error} */ (e).message}`)
    return
  }

  // Read the child's streams strictly as UTF-8. setEncoding installs a
  // StringDecoder that correctly reassembles multi-byte sequences split across
  // chunk boundaries — a plain `out += buffer` would corrupt a Cyrillic char
  // that straddles two 'data' events.
  runningChildren.set(batch.batchId, child)

  // Watchdog: a child that never exits would pin the batch in 'classifying'
  // forever (the frontend polls it indefinitely, and confirm/retry stay blocked).
  const watchdog = setTimeout(() => {
    if (!runningChildren.has(batch.batchId)) return
    try { child.kill() } catch { /* already gone */ }
    markBatchError(batch, `Классификатор не ответил за ${Math.round(CLASSIFY_TIMEOUT_MS / 60000)} мин и был остановлен`)
  }, CLASSIFY_TIMEOUT_MS)
  watchdog.unref?.()

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', e => {
    clearTimeout(watchdog)
    runningChildren.delete(batch.batchId)
    markBatchError(batch, `Классификатор не запустился: ${e.message}`)
  })
  child.on('close', code => {
    clearTimeout(watchdog)
    runningChildren.delete(batch.batchId)
    // Batch dropped/cancelled while the python ran → discard the result entirely.
    if (batch.canceled || !batches.has(batch.batchId)) return
    if (code !== 0) {
      return markBatchError(batch, err.trim() || `Классификатор завершился с кодом ${code}`)
    }
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      return markBatchError(batch, `Не удалось разобрать вывод классификатора. stderr: ${err.trim().slice(-1500)}`)
    }
    /** @type {any[]} */
    const rows = Array.isArray(parsed?.tracks) ? parsed.tracks : []
    batch.tracks = rows.map(t => ({ ...t, category: normalizeCat(t.time_of_day), override: null }))
    batch.status = 'ready'
    batch.error  = undefined
    // The classifier reports a degraded run (Gemini never answered, categories are
    // fallback values) — surface it so the admin doesn't apply them as real ones.
    batch.warning = typeof parsed?.warning === 'string' ? parsed.warning.slice(0, 500) : undefined
    persistBatches()
  })
}
