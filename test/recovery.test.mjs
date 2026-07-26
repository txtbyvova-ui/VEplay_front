/**
 * Restart / cancellation regression tests for the VEclassify bridge.
 *
 * Covers the failure modes an audit found in the batch lifecycle:
 *   - a crash mid-confirm used to delete every file that had not been moved yet
 *   - a tampered batchId in pending_batches.json reached path.join / rmSync
 *   - cancelling during classification left the python child running, and on
 *     Windows its open handles made the staging removal fail
 *   - an oversized JSON body left the request handler suspended forever
 *
 * Run:  node test/recovery.test.mjs
 */
import { spawn } from 'node:child_process'
import net  from 'node:net'
import fs   from 'node:fs'
import os   from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')
const STUB      = path.join(__dirname, 'stub_classify.mjs')

let passed = 0, failed = 0
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg) } else { failed++; console.error('  ✗', msg) } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.on('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const mp3 = (label) => new Blob([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, ...Buffer.from(label)])], { type: 'audio/mpeg' })

const tmp   = fs.mkdtempSync(path.join(os.tmpdir(), 've-recovery-'))
const MUSIC = path.join(tmp, 'music')
const DATA  = path.join(tmp, 'data')
fs.mkdirSync(MUSIC, { recursive: true })
fs.mkdirSync(DATA,  { recursive: true })

let PORT, BASE, srv

async function startServer() {
  PORT = await freePort()
  BASE = `http://127.0.0.1:${PORT}`
  srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_ROOT: MUSIC, DATA_DIR: DATA,
           CLASSIFY_PYTHON: process.execPath, CLASSIFY_SCRIPT: STUB },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/auth/me'); if (r.status === 401) return } catch { /* not up yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}
const stopServer = async () => { srv.kill(); await sleep(400) }

const api = async (method, p, { token, body } = {}) => {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body)  headers['Content-Type'] = 'application/json'
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const login = async () => (await api('POST', '/auth/login', { body: { username: 'admin', password: 'admin' } })).data.token
const stageBatch = async (token, folderId, names) => {
  const form = new FormData()
  for (const n of names) form.append('tracks', mp3(n), n)
  const r = await fetch(`${BASE}/admin/clients/${folderId}/classify`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  })
  return r.json()
}
const waitStatus = async (token, batchId, wanted = ['ready', 'error'], maxMs = 30000) => {
  for (let i = 0; i < maxMs / 100; i++) {
    const r = await api('GET', `/admin/classify/${batchId}`, { token })
    if (r.status !== 200) return null
    if (wanted.includes(r.data.status)) return r.data
    await sleep(100)
  }
  return null
}
const readPending = () => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'pending_batches.json'), 'utf8')) } catch { return { batches: [] } }
}
const writePending = (obj) => fs.writeFileSync(path.join(DATA, 'pending_batches.json'), JSON.stringify(obj, null, 2))

async function main() {
  try {
    await startServer()
    let token = await login()
    const folderId = (await api('POST', '/admin/clients', { token, body: { name: 'Recovery Bar' } })).data.folderId

    // ── 1. a 'ready' batch survives a restart ────────────────────────────────
    console.log('\n── ready batch survives a restart ──')
    const b1 = await stageBatch(token, folderId, ['A - morning.mp3', 'B - day.mp3'])
    await waitStatus(token, b1.batchId)
    await stopServer()
    await startServer()
    token = await login()
    const after = await api('GET', `/admin/classify/${b1.batchId}`, { token })
    eq(after.status, 200, 'ready batch recovered after restart')
    eq(after.data.tracks.length, 2, 'recovered batch keeps its tracks')

    // ── 2. a crash mid-confirm keeps the not-yet-moved files ─────────────────
    console.log('\n── crash during confirm does not delete the remaining files ──')
    // Simulate the crash: mark the batch 'confirming' on disk, and move one of its
    // two files out of staging (as a real half-done confirm would have).
    const pend = readPending()
    const rec = pend.batches.find(b => b.batchId === b1.batchId)
    rec.status = 'confirming'
    writePending(pend)
    const stageDir = path.join(MUSIC, '_incoming', b1.batchId)
    const movedAway = path.join(MUSIC, folderId, 'morning', 'A - morning.mp3')
    fs.mkdirSync(path.dirname(movedAway), { recursive: true })
    fs.renameSync(path.join(stageDir, 'A - morning.mp3'), movedAway)
    await stopServer()
    await startServer()
    token = await login()
    ok(fs.existsSync(path.join(stageDir, 'B - day.mp3')), 'un-moved staged file survives the restart')
    const rec2 = await api('GET', `/admin/classify/${b1.batchId}`, { token })
    eq(rec2.status, 200, "'confirming' batch is recovered, not dropped")
    eq(rec2.data.status, 'ready', 'recovered as ready so the admin can finish it')
    eq(rec2.data.tracks.map(t => t.filename), ['B - day.mp3'], 'only still-staged tracks are kept')
    const fin = await api('POST', `/admin/classify/${b1.batchId}/confirm`, { token })
    eq(fin.status, 200, 'the recovered batch can be confirmed')
    ok(fs.existsSync(path.join(MUSIC, folderId, 'day', 'B - day.mp3')), 'the remaining file lands in its category')

    // ── 3. a tampered batchId never reaches the filesystem ───────────────────
    console.log('\n── tampered pending_batches.json is ignored ──')
    const canary = path.join(MUSIC, 'canary-folder')
    fs.mkdirSync(canary, { recursive: true })
    fs.writeFileSync(path.join(canary, 'keep.mp3'), 'x')
    writePending({ batches: [
      { batchId: '../canary-folder', folderId, status: 'ready', tracks: [{ filename: 'keep.mp3' }], createdAt: Date.now() },
      { batchId: 'not-a-uuid',       folderId, status: 'ready', tracks: [{ filename: 'keep.mp3' }], createdAt: Date.now() },
    ] })
    await stopServer()
    await startServer()
    token = await login()
    ok(fs.existsSync(path.join(canary, 'keep.mp3')), 'traversal batchId did not delete anything outside _incoming')
    eq((await api('GET', '/admin/classify/../canary-folder', { token })).status, 404, 'traversal batchId is not addressable')
    eq((await api('GET', '/admin/classify/not-a-uuid', { token })).status, 404, 'non-uuid batchId is not recovered')

    // ── 4. cancelling mid-classification kills the child and clears staging ──
    console.log('\n── cancel during classification ──')
    const b2 = await stageBatch(token, folderId, ['SLOW - day.mp3', 'SLOW2 - day.mp3'])
    await sleep(1200)   // let the stub start and hold the files open
    const gone = await api('GET', `/admin/classify/${b2.batchId}`, { token })
    eq(gone.data.status, 'classifying', 'batch is classifying before cancel')
    const del = await api('DELETE', `/admin/classify/${b2.batchId}`, { token })
    eq(del.status, 200, 'cancel accepted while classifying')
    let purged = false
    for (let i = 0; i < 60; i++) {
      if (!fs.existsSync(path.join(MUSIC, '_incoming', b2.batchId))) { purged = true; break }
      await sleep(100)
    }
    ok(purged, 'staging dir removed even though the classifier held the files open')
    eq((await api('GET', `/admin/classify/${b2.batchId}`, { token })).status, 404, 'cancelled batch is gone')

    // ── 5. an oversized JSON body gets an answer (handler not left hanging) ──
    console.log('\n── oversized request body ──')
    const huge = JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) })
    let status = 0
    try {
      const r = await fetch(`${BASE}/admin/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: huge,
      })
      status = r.status
    } catch {
      status = -1   // socket torn down without a response
    }
    ok(status > 0, `oversized body produced an HTTP status (${status}), not a dead socket`)
    const alive = await api('GET', '/admin/categories', { token })
    eq(alive.status, 200, 'server still serving after the oversized body')

    // ── 6. a name collision between confirm and a manual upload loses nothing ──
    // claimName reserves the name with an atomic open('wx'); the previous
    // existsSync-then-write version let a concurrent writer take the same path,
    // and rename silently overwrote one of the two tracks.
    console.log('\n── colliding filenames are both kept ──')
    const dupName = 'Кино - Группа крови.mp3'
    const dupForm = new FormData()
    dupForm.append('tracks', mp3('dup'), dupName)
    await fetch(`${BASE}/admin/clients/${folderId}/upload?category=day`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: dupForm,
    })
    const b3 = await stageBatch(token, folderId, [dupName])
    await waitStatus(token, b3.batchId)
    await api('PUT', `/admin/classify/${b3.batchId}/track/${encodeURIComponent(dupName)}`, { token, body: { category: 'day' } })
    const conf3 = await api('POST', `/admin/classify/${b3.batchId}/confirm`, { token })
    eq(conf3.status, 200, 'confirm of a colliding name succeeds')
    const dayFiles = fs.readdirSync(path.join(MUSIC, folderId, 'day'))
    ok(dayFiles.includes(dupName), 'the manually uploaded file is still there')
    ok(dayFiles.some(f => /_2\.mp3$/.test(f)), `the classified one landed beside it (${JSON.stringify(dayFiles)})`)
    ok(dayFiles.every(f => fs.statSync(path.join(MUSIC, folderId, 'day', f)).size > 0), 'neither file was left empty')

    // ── 7. a missing interpreter reports the real cause ──────────────────────
    // markBatchError keeps the FIRST error: the spawn 'error' event carries
    // ENOENT, while the 'close' that follows only knows "code null".
    console.log('\n── unusable CLASSIFY_PYTHON ──')
    await stopServer()
    const badPort = await freePort()
    const badSrv = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(badPort), HOST: '127.0.0.1', MUSIC_ROOT: MUSIC, DATA_DIR: DATA,
             CLASSIFY_PYTHON: path.join(tmp, 'no-such-python.exe'), CLASSIFY_SCRIPT: STUB },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      const B = `http://127.0.0.1:${badPort}`
      for (let i = 0; i < 150; i++) {
        try { const r = await fetch(B + '/auth/me'); if (r.status === 401) break } catch { /* not up */ }
        await sleep(100)
      }
      const t = (await (await fetch(B + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })).json()).token
      const f = new FormData()
      f.append('tracks', mp3('z'), 'Z - day.mp3')
      const upBad = await (await fetch(`${B}/admin/clients/${folderId}/classify`, {
        method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: f,
      })).json()
      let st = null
      for (let i = 0; i < 150; i++) {
        st = await (await fetch(`${B}/admin/classify/${upBad.batchId}`, { headers: { Authorization: `Bearer ${t}` } })).json()
        if (st.status === 'error' || st.status === 'ready') break
        await sleep(100)
      }
      eq(st?.status, 'error', 'missing interpreter → batch error')
      ok(/ENOENT|не запустился|не удалось запустить/i.test(String(st?.error)),
        `error names the real cause, not "код null" (${String(st?.error).slice(0, 90)})`)
    } finally {
      badSrv.kill()
    }

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  } finally {
    try { srv?.kill() } catch { /* ignore */ }
    await sleep(300)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(1) })
