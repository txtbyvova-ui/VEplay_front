// @ts-check
/**
 * router.mjs — the single request handler. All routing lives here; behavior is
 * identical to the original monolithic server.mjs (route order, status codes and
 * messages are load-bearing — do not reorder).
 */
import fs   from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'
import {
  PORT, CATEGORIES, ALL_CATEGORY, VALID_CATEGORIES, TOKEN_TTL, INCOMING_DIR, MUSIC_ROOT,
} from './config.mjs'
import { hashPassword, verifyPassword, signToken, generatePassword, DECOY } from './crypto.mjs'
import {
  getUsers, findUser, addUser, setUsers, saveUsers, sanitize, cleanCats, readFlags,
} from './users.mjs'
import {
  safeDecode, safeSegment, folderPath, listFolderIds, folderExists,
  uniqueFolderId, uniqueUsername, scanFolder, tracksForCategory, folderStats,
  createClientFolders, getTimeCategory,
} from './folders.mjs'
import { streamAudio } from './streaming.mjs'
import {
  setCors, json, readBody, clientIp, loginRateLimited, clearLoginAttempts, authUser,
} from './http.mjs'
import { handleUpload, handleClassifyUpload } from './uploads.mjs'
import {
  getBatch, deleteBatch, persistBatches, runClassify, normalizeCat, claimName, moveFile, batchView,
  purgeStagingDir,
} from './classify.mjs'

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleRequest(req, res) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  let parsed
  try {
    parsed = new URL(req.url ?? '', `http://localhost:${PORT}`)
  } catch {
    return json(res, { error: 'Bad request' }, 400)
  }
  const pathname = parsed.pathname

  // ── POST /auth/login ────────────────────────────────────────────────────────
  if (pathname === '/auth/login' && req.method === 'POST') {
    const ip = clientIp(req)
    if (loginRateLimited(ip)) {
      return json(res, { error: 'Слишком много попыток входа. Подождите 15 минут.' }, 429)
    }
    const { username, password } = await readBody(req)
    const user = findUser(username)
    // Always run one scrypt so a missing user and a wrong password take the
    // same time (no username enumeration via response latency).
    const ok = user
      ? verifyPassword(password, user.salt, user.hash)
      : (verifyPassword(password, DECOY.salt, DECOY.hash), false)
    if (!ok || !user) {
      return json(res, { error: 'Invalid login or password' }, 401)
    }
    clearLoginAttempts(ip)   // successful login clears the counter
    // Flag the default admin/admin credentials so the UI can warn loudly
    user.weakPassword = user.role === 'admin' && String(password) === 'admin'
    const token = signToken({ u: user.username, exp: Date.now() + TOKEN_TTL })
    return json(res, { token, user: sanitize(user) })
  }

  // ── GET /auth/me ──────────────────────────────────────────────────────────--
  if (pathname === '/auth/me') {
    const user = authUser(req, parsed)
    if (!user) return json(res, { error: 'Unauthorized' }, 401)
    return json(res, { user: sanitize(user) })
  }

  // ── Admin routes (role=admin) ────────────────────────────────────────────────
  if (pathname.startsWith('/admin/')) {
    const me = authUser(req, parsed)
    if (!me) return json(res, { error: 'Unauthorized' }, 401)
    if (me.role !== 'admin') return json(res, { error: 'Forbidden' }, 403)

    // GET /admin/categories — aggregated track counts across all folders
    if (pathname === '/admin/categories' && req.method === 'GET') {
      const folders = listFolderIds()
      return json(res, CATEGORIES.map(id => {
        let count = 0
        for (const f of folders) count += scanFolder(f, id).length
        return { id, exists: folders.length > 0, count }
      }))
    }

    // GET /admin/users
    if (pathname === '/admin/users' && req.method === 'GET') {
      return json(res, getUsers().map(sanitize))
    }

    // POST /admin/users — create (folderId optional: bind user to a client folder)
    if (pathname === '/admin/users' && req.method === 'POST') {
      const body = await readBody(req)
      const username = String(body.username || '').trim()
      if (!username || !body.password) return json(res, { error: 'username and password are required' }, 400)
      if (findUser(username)) return json(res, { error: 'User already exists' }, 409)
      const role = body.role === 'admin' ? 'admin' : 'user'
      const folderId = body.folderId ? safeSegment(body.folderId) : null
      if (body.folderId && !folderExists(folderId)) return json(res, { error: 'Folder not found' }, 400)
      // Feature flags default to true when absent (opt-out, not opt-in).
      const flags = readFlags(body)
      const newUser = {
        username, role, categories: cleanCats(body.categories), folderId,
        allowFolderSelector: flags.allowFolderSelector ?? true,
        allowShuffle: flags.allowShuffle ?? true,
        // opt-IN, see sanitize(): a new screen must not appear on its own
        allowTrackList: flags.allowTrackList ?? false,
        ...hashPassword(body.password),
      }
      addUser(newUser)
      await saveUsers()
      return json(res, sanitize(newUser), 201)
    }

    // ── Clients: 1 client = 1 folder ──────────────────────────────────────────

    // GET /admin/clients — folders + bound user + stats
    if (pathname === '/admin/clients' && req.method === 'GET') {
      const out = listFolderIds().map(folderId => {
        const owner = getUsers().find(u => u.folderId === folderId)
        const { counts, sizeBytes } = folderStats(folderId)
        return {
          folderId,
          name:     owner?.name ?? folderId,
          username: owner?.username ?? null,
          singlePlaylist: owner?.singlePlaylist === true,
          // Same opt-out normalisation as sanitize(): missing → true.
          allowFolderSelector: owner?.allowFolderSelector !== false,
          allowShuffle: owner?.allowShuffle !== false,
          allowTrackList: owner?.allowTrackList === true,
          counts,
          sizeBytes,
        }
      })
      return json(res, out)
    }

    // POST /admin/clients — create folder + user, return one-time password
    if (pathname === '/admin/clients' && req.method === 'POST') {
      const body = await readBody(req)
      const name = String(body.name || '').trim()
      if (!name) return json(res, { error: 'Укажите имя клиента' }, 400)
      // Mode B ("single playlist"): one "all" folder, played all day with no schedule.
      // Mode A (default): the three time-of-day folders. Absent flag → Mode A (back-compat).
      const singlePlaylist = body.single_playlist === true || body.singlePlaylist === true
      const folderId = uniqueFolderId(name, id => getUsers().some(u => u.folderId === id))
      const username = uniqueUsername(folderId, n => !!findUser(n))
      const password = generatePassword()
      try {
        createClientFolders(folderId, singlePlaylist)
      } catch (e) {
        return json(res, { error: `Не удалось создать папку: ${/** @type {Error} */ (e).message}` }, 500)
      }
      // Feature flags default to true when absent (opt-out, not opt-in).
      const flags = readFlags(body)
      const allowFolderSelector = flags.allowFolderSelector ?? true
      const allowShuffle = flags.allowShuffle ?? true
      const allowTrackList = flags.allowTrackList ?? false   // opt-IN, см. sanitize()
      const newUser = {
        username, name, role: 'user',
        categories: singlePlaylist ? [ALL_CATEGORY] : [...CATEGORIES],
        folderId, singlePlaylist,
        allowFolderSelector, allowShuffle, allowTrackList,
        ...hashPassword(password),
      }
      addUser(newUser)
      await saveUsers()
      return json(res, { folderId, name, username, password, singlePlaylist, allowFolderSelector, allowShuffle, allowTrackList }, 201)
    }

    // POST /admin/clients/:folderId/reset-password
    const rp = pathname.match(/^\/admin\/clients\/([^/]+)\/reset-password$/)
    if (rp && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(rp[1]))
      if (!folderId) return json(res, { error: 'Folder not found' }, 404)
      const owner = getUsers().find(u => u.folderId === folderId)
      if (!owner) return json(res, { error: 'У этой папки нет пользователя' }, 404)
      const password = generatePassword()
      Object.assign(owner, hashPassword(password))
      owner.weakPassword = false
      await saveUsers()
      return json(res, { username: owner.username, password })
    }

    // GET /admin/clients/:folderId/tracks — full track listing per category
    const tl = pathname.match(/^\/admin\/clients\/([^/]+)\/tracks$/)
    if (tl && req.method === 'GET') {
      const folderId = safeSegment(safeDecode(tl[1]))
      if (!folderId || !folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      const owner = getUsers().find(u => u.folderId === folderId)
      const cats = owner?.singlePlaylist ? [ALL_CATEGORY] : CATEGORIES
      /** @type {Record<string, any>} */
      const out = {}
      for (const cat of cats) out[cat] = scanFolder(folderId, cat)
      return json(res, out)
    }

    // POST /admin/clients/:folderId/upload?category=...
    const up = pathname.match(/^\/admin\/clients\/([^/]+)\/upload$/)
    if (up && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(up[1]))
      const category = String(parsed.searchParams.get('category') || '')
      if (!folderId || !folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      if (!VALID_CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      return handleUpload(req, res, folderId, category)
    }

    // POST /admin/clients/:folderId/classify — stage a folder + run VEclassify
    const cl = pathname.match(/^\/admin\/clients\/([^/]+)\/classify$/)
    if (cl && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(cl[1]))
      if (!folderId || !folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      // Time-of-day classification is meaningless for single-playlist ('all') clients.
      const owner = getUsers().find(u => u.folderId === folderId)
      if (owner?.singlePlaylist) return json(res, { error: 'Классификатор доступен только для режима «по времени суток»' }, 400)
      return handleClassifyUpload(req, res, folderId)
    }

    // POST /admin/clients/:folderId/:category/:file/move — relocate one track
    const mv = pathname.match(/^\/admin\/clients\/([^/]+)\/([^/]+)\/(.+)\/move$/)
    if (mv && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(mv[1]))
      const category = safeSegment(safeDecode(mv[2]))
      const filename = safeSegment(safeDecode(mv[3]))
      if (!category || !VALID_CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      if (!folderId || !folderExists(folderId) || !filename) return json(res, { error: 'Track not found' }, 404)
      const srcPath = path.join(folderPath(folderId), category, filename)
      if (!fs.existsSync(srcPath)) return json(res, { error: 'Track not found' }, 404)

      const body        = await readBody(req)
      const toFolderId  = safeSegment(body.toFolderId)
      const toCategory  = safeSegment(body.toCategory)
      if (!toFolderId || !folderExists(toFolderId))        return json(res, { error: 'Целевая папка не найдена' }, 400)
      if (!toCategory || !VALID_CATEGORIES.includes(toCategory)) return json(res, { error: 'Invalid target category' }, 400)

      // No-op move onto itself
      if (toFolderId === folderId && toCategory === category) {
        return json(res, { ok: true, filename, folderId, category })
      }
      const destDir = path.join(folderPath(toFolderId), toCategory)
      try {
        fs.mkdirSync(destDir, { recursive: true })
        const finalName = claimName(destDir, filename)
        moveFile(srcPath, path.join(destDir, finalName))
        return json(res, { ok: true, filename: finalName, folderId: toFolderId, category: toCategory })
      } catch (e) {
        return json(res, { error: `Не удалось переместить: ${/** @type {Error} */ (e).message}` }, 500)
      }
    }

    // DELETE /admin/clients/:folderId/:category/:file — delete one track
    const td = pathname.match(/^\/admin\/clients\/([^/]+)\/([^/]+)\/(.+)$/)
    if (td && req.method === 'DELETE') {
      const folderId = safeSegment(safeDecode(td[1]))
      const category = safeSegment(safeDecode(td[2]))
      const filename = safeSegment(safeDecode(td[3]))
      if (!category || !VALID_CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      if (!folderId || !folderExists(folderId) || !filename) return json(res, { error: 'Track not found' }, 404)
      const filePath = path.join(folderPath(folderId), category, filename)
      if (!fs.existsSync(filePath)) return json(res, { error: 'Track not found' }, 404)
      try {
        fs.unlinkSync(filePath)
        return json(res, { ok: true })
      } catch (e) {
        return json(res, { error: `Не удалось удалить: ${/** @type {Error} */ (e).message}` }, 500)
      }
    }

    // DELETE /admin/clients/:folderId — remove folder + bound user(s)
    const cd = pathname.match(/^\/admin\/clients\/([^/]+)$/)
    if (cd && req.method === 'DELETE') {
      const folderId = safeSegment(safeDecode(cd[1]))
      if (!folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      const bound = getUsers().filter(u => u.folderId === folderId)
      // Never allow a folder deletion to take down the last admin
      const admins = getUsers().filter(u => u.role === 'admin')
      if (bound.some(u => u.role === 'admin') && admins.every(a => bound.includes(a))) {
        return json(res, { error: 'Нельзя удалить: это сломает единственного админа' }, 400)
      }
      try {
        fs.rmSync(folderPath(folderId), { recursive: true, force: true })
      } catch (e) {
        return json(res, { error: `Не удалось удалить папку: ${/** @type {Error} */ (e).message}` }, 500)
      }
      setUsers(getUsers().filter(u => u.folderId !== folderId))
      await saveUsers()
      return json(res, { ok: true })
    }

    // PUT/DELETE /admin/users/:name
    const um = pathname.match(/^\/admin\/users\/(.+)$/)
    if (um) {
      const target = findUser(safeDecode(um[1]) ?? '')
      if (!target) return json(res, { error: 'User not found' }, 404)

      if (req.method === 'PUT') {
        const body = await readBody(req)
        if (body.password) {
          Object.assign(target, hashPassword(body.password))
          target.weakPassword = target.role === 'admin' && String(body.password) === 'admin'
        }
        if (Array.isArray(body.categories)) target.categories = cleanCats(body.categories)
        // Only keys present as booleans are applied; absent keys keep the stored value.
        Object.assign(target, readFlags(body))
        if ('folderId' in body) {
          const fid = body.folderId ? safeSegment(body.folderId) : null
          if (body.folderId && !folderExists(fid)) return json(res, { error: 'Folder not found' }, 400)
          target.folderId = fid
        }
        if (body.role === 'admin' || body.role === 'user') {
          // never strip the last admin of admin rights
          if (target.role === 'admin' && body.role === 'user' && getUsers().filter(u => u.role === 'admin').length <= 1) {
            return json(res, { error: 'Cannot demote the last admin' }, 400)
          }
          target.role = body.role
        }
        await saveUsers()
        return json(res, sanitize(target))
      }

      if (req.method === 'DELETE') {
        if (target.role === 'admin' && getUsers().filter(u => u.role === 'admin').length <= 1) {
          return json(res, { error: 'Cannot delete the last admin' }, 400)
        }
        setUsers(getUsers().filter(u => u !== target))
        await saveUsers()
        return json(res, { ok: true })
      }
    }

    // ── Classify batches ──────────────────────────────────────────────────────

    // POST /admin/classify/:batchId/confirm — distribute staged files into MUSIC_ROOT/<folderId>/<cat>
    const cf = pathname.match(/^\/admin\/classify\/([^/]+)\/confirm$/)
    if (cf && req.method === 'POST') {
      const batch = getBatch(safeDecode(cf[1]) ?? '')
      if (!batch)                          return json(res, { error: 'Batch not found' }, 404)
      if (batch.status !== 'ready')        return json(res, { error: 'Батч ещё не готов' }, 409)
      if (!folderExists(batch.folderId))   return json(res, { error: 'Папка клиента не найдена' }, 409)

      batch.status = 'confirming'
      persistBatches()

      const stageDir = path.join(INCOMING_DIR, batch.batchId)
      const moved  = []
      const errors = []
      const leftover = []   // tracks that failed to move — keep them staged for a retry
      for (const t of batch.tracks) {
        const cat = normalizeCat(t.override ?? t.category)
        // The filename comes from the classifier's JSON — re-check it here so a
        // malformed/hostile entry ('..', a path) can never escape the staging dir.
        const stagedName = safeSegment(t.filename)
        if (!stagedName) { errors.push({ filename: String(t.filename), error: 'недопустимое имя файла' }); leftover.push(t); continue }
        const src = path.join(stageDir, stagedName)
        try {
          if (!fs.existsSync(src)) { errors.push({ filename: t.filename, error: 'файл отсутствует в staging' }); continue }
          const destDir = path.join(folderPath(batch.folderId), cat)
          fs.mkdirSync(destDir, { recursive: true })
          const finalName = claimName(destDir, stagedName)
          moveFile(src, path.join(destDir, finalName))
          moved.push({ filename: finalName, category: cat })
        } catch (e) {
          errors.push({ filename: t.filename, error: /** @type {Error} */ (e).message })
          leftover.push(t)
        }
      }

      if (errors.length === 0) {
        // Full success → purge staging, drop the batch.
        purgeStagingDir(batch.batchId)
        deleteBatch(batch.batchId)
      } else {
        // Partial success → keep the batch (only the failed tracks remain) so the
        // admin can retry confirm without re-uploading.
        batch.tracks = leftover
        batch.status = 'ready'
      }
      persistBatches()
      return json(res, { ok: errors.length === 0, moved, errors })
    }

    // GET /admin/classify/:batchId/track/:filename/audio — preview stream (Range)
    const au = pathname.match(/^\/admin\/classify\/([^/]+)\/track\/(.+)\/audio$/)
    if (au && req.method === 'GET') {
      const batch = getBatch(safeDecode(au[1]) ?? '')
      if (!batch) return json(res, { error: 'Batch not found' }, 404)
      const fn = safeSegment(safeDecode(au[2]))
      if (!fn) { res.writeHead(400); res.end('Invalid filename'); return }
      const filePath = path.join(INCOMING_DIR, batch.batchId, fn)
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }
      try {
        streamAudio(req, res, filePath)
      } catch (e) {
        if (!res.headersSent) { res.writeHead(500); res.end('Stream error') } else res.destroy()
      }
      return
    }

    // PUT /admin/classify/:batchId/track/:filename — override a staged track's category
    const tp = pathname.match(/^\/admin\/classify\/([^/]+)\/track\/(.+)$/)
    if (tp && req.method === 'PUT') {
      const batch = getBatch(safeDecode(tp[1]) ?? '')
      if (!batch) return json(res, { error: 'Batch not found' }, 404)
      const fn = safeSegment(safeDecode(tp[2]))
      const body = await readBody(req)
      const category = String(body.category || '')
      if (!CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      const track = batch.tracks.find(t => t.filename === fn)
      if (!track) return json(res, { error: 'Track not found' }, 404)
      track.override = category
      persistBatches()
      return json(res, track)
    }

    // GET / POST(retry) / DELETE(cancel) /admin/classify/:batchId
    const bm = pathname.match(/^\/admin\/classify\/([^/]+)$/)
    if (bm) {
      const batch = getBatch(safeDecode(bm[1]) ?? '')
      if (req.method === 'GET') {
        if (!batch) return json(res, { error: 'Batch not found' }, 404)
        return json(res, batchView(batch))
      }
      if (req.method === 'POST') {   // retry on the already-staged files
        if (!batch) return json(res, { error: 'Batch not found' }, 404)
        // Only a failed batch may be re-run. Re-classifying a 'ready' batch would
        // overwrite batch.tracks and silently discard every manual override the
        // admin had already set (the spec allows a re-run only when the status is
        // neither 'classifying' nor 'ready').
        if (batch.status !== 'error') {
          return json(res, {
            error: batch.status === 'ready'
              ? 'Батч уже классифицирован — отмените его, чтобы запустить заново'
              : 'Классификация уже идёт',
          }, 409)
        }
        runClassify(batch)
        return json(res, { batchId: batch.batchId, status: 'classifying' }, 202)
      }
      if (req.method === 'DELETE') {   // cancel at any stage
        if (!batch) return json(res, { error: 'Batch not found' }, 404)
        batch.canceled = true
        // Kills the classifier first (else librosa keeps reading the very files
        // we delete, and on Windows its handles make the removal fail), then
        // retries the removal a few times before giving up to the boot sweep.
        purgeStagingDir(batch.batchId)
        deleteBatch(batch.batchId)
        persistBatches()
        return json(res, { ok: true })
      }
    }

    return json(res, { error: 'Not found' }, 404)
  }

  // ── Everything below requires a valid user ──────────────────────────────────
  const me = authUser(req, parsed)
  if (!me) return json(res, { error: 'Unauthorized' }, 401)
  const allowed = cleanCats(me.categories)

  // GET /tracks?category=...
  if (pathname === '/tracks') {
    const cat  = parsed.searchParams.get('category')
    const time = getTimeCategory()
    const active =
      (cat && allowed.includes(cat)) ? cat :
      allowed.includes(time)         ? time :
      allowed[0]
    return json(res, active ? tracksForCategory(me, active) : [])
  }

  // GET /library — allowed categories of the user's folder (admin: all folders)
  if (pathname === '/library') {
    /** @type {Record<string, any>} */
    const library = {}
    for (const cat of allowed) library[cat] = tracksForCategory(me, cat)
    return json(res, library)
  }

  // GET /music/:folder/:category/:filename  (token-protected, folder- and category-gated)
  const m = pathname.match(/^\/music\/([^/]+)\/([^/]+)\/(.+)$/)
  if (m) {
    const folder = safeSegment(safeDecode(m[1]))   // rejects traversal ('', '.', '..')
    const cat    = safeSegment(safeDecode(m[2]))
    if (!folder)                   { res.writeHead(400); res.end('Invalid folder'); return }
    if (!cat || !VALID_CATEGORIES.includes(cat)) { res.writeHead(400); res.end('Invalid category'); return }
    // Admin may stream any category (incl. 'all') of any folder — needed for the
    // admin preview of single-playlist clients. Clients are gated to the
    // categories they're allowed AND to their own folder.
    if (me.role !== 'admin') {
      if (!allowed.includes(cat))  { res.writeHead(403); res.end('Forbidden'); return }
      if (me.folderId !== folder)  { res.writeHead(403); res.end('Forbidden'); return }
    }
    const filename = safeSegment(safeDecode(m[3]))
    if (!filename) { res.writeHead(400); res.end('Invalid filename'); return }
    const filePath = path.join(MUSIC_ROOT, folder, cat, filename)
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }
    try {
      streamAudio(req, res, filePath)
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500); res.end('Stream error') }
      else res.destroy()
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
}
