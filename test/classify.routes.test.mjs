/**
 * Hermetic route tests for the VEclassify bridge in server.mjs.
 * Spawns server.mjs against temp MUSIC_ROOT / DATA_DIR, with `node stub_classify.mjs`
 * standing in for the real Python classifier (no librosa / no Gemini needed).
 *
 * Run:  node test/classify.routes.test.mjs
 * Exit: 0 = all passed, 1 = a failure (details printed).
 */
import { spawn } from 'node:child_process'
import net  from 'node:net'
import fs   from 'node:fs'
import os   from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')

let passed = 0, failed = 0
const ok  = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg) } else { failed++; console.error('  ✗', msg) } }
const eq  = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const mp3 = (label) => new Blob([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, ...Buffer.from(label)])], { type: 'audio/mpeg' })

async function main() {
  const PORT     = await freePort()
  const BASE     = `http://127.0.0.1:${PORT}`
  const tmp      = fs.mkdtempSync(path.join(os.tmpdir(), 've-classify-test-'))
  const MUSIC    = path.join(tmp, 'music')
  const DATA     = path.join(tmp, 'data')
  fs.mkdirSync(MUSIC, { recursive: true })
  fs.mkdirSync(DATA,  { recursive: true })

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      MUSIC_ROOT: MUSIC, DATA_DIR: DATA,
      ADMIN_USER: 'admin', ADMIN_PASS: 'admin',
      CLASSIFY_PYTHON: process.execPath,
      CLASSIFY_SCRIPT: path.join(__dirname, 'stub_classify.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let srvErr = ''
  srv.stderr.on('data', d => { srvErr += d })

  const api = async (method, p, { token, body, raw } = {}) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    let payload = body
    if (body && !raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const r = await fetch(BASE + p, { method, headers, body: payload })
    const ct = r.headers.get('content-type') || ''
    const data = ct.includes('json') ? await r.json().catch(() => null) : await r.arrayBuffer()
    return { status: r.status, data }
  }

  try {
    // ── wait for readiness ──
    let up = false
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/auth/me'); if (r.status === 401) { up = true; break } } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    if (!up) throw new Error('server did not start\n' + srvErr)

    // ── auth ──
    const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'admin' } })
    ok(login.status === 200 && login.data.token, 'admin login')
    const token = login.data.token

    // ── create a Mode-A client ──
    const cc = await api('POST', '/admin/clients', { token, body: { name: 'Test Bar' } })
    ok(cc.status === 201 && cc.data.folderId, 'create client')
    const folderId = cc.data.folderId

    // ── classify upload ──
    const form = new FormData()
    form.append('tracks', mp3('a'), 'A - morning.mp3')
    form.append('tracks', mp3('b'), 'B - day.mp3')
    form.append('tracks', mp3('c'), 'C - evening.mp3')
    form.append('tracks', mp3('d'), 'D.mp3')            // no keyword → night → evening
    form.append('tracks', new Blob(['hi'], { type: 'text/plain' }), 'notes.txt')  // skipped
    const upRes = await fetch(`${BASE}/admin/clients/${folderId}/classify`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    })
    const upBody = await upRes.json()
    ok(upRes.status === 202, 'classify upload → 202')
    eq(upBody.uploaded, 4, 'uploaded count = 4')
    ok(Array.isArray(upBody.skipped) && upBody.skipped.some(s => s.includes('notes.txt')), 'notes.txt skipped')
    const batchId = upBody.batchId

    // ── poll until ready ──
    let batch
    for (let i = 0; i < 100; i++) {
      const g = await api('GET', `/admin/classify/${batchId}`, { token })
      batch = g.data
      if (batch.status === 'ready' || batch.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    eq(batch.status, 'ready', 'batch reaches ready')
    eq(batch.tracks.length, 4, 'batch has 4 tracks')
    const catByName = Object.fromEntries(batch.tracks.map(t => [t.filename, t.category]))
    eq(catByName['A - morning.mp3'], 'morning', 'A → morning')
    eq(catByName['B - day.mp3'], 'day', 'B → day')
    eq(catByName['C - evening.mp3'], 'evening', 'C → evening')
    eq(catByName['D.mp3'], 'evening', 'D (night) normalized → evening')
    ok(batch.tracks.every(t => t.override === null), 'overrides start null')

    // ── preview audio (Range) ──
    const prev = await fetch(`${BASE}/admin/classify/${batchId}/track/${encodeURIComponent('A - morning.mp3')}/audio`, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-' },
    })
    ok(prev.status === 200 || prev.status === 206, `preview audio streams (status ${prev.status})`)

    // ── override A → day ──
    const put = await api('PUT', `/admin/classify/${batchId}/track/${encodeURIComponent('A - morning.mp3')}`, { token, body: { category: 'day' } })
    ok(put.status === 200 && put.data.override === 'day', 'PUT override A → day')
    const putBad = await api('PUT', `/admin/classify/${batchId}/track/${encodeURIComponent('A - morning.mp3')}`, { token, body: { category: 'bogus' } })
    eq(putBad.status, 400, 'PUT invalid category → 400')

    // ── confirm ──
    const conf = await api('POST', `/admin/classify/${batchId}/confirm`, { token })
    ok(conf.status === 200 && conf.data.ok === true, 'confirm → ok')
    eq(conf.data.moved.length, 4, 'confirm moved 4')
    eq(conf.data.errors.length, 0, 'confirm no errors')
    // A overridden to day, B day, C evening, D evening; morning empty
    const dayDir = fs.readdirSync(path.join(MUSIC, folderId, 'day')).sort()
    const eveDir = fs.readdirSync(path.join(MUSIC, folderId, 'evening')).sort()
    eq(dayDir, ['A - morning.mp3', 'B - day.mp3'], 'day/ has A + B')
    eq(eveDir, ['C - evening.mp3', 'D.mp3'], 'evening/ has C + D')
    ok(!fs.existsSync(path.join(MUSIC, '_incoming', batchId)), '_incoming/<batch> purged after confirm')

    // ── GET batch after confirm → 404 ──
    const gone = await api('GET', `/admin/classify/${batchId}`, { token })
    eq(gone.status, 404, 'batch gone after confirm → 404')

    // ── /library shows the moved tracks (admin sees all folders) ──
    const lib = await api('GET', '/library', { token })
    const libDay = (lib.data.day || []).map(t => t.filename)
    ok(libDay.includes('A - morning.mp3') && libDay.includes('B - day.mp3'), '/library day reflects new tracks')

    // ── move B from day → morning ──
    const mv = await api('POST', `/admin/clients/${folderId}/day/${encodeURIComponent('B - day.mp3')}/move`, { token, body: { toFolderId: folderId, toCategory: 'morning' } })
    ok(mv.status === 200 && mv.data.ok === true && mv.data.category === 'morning', 'move B day → morning')
    ok(fs.existsSync(path.join(MUSIC, folderId, 'morning', 'B - day.mp3')), 'B now in morning/')
    ok(!fs.existsSync(path.join(MUSIC, folderId, 'day', 'B - day.mp3')), 'B removed from day/')

    // ── cancel: upload then delete, _incoming cleaned ──
    const form2 = new FormData()
    form2.append('tracks', mp3('x'), 'X - day.mp3')
    const up2 = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form2 })).json()
    const del = await api('DELETE', `/admin/classify/${up2.batchId}`, { token })
    ok(del.status === 200 && del.data.ok === true, 'cancel → ok')
    ok(!fs.existsSync(path.join(MUSIC, '_incoming', up2.batchId)), '_incoming purged after cancel')

    // ── error path: FAIL sentinel → batch status error ──
    const form3 = new FormData()
    form3.append('tracks', mp3('f'), 'FAIL - day.mp3')
    const up3 = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form3 })).json()
    let eb
    for (let i = 0; i < 100; i++) {
      eb = (await api('GET', `/admin/classify/${up3.batchId}`, { token })).data
      if (eb.status === 'ready' || eb.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    eq(eb.status, 'error', 'bad classifier → batch status error')
    ok(typeof eb.error === 'string' && eb.error.length > 0, 'error message present')
    // retry still fails (server stays alive)
    const retry = await api('POST', `/admin/classify/${up3.batchId}`, { token })
    eq(retry.status, 202, 'retry accepted (202)')
    await api('DELETE', `/admin/classify/${up3.batchId}`, { token })   // cleanup

    // ── _incoming is not treated as a client folder ──
    const clients = await api('GET', '/admin/clients', { token })
    ok(!clients.data.some(c => c.folderId === '_incoming'), '_incoming not listed as a client')

    // ── 403 for non-admin ──
    await api('POST', '/admin/users', { token, body: { username: 'bob', password: 'bobpass12', role: 'user' } })
    const bob = await api('POST', '/auth/login', { body: { username: 'bob', password: 'bobpass12' } })
    const bobTok = bob.data.token
    const f403 = await api('GET', `/admin/classify/whatever`, { token: bobTok })
    eq(f403.status, 403, 'non-admin GET classify → 403')
    const upl403 = await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${bobTok}` }, body: new FormData() })
    eq(upl403.status, 403, 'non-admin classify upload → 403')

    // ── unknown batch → 404 ──
    const nf = await api('GET', '/admin/classify/does-not-exist', { token })
    eq(nf.status, 404, 'unknown batch → 404')

    // ── task 1: a Cyrillic filename round-trips through the python pipe as UTF-8 ──
    const cyForm = new FormData()
    cyForm.append('tracks', mp3('cy'), 'Кино - Группа крови.mp3')
    const cyUp = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: cyForm })).json()
    let cyBatch
    for (let i = 0; i < 100; i++) {
      cyBatch = (await api('GET', `/admin/classify/${cyUp.batchId}`, { token })).data
      if (cyBatch.status === 'ready' || cyBatch.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    eq(cyBatch.status, 'ready', 'cyrillic batch reaches ready')
    ok(cyBatch.tracks.some(t => t.filename === 'Кино - Группа крови.mp3'), 'Cyrillic filename round-trips through python pipe as UTF-8')
    await api('DELETE', `/admin/classify/${cyUp.batchId}`, { token })

    // ── review fix #5: _incoming is reserved, not addressable as a client ──
    const delInc = await api('DELETE', '/admin/clients/_incoming', { token })
    eq(delInc.status, 404, 'DELETE _incoming client → 404 (reserved)')
    const clsInc = await fetch(`${BASE}/admin/clients/_incoming/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: new FormData() })
    eq(clsInc.status, 404, 'classify into _incoming → 404 (reserved)')

    // ── review fix #2: a >20 MB mp3 is accepted, not silently dropped ──
    const bigForm = new FormData()
    const big = new Uint8Array(21 * 1024 * 1024); big.set([0x49, 0x44, 0x33])
    bigForm.append('tracks', new Blob([big], { type: 'audio/mpeg' }), 'Big - day.mp3')
    const bigUp = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bigForm })).json()
    eq(bigUp.uploaded, 1, '21MB mp3 accepted (no 20MB per-file drop)')
    eq(bigUp.skipped.length, 0, '21MB mp3 not skipped')
    await api('DELETE', `/admin/classify/${bigUp.batchId}`, { token })

    // ── review fix #3: admin can stream a single-playlist ('all') track ──
    const spc = await api('POST', '/admin/clients', { token, body: { name: 'Single Bar', single_playlist: true } })
    const spFolder = spc.data.folderId
    const allDir = path.join(MUSIC, spFolder, 'all')
    fs.mkdirSync(allDir, { recursive: true })
    fs.writeFileSync(path.join(allDir, 'X - track.mp3'), Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]))
    const streamAll = await fetch(`${BASE}/music/${spFolder}/all/${encodeURIComponent('X - track.mp3')}?token=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=0-' } })
    ok(streamAll.status === 200 || streamAll.status === 206, `admin streams single-playlist 'all' track (status ${streamAll.status})`)

  } finally {
    srv.kill()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(1) })
