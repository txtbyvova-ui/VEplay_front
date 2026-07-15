/**
 * Real end-to-end smoke of the server ↔ VEclassify bridge:
 * spawns server.mjs with the REAL venv python + REAL classify_stage.py, uploads
 * real mp3s from a folder, and reports the terminal batch state.
 *
 * With a working Gemini key this ends 'ready' with real categories; with an
 * exhausted / invalid key the preflight fails and the batch ends 'error' with a
 * readable message (acceptance #7) — either way the server must stay alive.
 *
 * Run:  node test/real_bridge_smoke.mjs "<folder-with-mp3s>"
 */
import { spawn } from 'node:child_process'
import net  from 'node:net'
import fs   from 'node:fs'
import os   from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')
const SAMPLE    = process.argv[2]
if (!SAMPLE || !fs.existsSync(SAMPLE)) { console.error('usage: node real_bridge_smoke.mjs <folder-with-mp3s>'); process.exit(2) }

const VENV_WIN  = path.resolve(ROOT, '..', 'VEclassify', '.venv', 'Scripts', 'python.exe')
const VENV_NIX  = path.resolve(ROOT, '..', 'VEclassify', '.venv', 'bin', 'python')
const PY        = fs.existsSync(VENV_WIN) ? VENV_WIN : VENV_NIX
const SCRIPT    = path.resolve(ROOT, '..', 'VEclassify', 'classify_stage.py')

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

async function main() {
  const PORT = await freePort()
  const BASE = `http://127.0.0.1:${PORT}`
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 've-real-'))
  const MUSIC = path.join(tmp, 'music'); const DATA = path.join(tmp, 'data')
  fs.mkdirSync(MUSIC, { recursive: true }); fs.mkdirSync(DATA, { recursive: true })

  console.log('python :', PY)
  console.log('script :', SCRIPT)

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_ROOT: MUSIC, DATA_DIR: DATA,
           ADMIN_USER: 'admin', ADMIN_PASS: 'admin', CLASSIFY_PYTHON: PY, CLASSIFY_SCRIPT: SCRIPT },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  const api = async (method, p, { token, body } = {}) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`
    if (body) headers['Content-Type'] = 'application/json'
    const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: await r.json().catch(() => null) }
  }

  try {
    for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/auth/me'); if (r.status === 401) break } catch {} await new Promise(r => setTimeout(r, 100)) }
    const token = (await api('POST', '/auth/login', { body: { username: 'admin', password: 'admin' } })).data.token
    const folderId = (await api('POST', '/admin/clients', { token, body: { name: 'Real Bar' } })).data.folderId

    const form = new FormData()
    for (const f of fs.readdirSync(SAMPLE).filter(f => f.toLowerCase().endsWith('.mp3'))) {
      form.append('tracks', new Blob([fs.readFileSync(path.join(SAMPLE, f))], { type: 'audio/mpeg' }), f)
    }
    const up = await (await fetch(`${BASE}/admin/clients/${folderId}/classify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })).json()
    console.log('upload :', up)

    let batch
    for (let i = 0; i < 1200; i++) {   // up to ~2 min
      batch = (await api('GET', `/admin/classify/${up.batchId}`, { token })).data
      if (batch.status === 'ready' || batch.status === 'error') break
      await new Promise(r => setTimeout(r, 100))
    }
    console.log('\nTERMINAL STATUS:', batch.status)
    if (batch.status === 'ready') {
      const counts = batch.tracks.reduce((m, t) => (m[t.category] = (m[t.category] || 0) + 1, m), {})
      console.log('categories    :', counts)
      for (const t of batch.tracks) console.log(`  ${t.category.padEnd(8)} | e=${t.energy_score} bpm=${t.tempo_bpm} | ${t.artist} - ${t.title}`)
    } else {
      console.log('error message :', String(batch.error).slice(0, 300))
    }

    // Server must still be alive after a classifier failure.
    const alive = await api('GET', '/admin/categories', { token })
    console.log('\nserver alive after batch:', alive.status === 200 ? 'YES' : `NO (${alive.status})`)
    process.exit((batch.status === 'ready' || batch.status === 'error') && alive.status === 200 ? 0 : 1)
  } finally {
    srv.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}
main().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })
