/**
 * server.mjs — VEplay local music server
 * Pure Node.js built-ins — no npm packages required.
 * Serves audio files with Range request support for seeking.
 *
 * Endpoints:
 *   GET /tracks?category=morning|day|evening  — tracks for given (or auto time-based) category
 *   GET /library                              — all tracks grouped by category
 *   GET /time-category                        — { category, hour } for current time
 *   GET /music/:category/:filename            — stream audio file (supports Range)
 */
import http   from 'node:http'
import fs     from 'node:fs'
import path   from 'node:path'
import { URL } from 'node:url'

const PORT       = 3001
const MUSIC_ROOT = 'E:\\01_VEgroove_Clients_music\\Mates'
const CATEGORIES = ['morning', 'day', 'evening']
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac'])

const MIME = {
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
}

// ── helpers ──────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
  res.setHeader('Access-Control-Expose-Headers','Content-Range, Accept-Ranges, Content-Length')
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
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
        const base  = path.basename(filename, path.extname(filename))
        const dash  = base.indexOf(' - ')
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

const server = http.createServer((req, res) => {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const parsed   = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = parsed.pathname

  // GET /tracks?category=...
  if (pathname === '/tracks') {
    const cat    = parsed.searchParams.get('category')
    const active = CATEGORIES.includes(cat) ? cat : getTimeCategory()
    return json(res, scanFolder(active))
  }

  // GET /library
  if (pathname === '/library') {
    const library = {}
    for (const cat of CATEGORIES) library[cat] = scanFolder(cat)
    return json(res, library)
  }

  // GET /time-category
  if (pathname === '/time-category') {
    const cat = getTimeCategory()
    return json(res, { category: cat, hour: new Date().getHours() })
  }

  // GET /music/:category/:filename
  const m = pathname.match(/^\/music\/([^/]+)\/(.+)$/)
  if (m) {
    const [, cat, encodedFile] = m
    if (!CATEGORIES.includes(cat)) {
      res.writeHead(400); res.end('Invalid category'); return
    }
    const filename = decodeURIComponent(encodedFile)
    const filePath = path.join(MUSIC_ROOT, cat, filename)
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return
    }
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
  console.log(`Music root     →  ${MUSIC_ROOT}\n`)
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
