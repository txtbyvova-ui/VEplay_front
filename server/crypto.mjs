// @ts-check
/**
 * crypto.mjs — secret loading, password hashing, HMAC-signed tokens.
 *
 * Auth model (strict):
 *   - passwords stored as scrypt hashes (salt + hash) in users.json
 *   - login issues an HMAC-signed token; every protected route requires it
 */
import fs     from 'node:fs'
import crypto from 'node:crypto'
import { DATA_DIR, SECRET_FILE } from './config.mjs'

export function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    const secret = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
    return secret
  }
}
export const SECRET = loadSecret()

/**
 * @param {string} password
 * @returns {{ salt: string, hash: string }}
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return { salt, hash }
}

/**
 * @param {string | undefined} password
 * @param {string | undefined} salt
 * @param {string | undefined} hash
 * @returns {boolean}
 */
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false
  const test = crypto.scryptSync(String(password), salt, 64)
  const real = Buffer.from(hash, 'hex')
  return test.length === real.length && crypto.timingSafeEqual(test, real)
}

/**
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

/**
 * @param {unknown} token
 * @returns {Record<string, any> | null}
 */
export function verifyToken(token) {
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
export function generatePassword() {
  return crypto.randomBytes(12).toString('base64url')
}

// Fixed decoy hash — verified against when the username doesn't exist, so the
// login path spends equal CPU whether or not the user is real.
export const DECOY = hashPassword(crypto.randomBytes(16).toString('hex'))
