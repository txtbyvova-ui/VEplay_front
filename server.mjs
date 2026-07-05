/**
 * server.mjs — VEplay local music server  (+ auth & admin)
 * Pure Node.js built-ins — no npm packages required.
 *
 * Auth model (strict):
 *   - passwords stored as scrypt hashes (salt + hash) in users.json
 *   - login issues an HMAC-signed token; every protected route requires it
 *   - each user is granted access to a SUBSET of categories (morning/day/evening)
 *   - audio streaming is token-protected: a folder cannot be opened by URL alone
 *
 * Public:
 *   POST /auth/login            { username, password }      -> { token, user }
 *   GET  /auth/me               (Bearer)                    -> { user }
 *
 * Player (Bearer token):
 *   GET  /library                                           -> tracks grouped by ALLOWED category
 *   GET  /tracks?category=...                               -> tracks for an allowed category
 *   GET  /music/:category/:filename?token=...               -> stream audio (Range supported)
 *
 * Admin (Bearer token, role=admin):
 *   GET    /admin/users                                     -> [ { username, role, categories } ]
 *   GET    /admin/categories                                -> [ { id, exists, count } ]
 *   POST   /admin/users        { username, password, categories, role }
 *   PUT    /admin/users/:name  { password?, categories?, role? }
 *   DELETE /admin/users/:name
 */
import http   from 'node:http'
import fs     from 'node:fs'
import path   from 'node:path'
import crypto from 'node:crypto'
import { URL }           from 'node:url'
import { fileURLToPath } from 'node:url'

// ── config ───────────────────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PORT       = Number(process.env.PORT) || 3001
// Music root: override with MUSIC_ROOT env var, else the bundled demo folder.
const MUSIC_ROOT = process.env.MUSIC_ROOT || path.resolve(__dirname, '..', 'VEplay_demo')
const CATEGORIES = ['morning', 'day', 'evening']
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac'])

const USERS_FILE  = path.join(__dirname, 'users.json')
const SECRET_FILE = path.join(__dirname, '.secret')
const TOKEN_TTL   = 1000 * 60 * 60 * 24 * 30   // 30 days

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

// ── users store ──────────────────────────────────────────────────────────────

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (Array.isArray(data.users)) return data.users
  } catch { /* fall through to seed */ }
  return null
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2))
}

let users = loadUsers()
if (!users) {
  // First run: seed a default admin (change the password immediately!)
  const adminUser = process.env.ADMIN_USER || 'admin'
  const adminPass = process.env.ADMIN_PASS || 'admin'
  users = [{ username: adminUser, role: 'admin', categories: [...CATEGORIES], ...hashPassword(adminPass) }]
  saveUsers(users)
  console.log('\n  ⚠  Seeded default admin →  login: %s   password: %s', adminUser, adminPass)
  console.log('     Change it in the admin panel right away.\n')
}

const findUser   = (name) => users.find(u => u.username.toLowerCase() === String(name || '').toLowerCase())
const sanitize   = (u) => ({ username: u.username, role: u.role, categories: u.categories })
const cleanCats  = (cats) => Array.isArray(cats) ? [...new Set(cats)].filter(c => CATEGORIES.includes(c)) : []

// ── helpers ──────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers','Content-Range, Accept-Ranges, Content-Length')
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
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

function scanFolder(category) {
  const folderPath = path.join(MUSIC_ROOT, category)
  try {
    return fs.readdirSync(folderPath)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .map((filename, i) => {
        const base   = path.basename(filename, path.extname(filename))
        const dash   = base.indexOf(' - ')
        const title  = dash > 0 ? base.slice(dash + 3).trim() : base
        const artist = dash > 0 ? base.slice(0, dash).trim()  : 'Unknown'
        return {
          id:       `${category}-${i}`,
          filename,
          title,
          artist,
          category,
          src: `http://localhost:${PORT}/music/${category}/${encodeURIComponent(filename)}`,
        }
      })
  } catch {
    return []
  }
}

function streamAudio(req, res, filePath) {
  const ext   = path.extname(filePath).toLowerCase()
  const mime  = MIME[ext] ?? 'application/octet-stream'
  const total = fs.statSync(filePath).size
  const range = req.headers['range']

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-')
    const start = parseInt(startStr, 10)
    const end   = endStr ? parseInt(endStr, 10) : total - 1
    const chunk = end - start + 1
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   mime,
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
    })
    fs.createReadStream(filePath).pipe(res)
  }
}

// ── request handler ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const parsed   = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = parsed.pathname

  // ── POST /auth/login ────────────────────────────────────────────────────────
  if (pathname === '/auth/login' && req.method === 'POST') {
    const { username, password } = await readBody(req)
    const user = findUser(username)
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return json(res, { error: 'Invalid login or password' }, 401)
    }
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

    // GET /admin/categories — categories that exist on disk + track counts
    if (pathname === '/admin/categories' && req.method === 'GET') {
      return json(res, CATEGORIES.map(id => {
        const list = scanFolder(id)
        return { id, exists: fs.existsSync(path.join(MUSIC_ROOT, id)), count: list.length }
      }))
    }

    // GET /admin/users
    if (pathname === '/admin/users' && req.method === 'GET') {
      return json(res, users.map(sanitize))
    }

    // POST /admin/users — create
    if (pathname === '/admin/users' && req.method === 'POST') {
      const body = await readBody(req)
      const username = String(body.username || '').trim()
      if (!username || !body.password) return json(res, { error: 'username and password are required' }, 400)
      if (findUser(username)) return json(res, { error: 'User already exists' }, 409)
      const role = body.role === 'admin' ? 'admin' : 'user'
      const newUser = { username, role, categories: cleanCats(body.categories), ...hashPassword(body.password) }
      users.push(newUser)
      saveUsers(users)
      return json(res, sanitize(newUser), 201)
    }

    // PUT/DELETE /admin/users/:name
    const um = pathname.match(/^\/admin\/users\/(.+)$/)
    if (um) {
      const target = findUser(decodeURIComponent(um[1]))
      if (!target) return json(res, { error: 'User not found' }, 404)

      if (req.method === 'PUT') {
        const body = await readBody(req)
        if (body.password) Object.assign(target, hashPassword(body.password))
        if (Array.isArray(body.categories)) target.categories = cleanCats(body.categories)
        if (body.role === 'admin' || body.role === 'user') {
          // never strip the last admin of admin rights
          if (target.role === 'admin' && body.role === 'user' && users.filter(u => u.role === 'admin').length <= 1) {
            return json(res, { error: 'Cannot demote the last admin' }, 400)
          }
          target.role = body.role
        }
        saveUsers(users)
        return json(res, sanitize(target))
      }

      if (req.method === 'DELETE') {
        if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
          return json(res, { error: 'Cannot delete the last admin' }, 400)
        }
        users = users.filter(u => u !== target)
        saveUsers(users)
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
    return json(res, active ? scanFolder(active) : [])
  }

  // GET /library — only allowed categories
  if (pathname === '/library') {
    const library = {}
    for (const cat of allowed) library[cat] = scanFolder(cat)
    return json(res, library)
  }

  // GET /music/:category/:filename  (token-protected, category-gated)
  const m = pathname.match(/^\/music\/([^/]+)\/(.+)$/)
  if (m) {
    const cat = m[1]
    if (!CATEGORIES.includes(cat)) { res.writeHead(400); res.end('Invalid category'); return }
    if (!allowed.includes(cat))    { res.writeHead(403); res.end('Forbidden'); return }
    const filename = path.basename(decodeURIComponent(m[2]))   // basename blocks path traversal
    const filePath = path.join(MUSIC_ROOT, cat, filename)
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }
    try {
      streamAudio(req, res, filePath)
    } catch (e) {
      res.writeHead(500); res.end(String(e))
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`\nVEplay server  →  http://localhost:${PORT}`)
  console.log(`Music root     →  ${MUSIC_ROOT}`)
  console.log(`Users          →  ${users.length}  (${users.filter(u => u.role === 'admin').length} admin)\n`)
  for (const cat of CATEGORIES) {
    const dir = path.join(MUSIC_ROOT, cat)
    try {
      const n = fs.readdirSync(dir).filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase())).length
      console.log(`  ${cat.padEnd(10)}  ${n} tracks`)
    } catch {
      console.log(`  ${cat.padEnd(10)}  [folder not found: ${dir}]`)
    }
  }
  console.log()
})
