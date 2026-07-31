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
  const PORT2    = await freePort()   // second server: re-reads users.json (legacy-flag case)
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

    // ── audit fix: >MAX_BATCH_FILES files → 413, not a silent tail-drop ──
    // busboy's `files` limit skipped the surplus parts with no per-file event, so
    // the extra tracks vanished and `skipped` only carried one generic line.
    const manyForm = new FormData()
    for (let i = 1; i <= 505; i++) manyForm.append('tracks', mp3(`m${i}`), `M${String(i).padStart(3, '0')} - day.mp3`)
    const manyRes = await fetch(`${BASE}/admin/clients/${folderId}/classify`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: manyForm,
    })
    eq(manyRes.status, 413, '505 files → 413 (not a silent drop)')
    const manyBody = await manyRes.json().catch(() => null)
    ok(typeof manyBody?.error === 'string' && manyBody.error.length > 0, '413 carries a readable error')
    // Purge is asynchronous on purpose: every in-flight write stream is destroyed
    // and awaited first, because on Windows rmSync fails on an open fd.
    const incLeft = async () => {
      for (let i = 0; i < 60; i++) {
        const d = fs.existsSync(path.join(MUSIC, '_incoming')) ? fs.readdirSync(path.join(MUSIC, '_incoming')) : []
        if (!d.length) return 0
        await new Promise(r => setTimeout(r, 100))
      }
      return fs.readdirSync(path.join(MUSIC, '_incoming')).length
    }
    eq(await incLeft(), 0, '413 purges the staging dir (no orphan _incoming)')

    // ── audit fix: an aborted upload must not leave staged files behind ──
    // The batch is only registered once the upload finishes, so anything left in
    // _incoming after an abort is unreachable via DELETE /admin/classify/:id.
    await new Promise((resolve) => {
      const BND = '----vetestboundary'
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write(
          `POST /admin/clients/${folderId}/classify HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
          `Authorization: Bearer ${token}\r\nContent-Type: multipart/form-data; boundary=${BND}\r\n` +
          `Content-Length: 99999999\r\nConnection: close\r\n\r\n`)
        sock.write(`--${BND}\r\nContent-Disposition: form-data; name="tracks"; filename="Aborted - day.mp3"\r\n` +
                   `Content-Type: audio/mpeg\r\n\r\n`)
        sock.write(Buffer.alloc(512 * 1024, 0x41))
        setTimeout(() => { sock.destroy(); resolve() }, 300)
      })
      sock.on('error', () => resolve())
    })
    await new Promise(r => setTimeout(r, 1500))
    const afterAbort = fs.existsSync(path.join(MUSIC, '_incoming')) ? fs.readdirSync(path.join(MUSIC, '_incoming')) : []
    eq(afterAbort.length, 0, 'aborted upload leaves no orphan staging dir')

    // ── audit fix: a degraded classifier run is surfaced to the admin ──
    // gemini_classifier swallows its own failure and returns chill/evening, so
    // without this flag a dead Gemini is indistinguishable from a real result.
    const degForm = new FormData()
    degForm.append('tracks', mp3('d1'), 'DEGRADED - day.mp3')
    const degUp = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: degForm })).json()
    let degBatch
    for (let i = 0; i < 100; i++) {
      degBatch = (await api('GET', `/admin/classify/${degUp.batchId}`, { token })).data
      if (degBatch.status === 'ready' || degBatch.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    eq(degBatch.status, 'ready', 'degraded run still reaches ready')
    ok(typeof degBatch.warning === 'string' && degBatch.warning.length > 0, 'degraded run exposes `warning` to the admin')

    // ── audit fix: re-running a READY batch is refused (it would wipe overrides) ──
    const ovPut = await api('PUT', `/admin/classify/${degUp.batchId}/track/${encodeURIComponent('DEGRADED - day.mp3')}`, { token, body: { category: 'morning' } })
    eq(ovPut.status, 200, 'override set on ready batch')
    const reRun = await api('POST', `/admin/classify/${degUp.batchId}`, { token })
    eq(reRun.status, 409, 're-classify a ready batch → 409 (overrides preserved)')
    const stillThere = (await api('GET', `/admin/classify/${degUp.batchId}`, { token })).data
    eq(stillThere.tracks[0].override, 'morning', 'override survives the refused re-run')
    eq(stillThere.status, 'ready', 'refused re-run leaves the batch ready')
    await api('DELETE', `/admin/classify/${degUp.batchId}`, { token })

    // ── a healthy run carries no warning (no false alarm in the UI) ──
    const okForm = new FormData()
    okForm.append('tracks', mp3('h1'), 'Healthy - day.mp3')
    const okUp = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: okForm })).json()
    let okBatch
    for (let i = 0; i < 100; i++) {
      okBatch = (await api('GET', `/admin/classify/${okUp.batchId}`, { token })).data
      if (okBatch.status === 'ready' || okBatch.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    ok(okBatch.warning === null || okBatch.warning === undefined, 'healthy run reports no warning')
    await api('DELETE', `/admin/classify/${okUp.batchId}`, { token })

    // ── review fix #3: admin can stream a single-playlist ('all') track ──
    const spc = await api('POST', '/admin/clients', { token, body: { name: 'Single Bar', single_playlist: true } })
    const spFolder = spc.data.folderId
    const allDir = path.join(MUSIC, spFolder, 'all')
    fs.mkdirSync(allDir, { recursive: true })
    fs.writeFileSync(path.join(allDir, 'X - track.mp3'), Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]))
    const streamAll = await fetch(`${BASE}/music/${spFolder}/all/${encodeURIComponent('X - track.mp3')}?token=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=0-' } })
    ok(streamAll.status === 200 || streamAll.status === 206, `admin streams single-playlist 'all' track (status ${streamAll.status})`)

    // ── feature flags: allowFolderSelector / allowShuffle / allowTrackList ─────
    // Helper: read one user back out of GET /admin/users (a client's own /auth/me
    // is unreachable — its generated password is only returned once, at create).
    const getAdminUser = async (name) =>
      (await api('GET', '/admin/users', { token })).data.find(u => u.username === name)

    // 1. a fresh client defaults BOTH flags to true, in the 201 body and when read back
    const ff = await api('POST', '/admin/clients', { token, body: { name: 'Flag Bar' } })
    eq(ff.status, 201, 'flags: create client → 201')
    eq(ff.data.allowFolderSelector, true, 'flags: POST /admin/clients 201 body → allowFolderSelector true')
    eq(ff.data.allowShuffle, true, 'flags: POST /admin/clients 201 body → allowShuffle true')
    // allowTrackList is opt-IN: a new screen must not turn itself on for anyone
    eq(ff.data.allowTrackList, false, 'flags: POST /admin/clients 201 body → allowTrackList false (opt-in)')
    const ffUser = ff.data.username
    const ffRead = await getAdminUser(ffUser)
    eq(ffRead.allowFolderSelector, true, 'flags: GET /admin/users → allowFolderSelector true by default')
    eq(ffRead.allowShuffle, true, 'flags: GET /admin/users → allowShuffle true by default')
    eq(ffRead.allowTrackList, false, 'flags: GET /admin/users → allowTrackList false by default')
    // the client list the admin UI renders from carries them too
    const ffList = (await api('GET', '/admin/clients', { token })).data.find(c => c.folderId === ff.data.folderId)
    eq(ffList.allowFolderSelector, true, 'flags: GET /admin/clients → allowFolderSelector true by default')
    eq(ffList.allowShuffle, true, 'flags: GET /admin/clients → allowShuffle true by default')
    eq(ffList.allowTrackList, false, 'flags: GET /admin/clients → allowTrackList false by default')

    // 1b. the admin can switch the track list ON, and it survives a round-trip
    const tlOn = await api('PUT', `/admin/users/${encodeURIComponent(ff.data.username)}`, { token, body: { allowTrackList: true } })
    eq(tlOn.status, 200, 'flags: PUT allowTrackList=true → 200')
    eq(tlOn.data.allowTrackList, true, 'flags: PUT response → allowTrackList true')
    eq((await getAdminUser(ff.data.username)).allowTrackList, true, 'flags: allowTrackList true persisted')
    const tlList = (await api('GET', '/admin/clients', { token })).data.find(c => c.folderId === ff.data.folderId)
    eq(tlList.allowTrackList, true, 'flags: GET /admin/clients → allowTrackList true after enabling')
    // …and back OFF again
    await api('PUT', `/admin/users/${encodeURIComponent(ff.data.username)}`, { token, body: { allowTrackList: false } })
    eq((await getAdminUser(ff.data.username)).allowTrackList, false, 'flags: allowTrackList can be switched back off')

    // 2. PUT one flag false → persists; the untouched flag stays true
    const ffPut = await api('PUT', `/admin/users/${encodeURIComponent(ffUser)}`, { token, body: { allowShuffle: false } })
    eq(ffPut.status, 200, 'flags: PUT allowShuffle=false → 200')
    eq(ffPut.data.allowShuffle, false, 'flags: PUT response → allowShuffle false')
    eq(ffPut.data.allowFolderSelector, true, 'flags: PUT response → allowFolderSelector untouched (true)')
    const ffAfter = await getAdminUser(ffUser)
    eq(ffAfter.allowShuffle, false, 'flags: GET /admin/users → allowShuffle false persisted')
    eq(ffAfter.allowFolderSelector, true, 'flags: GET /admin/users → allowFolderSelector still true')
    // and it survives a users.json round-trip on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'))
      .users.find(u => u.username === ffUser)
    eq(onDisk.allowShuffle, false, 'flags: users.json on disk → allowShuffle false')

    // an unrelated PUT (password only) must not resurrect or clear the flags
    await api('PUT', `/admin/users/${encodeURIComponent(ffUser)}`, { token, body: { password: 'newpass123' } })
    const ffPw = await getAdminUser(ffUser)
    eq(ffPw.allowShuffle, false, 'flags: unrelated PUT leaves allowShuffle false')
    eq(ffPw.allowFolderSelector, true, 'flags: unrelated PUT leaves allowFolderSelector true')
    eq(ffPw.allowTrackList, false, 'flags: unrelated PUT leaves allowTrackList false')

    // a non-boolean value is ignored (not coerced) — the stored value stands
    await api('PUT', `/admin/users/${encodeURIComponent(ffUser)}`, { token, body: { allowShuffle: 'yes' } })
    eq((await getAdminUser(ffUser)).allowShuffle, false, 'flags: non-boolean PUT value ignored')

    // 3. POST /admin/users honours explicit flags, and defaults to true when absent
    await api('POST', '/admin/users', { token, body: { username: 'flaguser', password: 'flagpass12', allowFolderSelector: false } })
    const fu = await getAdminUser('flaguser')
    eq(fu.allowFolderSelector, false, 'flags: POST /admin/users explicit allowFolderSelector=false honoured')
    eq(fu.allowShuffle, true, 'flags: POST /admin/users absent allowShuffle → true')
    eq(fu.allowTrackList, false, 'flags: POST /admin/users absent allowTrackList → false (opt-in)')

    // 4. a LEGACY user object (fields never written) still reports true.
    // 'bob' was created before this block by a body carrying no flags; strip the keys
    // off disk to simulate a pre-feature users.json, then make the server re-read it.
    const usersPath = path.join(DATA, 'users.json')
    const store = JSON.parse(fs.readFileSync(usersPath, 'utf8'))
    const legacy = store.users.find(u => u.username === 'bob')
    delete legacy.allowFolderSelector
    delete legacy.allowShuffle
    ok(!('allowFolderSelector' in legacy) && !('allowShuffle' in legacy), 'flags: legacy user has no flag keys on disk')
    fs.writeFileSync(usersPath, JSON.stringify(store, null, 2))
    // a fresh process loads that users.json exactly as a deployed upgrade would
    const legacySrv = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', MUSIC_ROOT: MUSIC, DATA_DIR: DATA, ADMIN_USER: 'admin', ADMIN_PASS: 'admin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const BASE2 = `http://127.0.0.1:${PORT2}`
      let up2 = false
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(BASE2 + '/auth/me'); if (r.status === 401) { up2 = true; break } } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100))
      }
      ok(up2, 'flags: second server (legacy users.json) starts')
      // bob's own /auth/me — his password is known, so this is the real client path
      const bobLogin = await (await fetch(BASE2 + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'bobpass12' }),
      })).json()
      eq(bobLogin.user.allowFolderSelector, true, 'flags: legacy user /auth/login → allowFolderSelector true')
      eq(bobLogin.user.allowShuffle, true, 'flags: legacy user /auth/login → allowShuffle true')
      const bobMe = await (await fetch(BASE2 + '/auth/me', { headers: { Authorization: `Bearer ${bobLogin.token}` } })).json()
      eq(bobMe.user.allowFolderSelector, true, 'flags: legacy user /auth/me → allowFolderSelector true')
      eq(bobMe.user.allowShuffle, true, 'flags: legacy user /auth/me → allowShuffle true')
      eq(bobLogin.user.allowTrackList, false, 'flags: legacy user /auth/login → allowTrackList false')
      eq(bobMe.user.allowTrackList, false, 'flags: legacy user /auth/me → allowTrackList false')
    } finally {
      legacySrv.kill()
    }

  } finally {
    srv.kill()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(1) })
