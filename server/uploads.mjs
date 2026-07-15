// @ts-check
/**
 * uploads.mjs — multipart (busboy) upload handlers.
 *   handleUpload         — add mp3s to a client folder/category (≤20MB each)
 *   handleClassifyUpload — stage mp3s under _incoming/<batchId>/ then classify
 */
import fs     from 'node:fs'
import path   from 'node:path'
import crypto from 'node:crypto'
import Busboy from 'busboy'
import { INCOMING_DIR, UPLOAD_MAX_FILE, UPLOAD_MAX_FILES, MAX_BATCH_FILES, MAX_UPLOAD_BYTES } from './config.mjs'
import { folderPath, sanitizeFilename } from './folders.mjs'
import { json } from './http.mjs'
import { setBatch, persistBatches, runClassify } from './classify.mjs'

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} folderId
 * @param {string} category
 */
export function handleUpload(req, res, folderId, category) {
  const destDir = path.join(folderPath(folderId), category)
  fs.mkdirSync(destDir, { recursive: true })

  /** @type {{ filename: string, category: string }[]} */
  const uploaded = []
  /** @type {{ filename: string, reason: string }[]} */
  const rejected = []
  const claimed  = new Set()   // names reserved within THIS request (existsSync can't see in-flight writes)
  let pending = 0
  let finished = false
  let responded = false

  const done = () => {
    if (responded || !finished || pending > 0) return
    responded = true
    const status = uploaded.length > 0 || rejected.length === 0 ? 200 : 400
    json(res, { uploaded, rejected }, status)
  }

  let bb
  try {
    bb = Busboy({
      headers: req.headers,
      // busboy defaults filename decoding to latin1 → Cyrillic upload names become
      // mojibake; browsers send UTF-8, so decode as UTF-8.
      defParamCharset: 'utf8',
      limits: { fileSize: UPLOAD_MAX_FILE, files: UPLOAD_MAX_FILES, fields: 5 },
    })
  } catch {
    return json(res, { error: 'Malformed multipart request' }, 400)
  }

  bb.on('file', (_field, file, info) => {
    const rawName  = info.filename || ''
    const safeName = sanitizeFilename(rawName)
    const ext      = path.extname(safeName).toLowerCase()
    const mimeOk   = info.mimeType === 'audio/mpeg' || info.mimeType === 'audio/mp3'

    if (!safeName || ext !== '.mp3' || !mimeOk) {
      rejected.push({ filename: rawName, reason: 'Только mp3 (audio/mpeg)' })
      file.resume()   // drain the stream, discard content
      return
    }

    // Avoid overwriting an existing track: "name.mp3" → "name (2).mp3".
    // Guard against BOTH on-disk files and names already claimed by an
    // earlier file in this same request (existsSync can't see in-flight writes).
    let finalName = safeName
    const stem = safeName.slice(0, -ext.length)
    for (let n = 2; claimed.has(finalName) || fs.existsSync(path.join(destDir, finalName)); n++) {
      finalName = `${stem} (${n})${ext}`
    }
    claimed.add(finalName)

    const destPath = path.join(destDir, finalName)
    pending++
    const out = fs.createWriteStream(destPath, { flags: 'wx' })

    let limited = false
    let settled = false   // fs.WriteStream fires 'error' AND then 'close' — settle each file exactly once
    /** @param {string | null} rejectReason */
    const settle = (rejectReason) => {
      if (settled) return
      settled = true
      if (rejectReason) {
        fs.promises.unlink(destPath).catch(() => {})
        rejected.push({ filename: rawName, reason: rejectReason })
      } else {
        uploaded.push({ filename: finalName, category })
      }
      pending--
      done()
    }

    file.on('limit', () => { limited = true })

    out.on('error', () => {
      file.resume()   // drain, discard
      settle('Ошибка записи на диск')
    })

    out.on('close', () => {
      settle(limited ? `Файл больше ${UPLOAD_MAX_FILE / 1024 / 1024}MB` : null)
    })

    file.pipe(out)
  })

  bb.on('filesLimit', () => {
    rejected.push({ filename: '…', reason: `Не больше ${UPLOAD_MAX_FILES} файлов за раз` })
  })

  bb.on('error', () => {
    if (responded) return
    responded = true
    json(res, { error: 'Upload parse error' }, 400)
  })

  bb.on('close', () => { finished = true; done() })

  req.pipe(bb)
}

// Multipart handler: stage uploaded .mp3s under _incoming/<batchId>/, then kick
// off classification. Responds 202 as soon as files are on disk.
/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} folderId
 */
export function handleClassifyUpload(req, res, folderId) {
  const batchId = crypto.randomUUID()
  const destDir = path.join(INCOMING_DIR, batchId)
  try {
    fs.mkdirSync(destDir, { recursive: true })
  } catch (e) {
    return json(res, { error: `Не удалось создать папку загрузки: ${/** @type {Error} */ (e).message}` }, 500)
  }

  /** @type {string[]} */
  const skipped = []
  const claimed = new Set()
  let uploaded  = 0
  let totalBytes = 0
  let pending    = 0
  let finished   = false
  let responded  = false
  let aborted    = false

  /** @param {number} status @param {any} body */
  const cleanupAndRespond = (status, body) => {
    if (responded) return
    responded = true
    fs.rmSync(destDir, { recursive: true, force: true })
    json(res, body, status)
  }

  const finish = () => {
    if (responded || aborted || !finished || pending > 0) return
    if (uploaded === 0) {
      return cleanupAndRespond(400, { error: 'Нет валидных mp3 в папке', skipped })
    }
    responded = true
    /** @type {import('./classify.mjs').Batch} */
    const batch = { batchId, folderId, status: 'classifying', tracks: [], error: undefined, createdAt: Date.now(), canceled: false }
    setBatch(batchId, batch)
    persistBatches()
    json(res, { batchId, status: 'classifying', uploaded, skipped }, 202)
    runClassify(batch)
  }

  let bb
  try {
    // No per-file size cap here (the 20 MB /upload cap does not apply to a
    // classify batch): the batch is bounded only by MAX_BATCH_FILES and the
    // running MAX_UPLOAD_BYTES total, so a single long/high-bitrate track is
    // never silently truncated and dropped into `skipped`.
    // defParamCharset:'utf8' so Cyrillic upload filenames aren't mangled (busboy
    // defaults to latin1).
    bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: MAX_BATCH_FILES, fields: 5 } })
  } catch {
    return cleanupAndRespond(400, { error: 'Malformed multipart request' })
  }

  bb.on('file', (_field, file, info) => {
    const rawName  = info.filename || ''
    const safeName = sanitizeFilename(rawName)
    const ext      = path.extname(safeName).toLowerCase()

    // The Python scanner only reads .mp3 — skip anything else so we never stage
    // files the classifier would silently ignore.
    if (!safeName || ext !== '.mp3') {
      skipped.push(rawName || '(без имени)')
      file.resume()
      return
    }

    let finalName = safeName
    const stem = safeName.slice(0, -ext.length)
    for (let n = 2; claimed.has(finalName) || fs.existsSync(path.join(destDir, finalName)); n++) {
      finalName = `${stem}_${n}${ext}`
    }
    claimed.add(finalName)

    const destPath = path.join(destDir, finalName)
    pending++
    const out = fs.createWriteStream(destPath, { flags: 'wx' })
    let limited = false
    let settled = false
    /** @param {boolean} ok */
    const settle = (ok) => {
      if (settled) return
      settled = true
      if (ok) uploaded++
      else { fs.promises.unlink(destPath).catch(() => {}); skipped.push(rawName) }
      pending--
      finish()
    }

    file.on('data', d => {
      totalBytes += d.length
      if (totalBytes > MAX_UPLOAD_BYTES && !aborted) {
        aborted = true
        cleanupAndRespond(413, { error: `Слишком большой объём (> ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB)` })
        req.destroy()
      }
    })
    file.on('limit', () => { limited = true })
    out.on('error', () => { file.resume(); settle(false) })
    out.on('close', () => settle(!limited))
    file.pipe(out)
  })

  bb.on('filesLimit', () => { skipped.push(`… (не больше ${MAX_BATCH_FILES} файлов)`) })
  bb.on('error', () => { if (!responded && !aborted) cleanupAndRespond(400, { error: 'Ошибка разбора загрузки' }) })
  bb.on('close', () => { finished = true; finish() })

  req.pipe(bb)
}
