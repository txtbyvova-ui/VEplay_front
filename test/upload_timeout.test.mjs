/**
 * Proves the server's configurable HTTP request timeout is wired correctly, so a
 * slow/large upload no longer gets a 408 (the reported bug).
 *
 * Sends a raw HTTP request whose body arrives after a gap:
 *   - REQUEST_TIMEOUT_MS=800  → Node emits 408 (bug reproduced under a short cap)
 *   - REQUEST_TIMEOUT_MS=0     → request completes, no 408 (the fix)
 *
 * Run:  node test/upload_timeout.test.mjs
 */
import { spawn } from 'node:child_process'
import net  from 'node:net'
import fs   from 'node:fs'
import os   from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗', m) } }

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

let lastErr = ''
function startServer(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-to-'))
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', MUSIC_ROOT: path.join(tmp, 'm'), DATA_DIR: path.join(tmp, 'd'), ADMIN_USER: 'admin', ADMIN_PASS: 'admin', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  lastErr = ''
  srv.stderr.on('data', d => { lastErr += d })
  return { srv, tmp }
}

// Raw slow POST: send headers + half the body, gap, then the rest.
function slowPost(port, gapMs) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40\r\nConnection: close\r\n\r\n' + '{"username":"a",')
      setTimeout(() => sock.write('"password":"bbbbbbbb"}                 '.slice(0, 24)), gapMs)
    })
    let buf = ''
    sock.on('data', d => { buf += d })
    sock.on('close', () => resolve((buf.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 'NONE'))
    sock.on('error', () => resolve('ERR'))
  })
}

async function waitReady(port) {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/auth/me`); if (r.status === 401) return true } catch {} await new Promise(r => setTimeout(r, 100)) }
  return false
}

async function scenario(label, env) {
  const port = await freePort()
  const { srv, tmp } = startServer({ ...env, PORT: String(port) })
  try {
    if (!await waitReady(port)) throw new Error('server did not start\n' + lastErr)
    return await slowPost(port, 1500)
  } finally {
    srv.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  // Short cap + fast enforcement → 408 (bug reproduced). headersTimeout must be
  // <= requestTimeout, so shrink it too for this scenario.
  const shortStatus = await scenario('short', { REQUEST_TIMEOUT_MS: '800', HEADERS_TIMEOUT_MS: '600', CONN_CHECK_MS: '150' })
  ok(shortStatus === '408', `short requestTimeout → 408 (got ${shortStatus})`)

  // Disabled cap → request completes, NOT 408 (fix)
  const fixedStatus = await scenario('disabled', { REQUEST_TIMEOUT_MS: '0', CONN_CHECK_MS: '150' })
  ok(fixedStatus !== '408' && fixedStatus !== 'ERR' && fixedStatus !== 'NONE', `requestTimeout=0 → no 408 (got ${fixedStatus})`)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
