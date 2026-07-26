/**
 * Upload diagnostic / verification.
 *
 * Spawns the real server against a temp MUSIC_ROOT, logs in as admin, creates a
 * client, then uploads batches that used to be silently dropped, and cross-checks
 * the /admin/clients/:id/tracks listing. Asserts every accepted file is listed.
 *
 *   node scripts/test-upload.mjs      → prints results + PASS/FAIL, exits non-zero on failure
 */
import { spawn } from 'node:child_process'
import net  from 'node:net'
import fs   from 'node:fs'
import os   from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const bytes = (n) => new Uint8Array(n)   // n zero-bytes; server never inspects audio content

let passed = 0, failed = 0
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg) } else { failed++; console.error('  ✗', msg) } }

async function main() {
  const PORT = await freePort()
  const BASE = `http://127.0.0.1:${PORT}`
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 've-upload-'))
  const MUSIC = path.join(tmp, 'm'); const DATA = path.join(tmp, 'd')
  fs.mkdirSync(MUSIC, { recursive: true }); fs.mkdirSync(DATA, { recursive: true })

  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_ROOT: MUSIC, DATA_DIR: DATA, ADMIN_USER: 'admin', ADMIN_PASS: 'admin' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  const login = async () => {
    for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/auth/me'); if (r.status === 401) break } catch {} await new Promise(r => setTimeout(r, 100)) }
    const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })
    return (await r.json()).token
  }
  const upload = async (token, folderId, category, files) => {
    const form = new FormData()
    for (const f of files) form.append('tracks', new Blob([bytes(f.size ?? 64)], { type: f.type ?? 'audio/mpeg' }), f.name)
    const r = await fetch(`${BASE}/admin/clients/${folderId}/upload?category=${category}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    let body = null; try { body = await r.json() } catch {}
    return { status: r.status, body }
  }
  const listCat = async (token, folderId, category) => {
    const r = await fetch(`${BASE}/admin/clients/${folderId}/tracks`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await r.json()
    return (data[category] || []).map(t => t.filename)
  }

  try {
    const token = await login()
    const c = await (await fetch(`${BASE}/admin/clients`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Diag Bar' }) })).json()
    const folderId = c.folderId
    console.log(`client=${folderId}\n`)

    // ── Scenario 1: 5 files, mixed extensions + a Cyrillic/spaces/parens name ──
    const s1 = [
      { name: 'song1.mp3',  type: 'audio/mpeg' },
      { name: 'song2.wav',  type: 'audio/wav'  },
      { name: 'song3.flac', type: 'audio/flac' },
      { name: 'song4.m4a',  type: 'audio/mp4'  },
      { name: 'Кино - Группа крови (ремастер).mp3', type: 'audio/mpeg' },
    ]
    const r1 = await upload(token, folderId, 'day', s1)
    const day = await listCat(token, folderId, 'day')
    console.log('── Scenario 1: 5 mixed-format files (incl. Cyrillic name) → "day" ──')
    console.log('  accepted:', (r1.body?.accepted || []).map(u => u.filename))
    console.log('  rejected:', (r1.body?.rejected || []).map(u => `${u.filename} (${u.reason})`))
    console.log('  LISTED  :', day)
    ok((r1.body?.accepted || []).length === 5, 'all 5 mixed-format files accepted')
    ok(day.length === 5, 'all 5 visible in the listing')
    ok(day.includes('Кино - Группа крови (ремастер).mp3'), 'Cyrillic + spaces + parens filename preserved')
    console.log()

    // ── Scenario 2: 25 valid files (used to hit the 20-file cap) ──
    const s2 = Array.from({ length: 25 }, (_, i) => ({ name: `bulk-${String(i + 1).padStart(2, '0')}.mp3`, type: 'audio/mpeg' }))
    const r2 = await upload(token, folderId, 'morning', s2)
    const morning = await listCat(token, folderId, 'morning')
    console.log('── Scenario 2: 25 files (was capped at 20) → "morning" ──')
    console.log('  accepted:', (r2.body?.accepted || []).length, ' listed:', morning.length)
    ok((r2.body?.accepted || []).length === 25, 'all 25 files accepted (no 20-file silent drop)')
    ok(morning.length === 25, 'all 25 visible in the listing')
    console.log()

    // ── Scenario 3: a real .mp3 whose browser MIME is application/octet-stream ──
    const r3 = await upload(token, folderId, 'evening', [{ name: 'octet.mp3', type: 'application/octet-stream' }])
    console.log('── Scenario 3: valid .mp3 with MIME application/octet-stream ──')
    console.log('  accepted:', (r3.body?.accepted || []).map(u => u.filename), ' rejected:', (r3.body?.rejected || []))
    ok((r3.body?.accepted || []).length === 1, 'octet-stream .mp3 accepted (MIME no longer blocks)')
    console.log()

    // ── Scenario 4: a 21 MB file (was over the old 20 MB cap) ──
    const r4 = await upload(token, folderId, 'evening', [{ name: 'big.mp3', type: 'audio/mpeg', size: 21 * 1024 * 1024 }])
    console.log('── Scenario 4: 21 MB .mp3 (old cap was 20 MB) ──')
    ok((r4.body?.accepted || []).length === 1, '21 MB file accepted (200 MB cap)')
    console.log()

    // ── Scenario 5: oversized (201 MB) → explicit "size" rejection, NOT silent ──
    const r5 = await upload(token, folderId, 'evening', [{ name: 'huge.mp3', type: 'audio/mpeg', size: 201 * 1024 * 1024 }])
    console.log('── Scenario 5: 201 MB .mp3 → explicit rejection ──')
    console.log('  rejected:', (r5.body?.rejected || []))
    ok((r5.body?.rejected || []).some(r => r.reason === 'size'), 'oversized file rejected with reason "size" (not silent)')
    console.log()

    // ── Scenario 6: unsupported extension → explicit "ext" rejection ──
    const r6 = await upload(token, folderId, 'evening', [{ name: 'notes.txt', type: 'text/plain' }])
    ok((r6.body?.rejected || []).some(r => r.reason === 'ext'), 'non-audio file rejected with reason "ext" (not silent)')

    // ── Cross-check: NOTHING written on disk is missing from the listing ──
    console.log('\n── On disk vs listed (accepted ⟺ listed) ──')
    for (const cat of ['morning', 'day', 'evening']) {
      const listed = await listCat(token, folderId, cat)
      let disk = []; try { disk = fs.readdirSync(path.join(MUSIC, folderId, cat)) } catch {}
      const hidden = disk.filter(f => !listed.includes(f))
      console.log(`  ${cat}: on-disk=${disk.length} listed=${listed.length}`)
      ok(hidden.length === 0, `${cat}: no on-disk file hidden from the listing`)
    }
  } finally {
    srv.kill()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error('ERROR', e); process.exit(1) })
