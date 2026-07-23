// @ts-check
/**
 * uploads.mjs — multipart (busboy) upload handlers.
 *   handleUpload         — add audio tracks to a client folder/category (all AUDIO_EXTS, ≤200MB each)
 *   handleClassifyUpload — stage mp3s under _incoming/<batchId>/ then classify
 */
import fs     from 'node:fs'
import path   from 'node:path'
import crypto from 'node:crypto'
import Busboy from 'busboy'
import { INCOMING_DIR, UPLOAD_MAX_FILE, MAX_BATCH_FILES, MAX_UPLOAD_BYTES, DRAIN_TIMEOUT_MS, AUDIO_EXTS } from './config.mjs'
import { folderPath, sanitizeFilename } from './folders.mjs'
import { json } from './http.mjs'
import { setBatch, persistBatches, runClassify, claimName } from './classify.mjs'

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
  const accepted = []
  /** @type {{ filename: string, reason: string }[]} */  // reason ∈ size | ext | name | write_error
  const rejected = []
  /** @type {Map<import('node:fs').WriteStream, string>} */
  const openStreams = new Map()   // in-flight writes → their dest path
  let parts    = 0
  let pending  = 0
  let finished = false
  let responded = false
  let aborted   = false

  // Connection died mid-upload: busboy never emits 'close', so the half-written
  // files would stay in the client's category folder and show up in the library
  // as truncated tracks. Close each in-flight fd, then delete just those files
  // (already-settled ones are complete and stay).
  req.on('close', () => {
    if (responded || aborted || req.complete) return
    aborted = true
    for (const [stream, destPath] of openStreams) {
      stream.once('close', () => { fs.promises.unlink(destPath).catch(() => {}) })
      try { stream.destroy() } catch { fs.promises.unlink(destPath).catch(() => {}) }
    }
    openStreams.clear()
  })

  const done = () => {
    if (responded || !finished || pending > 0) return
    responded = true
    console.log(`[upload] ${folderId}/${category}: parts=${parts} accepted=${accepted.length} rejected=${rejected.length}`)
    for (const r of rejected) console.log(`[upload]   rejected ${r.filename}: ${r.reason}`)
    // 200 whenever at least one file landed (or nothing was rejected); 400 only
    // when a request produced rejections and NOTHING was accepted.
    const status = accepted.length > 0 || rejected.length === 0 ? 200 : 400
    json(res, { accepted, rejected }, status)
  }

  let bb
  try {
    bb = Busboy({
      headers: req.headers,
      // busboy defaults filename decoding to latin1 → Cyrillic upload names become
      // mojibake; browsers send UTF-8, so decode as UTF-8.
      defParamCharset: 'utf8',
      // Per-file size cap ONLY. No `files` count cap: busboy silently discards
      // parts beyond a count limit (no per-file event) → lost tracks. Every part
      // is processed and individually accepted/rejected instead.
      limits: { fileSize: UPLOAD_MAX_FILE, fields: 5 },
    })
  } catch {
    return json(res, { error: 'Malformed multipart request' }, 400)
  }

  bb.on('file', (_field, file, info) => {
    parts++
    const rawName = info.filename || ''
    let name = sanitizeFilename(rawName)   // normalises FS-illegal chars, keeps Cyrillic/spaces/()
    let ext  = path.extname(name).toLowerCase()

    // Name sanitised to empty (all-illegal chars) but the ORIGINAL carried a valid
    // audio extension → salvage with a generated name instead of dropping the file.
    if (!name) {
      const rawExt = path.extname(rawName).toLowerCase()
      if (AUDIO_EXTS.has(rawExt)) { name = `track-${crypto.randomBytes(3).toString('hex')}${rawExt}`; ext = rawExt }
    }
    if (!name)                { rejected.push({ filename: rawName || '(без имени)', reason: 'name' }); file.resume(); return }
    if (!AUDIO_EXTS.has(ext))  { rejected.push({ filename: rawName, reason: 'ext' });                 file.resume(); return }

    // Collision-safe name: claimName creates the file atomically (open 'wx'), so
    // the reservation covers BOTH earlier files in this request and any concurrent
    // confirm/move/upload — no separate in-request bookkeeping, and no window in
    // which another writer can take the name we just picked.
    let finalName
    try {
      finalName = claimName(destDir, name)
    } catch {
      rejected.push({ filename: rawName, reason: 'write_error' })
      file.resume()
      return
    }

    const destPath = path.join(destDir, finalName)
    pending++
    // 'w', not 'wx': claimName already created the (empty) placeholder for us.
    const out = fs.createWriteStream(destPath, { flags: 'w' })
    openStreams.set(out, destPath)

    let limited = false
    let settled = false   // fs.WriteStream fires 'error' AND then 'close' — settle each file exactly once
    /** @param {string | null} rejectReason */
    const settle = (rejectReason) => {
      if (settled) return
      settled = true
      openStreams.delete(out)
      if (rejectReason) {
        fs.promises.unlink(destPath).catch(() => {})
        rejected.push({ filename: rawName, reason: rejectReason })
      } else {
        accepted.push({ filename: finalName, category })
      }
      pending--
      done()
    }

    file.on('limit', () => { limited = true })
    out.on('error', () => { file.resume(); settle('write_error') })
    out.on('close', () => settle(limited ? 'size' : null))
    file.pipe(out)
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
  /** @type {Set<import('node:fs').WriteStream>} */
  const openStreams = new Set()   // files still being written (their fds are open)
  /** @type {import('busboy').Busboy | undefined} */
  let bb                          // declared up front: the abort/drain helpers below reference it
  let uploaded  = 0
  let totalBytes = 0
  let parts      = 0
  let pending    = 0
  let finished   = false
  let responded  = false
  let aborted    = false

  // Drop the staging dir. Any write stream still open has to be destroyed and
  // fully closed FIRST: on Windows an open fd makes rmSync fail with EBUSY/EPERM
  // and the partial files would survive the cleanup.
  const purgeStaging = () => {
    const rm = () => { try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* swept on next boot */ } }
    if (!openStreams.size) return rm()
    let left = openStreams.size
    for (const s of openStreams) {
      s.once('close', () => { if (--left === 0) rm() })
      try { s.destroy() } catch { left-- }
    }
    setTimeout(rm, 2000).unref?.()   // backstop if a stream never emits 'close'
  }

  /** @param {number} status @param {any} body */
  const cleanupAndRespond = (status, body) => {
    if (responded) return
    responded = true
    purgeStaging()
    json(res, body, status)
  }

  // Connection died before busboy finished reading the body (closed tab, lost
  // network, client abort). busboy then never emits 'close', so finish() never
  // runs and the staged files would linger forever: the batch is only registered
  // in finish(), so DELETE /admin/classify/:batchId can't reach them either.
  const abortUpload = () => {
    if (responded || aborted) return
    aborted = true
    try { req.unpipe(bb) } catch { /* already detached */ }
    purgeStaging()
  }
  req.on('close', () => { if (!req.complete) abortUpload() })

  // Stop consuming the body after a rejection (413) WITHOUT killing the socket
  // outright: destroying it while the client is still uploading makes it see
  // ECONNRESET instead of our status code. Drain the rest so the response is
  // delivered, with a deadline so a multi-GB body can't hold the socket open.
  const stopIntake = () => {
    try { req.unpipe(bb) } catch { /* already detached */ }
    req.resume()
    const kill = setTimeout(() => { try { req.destroy() } catch { /* already gone */ } }, DRAIN_TIMEOUT_MS)
    kill.unref?.()
    req.once('end', () => clearTimeout(kill))
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

  try {
    // No per-file size cap here (the 20 MB /upload cap does not apply to a
    // classify batch): the batch is bounded only by MAX_BATCH_FILES and the
    // running MAX_UPLOAD_BYTES total, so a single long/high-bitrate track is
    // never silently truncated and dropped into `skipped`.
    // defParamCharset:'utf8' so Cyrillic upload filenames aren't mangled (busboy
    // defaults to latin1).
    // No busboy `files` count limit: on hitting it busboy silently skips every
    // further part (one 'filesLimit' event, no per-file event), so the extra
    // tracks vanished with no names reported. The cap is enforced per part below
    // and answered with 413, as the spec requires.
    bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fields: 5 } })
  } catch {
    return cleanupAndRespond(400, { error: 'Malformed multipart request' })
  }

  bb.on('file', (_field, file, info) => {
    if (aborted) { file.resume(); return }
    // Too many files → 413 (spec) instead of silently dropping the tail.
    if (++parts > MAX_BATCH_FILES) {
      aborted = true
      cleanupAndRespond(413, { error: `Слишком много файлов (> ${MAX_BATCH_FILES}) — разделите папку на части` })
      file.resume()
      stopIntake()
      return
    }
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

    // Atomic reservation (see claimName): covers collisions inside this request
    // and against anything else writing into the staging dir.
    let finalName
    try {
      finalName = claimName(destDir, safeName)
    } catch {
      skipped.push(rawName)
      file.resume()
      return
    }

    const destPath = path.join(destDir, finalName)
    pending++
    // 'w', not 'wx': claimName already created the (empty) placeholder for us.
    const out = fs.createWriteStream(destPath, { flags: 'w' })
    openStreams.add(out)   // tracked so an abort can close every fd before rmSync
    let limited = false
    let settled = false
    /** @param {boolean} ok */
    const settle = (ok) => {
      if (settled) return
      settled = true
      openStreams.delete(out)
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
        stopIntake()
      }
    })
    file.on('limit', () => { limited = true })
    out.on('error', () => { file.resume(); settle(false) })
    out.on('close', () => settle(!limited))
    file.pipe(out)
  })

  bb.on('error', () => { if (!responded && !aborted) cleanupAndRespond(400, { error: 'Ошибка разбора загрузки' }) })
  bb.on('close', () => { finished = true; finish() })

  req.pipe(bb)
}
