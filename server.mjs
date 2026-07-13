/**
 * server.mjs — VEplay music server  (auth, multi-tenant folders, admin)
 * Node.js built-ins + busboy (multipart upload parsing only).
 *
 * Auth model (strict):
 *   - passwords stored as scrypt hashes (salt + hash) in users.json
 *   - login issues an HMAC-signed token; every protected route requires it
 *   - login is rate-limited per IP (in-memory)
 *
 * Multi-tenancy: 1 client = 1 folder
 *   MUSIC_ROOT/<folderId>/{morning,day,evening}/*.mp3
 *   - each non-admin user is bound to ONE folder (users.json → folderId)
 *   - a user only ever sees / streams their own folder; admin sees all
 *   - legacy users without folderId keep working (empty library until
 *     an admin assigns them a folder)
 *
 * Public:
 *   POST /auth/login            { username, password }      -> { token, user }
 *   GET  /auth/me               (Bearer)                    -> { user }
 *
 * Player (Bearer token):
 *   GET  /library                                           -> tracks grouped by category (own folder; admin: all folders merged)
 *   GET  /tracks?category=...                               -> tracks for a category
 *   GET  /music/:folder/:cat/:file?token=...                -> stream audio (Range supported, folder-gated)
 *
 * Admin (Bearer token, role=admin):
 *   GET    /admin/users                                     -> [ { username, role, categories, folderId } ]
 *   GET    /admin/categories                                -> [ { id, exists, count } ]  (aggregated over folders)
 *   POST   /admin/users        { username, password, categories, role, folderId? }
 *   PUT    /admin/users/:name  { password?, categories?, role?, folderId? }
 *   DELETE /admin/users/:name
 *   GET    /admin/clients                                   -> [ { folderId, name, username, counts, sizeBytes } ]
 *   POST   /admin/clients      { name }                     -> { folderId, name, username, password }  (password shown ONCE)
 *   DELETE /admin/clients/:folderId                         -> remove folder + its user
 *   POST   /admin/clients/:folderId/reset-password          -> { username, password }     (password shown ONCE)
 *   GET    /admin/clients/:folderId/tracks                  -> { morning: [..], day: [..], evening: [..] }
 *   POST   /admin/clients/:folderId/upload?category=...     -> multipart mp3 upload (≤20MB each)
 *   DELETE /admin/clients/:folderId/:category/:file         -> delete one track
 */
import http   from 'node:http'
import fs     from 'node:fs'
import path   from 'node:path'
import crypto from 'node:crypto'
import { URL }           from 'node:url'
import { fileURLToPath } from 'node:url'
import Busboy from 'busboy'

// ── config ───────────────────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PORT       = Number(process.env.PORT) || 3001
const HOST       = process.env.HOST || '0.0.0.0'   // set 127.0.0.1 behind a reverse proxy
// Music root: override with MUSIC_ROOT env var. Layout: <MUSIC_ROOT>/<folderId>/<category>/*.mp3
const MUSIC_ROOT = process.env.MUSIC_ROOT || path.resolve(__dirname, '..', 'VEplay_demo')
// Where users.json / .secret live (persistent, outside the repo in production)
const DATA_DIR   = process.env.DATA_DIR || __dirname
const CATEGORIES = ['morning', 'day', 'evening']
const ALL_CATEGORY = 'all'
// Every valid on-disk category folder name: the three time slots + the single-playlist folder.
// Used for path validation, streaming and scanning (the time-of-day schedule itself stays CATEGORIES).
const VALID_CATEGORIES = [...CATEGORIES, ALL_CATEGORY]
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac'])

const USERS_FILE  = path.join(DATA_DIR, 'users.json')
const SECRET_FILE = path.join(DATA_DIR, '.secret')
const TOKEN_TTL   = 1000 * 60 * 60 * 24 * 30   // 30 days

const UPLOAD_MAX_FILE  = 20 * 1024 * 1024      // 20MB per file
const UPLOAD_MAX_FILES = 20                    // per request

const MIME = {
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
}

// ── crypto: secret, password hashing, signed tokens ──────────────────────────

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    const secret = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
    return secret
  }
}
const SECRET = loadSecret()

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false
  const test = crypto.scryptSync(String(password), salt, 64)
  const real = Buffer.from(hash, 'hex')
  return test.length === real.length && crypto.timingSafeEqual(test, real)
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const body = token.slice(0, dot)
  const sig  = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (payload.exp && Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

// Crypto-strong readable password: base64url of 12 random bytes → 16 chars
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url')
}

// Fixed decoy hash — verified against when the username doesn't exist, so the
// login path spends equal CPU whether or not the user is real.
const DECOY = hashPassword(crypto.randomBytes(16).toString('hex'))

// ── users store ──────────────────────────────────────────────────────────────

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (Array.isArray(data.users)) return data.users
  } catch { /* fall through to seed */ }
  return null
}

// All users.json writes are serialized through this promise chain so that
// concurrent admin requests (upload + CRUD) never interleave writes.
let usersWriteQueue = Promise.resolve()
function saveUsers(snapshot) {
  const data = JSON.stringify({ users: snapshot }, null, 2)
  usersWriteQueue = usersWriteQueue
    .then(() => {
      const tmp = USERS_FILE + '.tmp'
      return fs.promises.writeFile(tmp, data).then(() => fs.promises.rename(tmp, USERS_FILE))
    })
    .catch(e => console.error('users.json write failed:', e))
  return usersWriteQueue
}

let users = loadUsers()
if (!users) {
  // First run: seed a default admin (change the password immediately!)
  const adminUser = process.env.ADMIN_USER || 'admin'
  const adminPass = process.env.ADMIN_PASS || 'admin'
  users = [{ username: adminUser, role: 'admin', categories: [...CATEGORIES], ...hashPassword(adminPass) }]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2))
  console.log('\n  ⚠  Seeded default admin →  login: %s   password: %s', adminUser, adminPass)
  console.log('     Change it in the admin panel right away.\n')
}

const findUser   = (name) => users.find(u => u.username.toLowerCase() === String(name || '').toLowerCase())
const sanitize   = (u) => ({
  username: u.username, role: u.role, categories: u.categories,
  folderId: u.folderId ?? null, name: u.name ?? null,
  singlePlaylist: u.singlePlaylist === true,
  weakPassword: u.weakPassword === true,
})
const cleanCats  = (cats) => Array.isArray(cats) ? [...new Set(cats)].filter(c => VALID_CATEGORIES.includes(c)) : []

// ── login rate limit (in-memory, per IP) ─────────────────────────────────────

const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS    = 15 * 60 * 1000
const loginAttempts = new Map()   // ip -> { count, resetAt }

function clientIp(req) {
  const remote = req.socket.remoteAddress || ''
  // Trust X-Forwarded-For only for connections from the local reverse proxy.
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const xff = req.headers['x-forwarded-for']
  if (isLocal && typeof xff === 'string' && xff.length) {
    // Caddy APPENDS the real peer, so the real client is the RIGHTMOST hop.
    // Taking the leftmost would let a client spoof its own IP and dodge the limiter.
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return remote
}

function loginRateLimited(ip) {
  const now = Date.now()
  const rec = loginAttempts.get(ip)
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return false
  }
  rec.count++
  return rec.count > LOGIN_MAX_ATTEMPTS
}

// Periodic sweep so the map cannot grow without bound
setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of loginAttempts) if (now > rec.resetAt) loginAttempts.delete(ip)
}, LOGIN_WINDOW_MS).unref()

// ── helpers ──────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers','Content-Range, Accept-Ranges, Content-Length')
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

// Resolve the authenticated user for a request (Authorization header or ?token=)
function authUser(req, parsed) {
  const header = req.headers['authorization'] || ''
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : null
  const token = fromHeader || parsed.searchParams.get('token')
  const payload = verifyToken(token)
  if (!payload) return null
  return findUser(payload.u) || null
}

function getTimeCategory() {
  const h = new Date().getHours()
  if (h >= 6  && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'day'
  return 'evening'   // 18-23 and 0-5 treated as evening
}

// ── folders (multi-tenant) ───────────────────────────────────────────────────

// decodeURIComponent throws URIError on malformed %-escapes (e.g. "%zz").
// Return null instead so a bad URL becomes a 400/404, not a process crash.
function safeDecode(s) {
  try { return decodeURIComponent(String(s)) } catch { return null }
}

// One path segment from user input: basename + reject '', '.' and '..'
// (path.basename('..') === '..', so basename alone does NOT stop traversal)
function safeSegment(s) {
  const b = path.basename(String(s ?? ''))
  return b === '' || b === '.' || b === '..' ? null : b
}

// Resolve a client folder path strictly under MUSIC_ROOT
function folderPath(folderId) {
  return path.join(MUSIC_ROOT, safeSegment(folderId) ?? ' ')
}

function listFolderIds() {
  try {
    return fs.readdirSync(MUSIC_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

const folderExists = (folderId) => !!safeSegment(folderId) && fs.existsSync(folderPath(folderId))

// Cyrillic → latin for readable folder slugs
const TRANSLIT = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
  х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
}

function slugify(name) {
  const lat = String(name).toLowerCase().split('').map(ch => TRANSLIT[ch] ?? ch).join('')
  return lat.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function uniqueFolderId(name) {
  const base = slugify(name) || `client-${crypto.randomBytes(2).toString('hex')}`
  let id = base
  for (let n = 2; folderExists(id) || users.some(u => u.folderId === id); n++) id = `${base}-${n}`
  return id
}

function uniqueUsername(base) {
  let name = base
  for (let n = 2; findUser(name); n++) name = `${base}-${n}`
  return name
}

// Track filename → { title, artist } ("Artist - Title.mp3")
function scanFolder(folderId, category) {
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
function visibleFolders(user) {
  if (user.role === 'admin') return listFolderIds()
  return user.folderId && folderExists(user.folderId) ? [user.folderId] : []
}

function tracksForCategory(user, category) {
  const out = []
  for (const f of visibleFolders(user)) out.push(...scanFolder(f, category))
  return out
}

function folderStats(folderId) {
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

function createClientFolders(folderId, singlePlaylist = false) {
  const cats = singlePlaylist ? [ALL_CATEGORY] : CATEGORIES
  for (const cat of cats) fs.mkdirSync(path.join(folderPath(folderId), cat), { recursive: true })
}

// Strip anything dangerous from an uploaded filename; keep unicode letters
function sanitizeFilename(name) {
  const base = path.basename(String(name || ''))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200)
  return base
}

// Parse a single-range "bytes=" header into {start,end} clamped to [0,total-1].
// Supports suffix ranges ("bytes=-500"). Returns null for a full-content request,
// or 'invalid' for a malformed / unsatisfiable range (→ caller replies 416).
function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
  if (!m) return 'invalid'
  const [, a, b] = m
  if (a === '' && b === '') return 'invalid'

  let start, end
  if (a === '') {
    // suffix: last N bytes
    const n = parseInt(b, 10)
    if (!Number.isFinite(n) || n <= 0) return 'invalid'
    start = Math.max(0, total - n)
    end   = total - 1
  } else {
    start = parseInt(a, 10)
    end   = b === '' ? total - 1 : parseInt(b, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= total) return 'invalid'
  if (end >= total) end = total - 1
  return { start, end }
}

// Pipe a read stream to the response, tearing down the socket on async read
// errors (file deleted mid-stream, disk error) instead of leaving it to crash.
function pipeStream(stream, res) {
  stream.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Stream error') } else res.destroy() })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function streamAudio(req, res, filePath) {
  const ext   = path.extname(filePath).toLowerCase()
  const mime  = MIME[ext] ?? 'application/octet-stream'
  const total = fs.statSync(filePath).size
  const range = parseRange(req.headers['range'], total)

  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': mime })
    res.end()
    return
  }

  if (range) {
    const { start, end } = range
    const chunk = end - start + 1
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   mime,
    })
    pipeStream(fs.createReadStream(filePath, { start, end }), res)
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
    })
    pipeStream(fs.createReadStream(filePath), res)
  }
}

// ── multipart upload (busboy) ────────────────────────────────────────────────

function handleUpload(req, res, folderId, category) {
  const destDir = path.join(folderPath(folderId), category)
  fs.mkdirSync(destDir, { recursive: true })

  const uploaded = []
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

// ── request handler ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Top-level guard: any synchronous throw during routing (e.g. a malformed
  // request URL) becomes a 500 instead of an unhandled rejection that kills
  // the process. Individual routes still handle their own error cases.
  handleRequest(req, res).catch((e) => {
    console.error('request handler error:', e)
    if (!res.headersSent) { try { json(res, { error: 'Internal error' }, 500) } catch { /* ignore */ } }
    else { try { res.destroy() } catch { /* ignore */ } }
  })
})

async function handleRequest(req, res) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  let parsed
  try {
    parsed = new URL(req.url, `http://localhost:${PORT}`)
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
    if (!ok) {
      return json(res, { error: 'Invalid login or password' }, 401)
    }
    loginAttempts.delete(ip)   // successful login clears the counter
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
      return json(res, users.map(sanitize))
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
      const newUser = { username, role, categories: cleanCats(body.categories), folderId, ...hashPassword(body.password) }
      users.push(newUser)
      await saveUsers(users)
      return json(res, sanitize(newUser), 201)
    }

    // ── Clients: 1 client = 1 folder ──────────────────────────────────────────

    // GET /admin/clients — folders + bound user + stats
    if (pathname === '/admin/clients' && req.method === 'GET') {
      const out = listFolderIds().map(folderId => {
        const owner = users.find(u => u.folderId === folderId)
        const { counts, sizeBytes } = folderStats(folderId)
        return {
          folderId,
          name:     owner?.name ?? folderId,
          username: owner?.username ?? null,
          singlePlaylist: owner?.singlePlaylist === true,
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
      const folderId = uniqueFolderId(name)
      const username = uniqueUsername(folderId)
      const password = generatePassword()
      try {
        createClientFolders(folderId, singlePlaylist)
      } catch (e) {
        return json(res, { error: `Не удалось создать папку: ${e.message}` }, 500)
      }
      const newUser = {
        username, name, role: 'user',
        categories: singlePlaylist ? [ALL_CATEGORY] : [...CATEGORIES],
        folderId, singlePlaylist,
        ...hashPassword(password),
      }
      users.push(newUser)
      await saveUsers(users)
      return json(res, { folderId, name, username, password, singlePlaylist }, 201)
    }

    // POST /admin/clients/:folderId/reset-password
    const rp = pathname.match(/^\/admin\/clients\/([^/]+)\/reset-password$/)
    if (rp && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(rp[1]))
      if (!folderId) return json(res, { error: 'Folder not found' }, 404)
      const owner = users.find(u => u.folderId === folderId)
      if (!owner) return json(res, { error: 'У этой папки нет пользователя' }, 404)
      const password = generatePassword()
      Object.assign(owner, hashPassword(password))
      owner.weakPassword = false
      await saveUsers(users)
      return json(res, { username: owner.username, password })
    }

    // GET /admin/clients/:folderId/tracks — full track listing per category
    const tl = pathname.match(/^\/admin\/clients\/([^/]+)\/tracks$/)
    if (tl && req.method === 'GET') {
      const folderId = safeSegment(safeDecode(tl[1]))
      if (!folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      const owner = users.find(u => u.folderId === folderId)
      const cats = owner?.singlePlaylist ? [ALL_CATEGORY] : CATEGORIES
      const out = {}
      for (const cat of cats) out[cat] = scanFolder(folderId, cat)
      return json(res, out)
    }

    // POST /admin/clients/:folderId/upload?category=...
    const up = pathname.match(/^\/admin\/clients\/([^/]+)\/upload$/)
    if (up && req.method === 'POST') {
      const folderId = safeSegment(safeDecode(up[1]))
      const category = String(parsed.searchParams.get('category') || '')
      if (!folderExists(folderId))       return json(res, { error: 'Folder not found' }, 404)
      if (!VALID_CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      return handleUpload(req, res, folderId, category)
    }

    // DELETE /admin/clients/:folderId/:category/:file — delete one track
    const td = pathname.match(/^\/admin\/clients\/([^/]+)\/([^/]+)\/(.+)$/)
    if (td && req.method === 'DELETE') {
      const folderId = safeSegment(safeDecode(td[1]))
      const category = safeSegment(safeDecode(td[2]))
      const filename = safeSegment(safeDecode(td[3]))
      if (!VALID_CATEGORIES.includes(category)) return json(res, { error: 'Invalid category' }, 400)
      if (!folderExists(folderId) || !filename) return json(res, { error: 'Track not found' }, 404)
      const filePath = path.join(folderPath(folderId), category, filename)
      if (!fs.existsSync(filePath)) return json(res, { error: 'Track not found' }, 404)
      try {
        fs.unlinkSync(filePath)
        return json(res, { ok: true })
      } catch (e) {
        return json(res, { error: `Не удалось удалить: ${e.message}` }, 500)
      }
    }

    // DELETE /admin/clients/:folderId — remove folder + bound user(s)
    const cd = pathname.match(/^\/admin\/clients\/([^/]+)$/)
    if (cd && req.method === 'DELETE') {
      const folderId = safeSegment(safeDecode(cd[1]))
      if (!folderExists(folderId)) return json(res, { error: 'Folder not found' }, 404)
      const bound = users.filter(u => u.folderId === folderId)
      // Never allow a folder deletion to take down the last admin
      const admins = users.filter(u => u.role === 'admin')
      if (bound.some(u => u.role === 'admin') && admins.every(a => bound.includes(a))) {
        return json(res, { error: 'Нельзя удалить: это сломает единственного админа' }, 400)
      }
      try {
        fs.rmSync(folderPath(folderId), { recursive: true, force: true })
      } catch (e) {
        return json(res, { error: `Не удалось удалить папку: ${e.message}` }, 500)
      }
      users = users.filter(u => u.folderId !== folderId)
      await saveUsers(users)
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
        if ('folderId' in body) {
          const fid = body.folderId ? safeSegment(body.folderId) : null
          if (body.folderId && !folderExists(fid)) return json(res, { error: 'Folder not found' }, 400)
          target.folderId = fid
        }
        if (body.role === 'admin' || body.role === 'user') {
          // never strip the last admin of admin rights
          if (target.role === 'admin' && body.role === 'user' && users.filter(u => u.role === 'admin').length <= 1) {
            return json(res, { error: 'Cannot demote the last admin' }, 400)
          }
          target.role = body.role
        }
        await saveUsers(users)
        return json(res, sanitize(target))
      }

      if (req.method === 'DELETE') {
        if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
          return json(res, { error: 'Cannot delete the last admin' }, 400)
        }
        users = users.filter(u => u !== target)
        await saveUsers(users)
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
      allowed.includes(cat)  ? cat  :
      allowed.includes(time) ? time :
      allowed[0]
    return json(res, active ? tracksForCategory(me, active) : [])
  }

  // GET /library — allowed categories of the user's folder (admin: all folders)
  if (pathname === '/library') {
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
    if (!VALID_CATEGORIES.includes(cat)) { res.writeHead(400); res.end('Invalid category'); return }
    if (!allowed.includes(cat))    { res.writeHead(403); res.end('Forbidden'); return }
    // Folder gate: clients may only stream their own folder; admin — any
    if (me.role !== 'admin' && me.folderId !== folder) { res.writeHead(403); res.end('Forbidden'); return }
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

// Last-resort backstops: never let one bad request or a stream error on a
// piped socket take down the whole server (music for every venue).
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
process.on('uncaughtException',  (e) => console.error('uncaughtException:', e))

server.listen(PORT, HOST, () => {
  console.log(`\nVEplay server  →  http://${HOST}:${PORT}`)
  console.log(`Music root     →  ${MUSIC_ROOT}`)
  console.log(`Data dir       →  ${DATA_DIR}`)
  console.log(`Users          →  ${users.length}  (${users.filter(u => u.role === 'admin').length} admin)\n`)
  const folders = listFolderIds()
  if (!folders.length) {
    console.log('  [no client folders yet — create one in the admin panel]')
  }
  for (const f of folders) {
    const { counts, sizeBytes } = folderStats(f)
    const parts = CATEGORIES.map(c => `${c}: ${counts[c]}`).join('  ')
    console.log(`  ${f.padEnd(24)}  ${parts}  (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log()
})
