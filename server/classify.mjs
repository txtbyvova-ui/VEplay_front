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
  INCOMING_DIR, PENDING_FILE, CATEGORIES, PYTHON_BIN, CLASSIFY_SCRIPT,
} from './config.mjs'

/**
 * @typedef {Object} Batch
 * @property {string} batchId
 * @property {string} folderId
 * @property {'classifying'|'ready'|'error'|'confirming'} status
 * @property {any[]} tracks
 * @property {string=} error
 * @property {number} createdAt
 * @property {boolean} canceled
 */

/** @type {Map<string, Batch>} */
const batches = new Map()

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
  return { batchId: b.batchId, folderId: b.folderId, status: b.status, tracks: b.tracks, error: b.error, createdAt: b.createdAt }
}

// Public view returned to the admin frontend.
/** @param {Batch} b */
export function batchView(b) {
  return { batchId: b.batchId, folderId: b.folderId, status: b.status, tracks: b.tracks, error: b.error ?? null }
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

// On boot: keep only 'ready' batches whose staging dir still exists; treat every
// other staged dir as stale and purge it (a crash mid-classify leaves junk).
export function recoverBatches() {
  let saved = []
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
    if (Array.isArray(data.batches)) saved = data.batches
  } catch { /* no pending file yet */ }

  const keep = new Set()
  for (const b of saved) {
    const dir = b.batchId && path.join(INCOMING_DIR, b.batchId)
    if (b.status === 'ready' && dir && fs.existsSync(dir)) {
      batches.set(b.batchId, { ...batchSnapshot(b), canceled: false })
      keep.add(b.batchId)
    }
  }

  // Sweep orphan staging dirs (not recovered) so _incoming never leaks disk.
  try {
    for (const name of fs.readdirSync(INCOMING_DIR)) {
      if (!keep.has(name)) fs.rmSync(path.join(INCOMING_DIR, name), { recursive: true, force: true })
    }
  } catch { /* _incoming may not exist yet */ }

  if (batches.size) persistBatches()
}

// Give a filename that does not collide inside destDir: "name.mp3" -> "name_2.mp3".
/**
 * @param {string} destDir
 * @param {string} filename
 * @returns {string}
 */
export function uniqueName(destDir, filename) {
  const ext  = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let name = filename
  for (let n = 2; fs.existsSync(path.join(destDir, name)); n++) name = `${stem}_${n}${ext}`
  return name
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
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', e => markBatchError(batch, `Классификатор не запустился: ${e.message}`))
  child.on('close', code => {
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
    persistBatches()
  })
}
