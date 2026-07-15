// @ts-check
/**
 * http.mjs — request/response helpers, login rate limiting, auth resolution.
 */
import { verifyToken } from './crypto.mjs'
import { findUser } from './users.mjs'

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

/** @param {ServerResponse} res */
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers','Content-Range, Accept-Ranges, Content-Length')
}

/**
 * @param {ServerResponse} res
 * @param {any} data
 * @param {number} [status]
 */
export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * @param {IncomingMessage} req
 * @returns {Promise<any>}
 */
export function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

// ── login rate limit (in-memory, per IP) ─────────────────────────────────────

const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS    = 15 * 60 * 1000
/** @type {Map<string, { count: number, resetAt: number }>} */
const loginAttempts = new Map()   // ip -> { count, resetAt }

/**
 * @param {IncomingMessage} req
 * @returns {string}
 */
export function clientIp(req) {
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

/**
 * @param {string} ip
 * @returns {boolean} true when the IP has exceeded the attempt cap
 */
export function loginRateLimited(ip) {
  const now = Date.now()
  const rec = loginAttempts.get(ip)
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return false
  }
  rec.count++
  return rec.count > LOGIN_MAX_ATTEMPTS
}

/** Clear an IP's attempt counter (a successful login resets it). @param {string} ip */
export function clearLoginAttempts(ip) {
  loginAttempts.delete(ip)
}

// Periodic sweep so the map cannot grow without bound
setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of loginAttempts) if (now > rec.resetAt) loginAttempts.delete(ip)
}, LOGIN_WINDOW_MS).unref()

// Resolve the authenticated user for a request (Authorization header or ?token=)
/**
 * @param {IncomingMessage} req
 * @param {URL} parsed
 * @returns {import('./users.mjs').User | null}
 */
export function authUser(req, parsed) {
  const header = req.headers['authorization'] || ''
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : null
  const token = fromHeader || parsed.searchParams.get('token')
  const payload = verifyToken(token)
  if (!payload) return null
  return findUser(payload.u) || null
}
