// @ts-check
/**
 * server.mjs — VEplay music server entry point (auth, multi-tenant folders, admin).
 *
 * Thin bootstrap only: all logic lives in ./server/*.mjs (plain ES modules, run
 * directly by Node — no build step; deploy stays `node server.mjs`).
 *
 * Auth model (strict):
 *   - passwords stored as scrypt hashes (salt + hash) in users.json
 *   - login issues an HMAC-signed token; every protected route requires it
 *   - login is rate-limited per IP (in-memory)
 *
 * Multi-tenancy: 1 client = 1 folder
 *   MUSIC_ROOT/<folderId>/{morning,day,evening}/*.mp3
 *   - each non-admin user is bound to ONE folder (users.json → folderId)
 *   - a user only ever sees / streams their own folder; admin sees all
 *   - legacy users without folderId keep working (empty library until
 *     an admin assigns them a folder)
 *
 * Public:
 *   POST /auth/login            { username, password }      -> { token, user }
 *   GET  /auth/me               (Bearer)                    -> { user }
 *
 * Player (Bearer token):
 *   GET  /library                                           -> tracks grouped by category (own folder; admin: all folders merged)
 *   GET  /tracks?category=...                               -> tracks for a category
 *   GET  /music/:folder/:cat/:file?token=...                -> stream audio (Range supported, folder-gated)
 *
 * Admin (Bearer token, role=admin):
 *   GET    /admin/users                                     -> [ { username, role, categories, folderId } ]
 *   GET    /admin/categories                                -> [ { id, exists, count } ]  (aggregated over folders)
 *   POST   /admin/users        { username, password, categories, role, folderId? }
 *   PUT    /admin/users/:name  { password?, categories?, role?, folderId? }
 *   DELETE /admin/users/:name
 *   GET    /admin/clients                                   -> [ { folderId, name, username, counts, sizeBytes } ]
 *   POST   /admin/clients      { name }                     -> { folderId, name, username, password }  (password shown ONCE)
 *   DELETE /admin/clients/:folderId                         -> remove folder + its user
 *   POST   /admin/clients/:folderId/reset-password          -> { username, password }     (password shown ONCE)
 *   GET    /admin/clients/:folderId/tracks                  -> { morning: [..], day: [..], evening: [..] }
 *   POST   /admin/clients/:folderId/upload?category=...     -> multipart mp3 upload (≤20MB each)
 *   DELETE /admin/clients/:folderId/:category/:file         -> delete one track
 *   POST   /admin/clients/:folderId/:category/:file/move    -> move a track to another folder/category
 *
 * Admin — VEclassify bridge (classify a whole folder, review, then distribute):
 *   POST   /admin/clients/:folderId/classify                -> multipart: stage a folder + run VEclassify -> { batchId }
 *   GET    /admin/classify/:batchId                         -> batch state (frontend polls this)
 *   POST   /admin/classify/:batchId                         -> re-run classification on the staged files (retry)
 *   PUT    /admin/classify/:batchId/track/:filename         -> override a staged track's category
 *   GET    /admin/classify/:batchId/track/:filename/audio   -> stream a staged track (preview, Range)
 *   POST   /admin/classify/:batchId/confirm                 -> move staged files into MUSIC_ROOT/<folderId>/<category>
 *   DELETE /admin/classify/:batchId                         -> cancel batch, purge _incoming
 */
import http from 'node:http'
import {
  PORT, HOST, MUSIC_ROOT, DATA_DIR, CATEGORIES,
  REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, CONN_CHECK_MS,
} from './server/config.mjs'
import { json } from './server/http.mjs'
import { getUsers } from './server/users.mjs'
import { listFolderIds, folderStats } from './server/folders.mjs'
import { recoverBatches } from './server/classify.mjs'
import { handleRequest } from './server/router.mjs'

const server = http.createServer({
  requestTimeout: REQUEST_TIMEOUT_MS,
  headersTimeout: HEADERS_TIMEOUT_MS,
  connectionsCheckingInterval: CONN_CHECK_MS,
}, (req, res) => {
  // Top-level guard: any synchronous throw during routing (e.g. a malformed
  // request URL) becomes a 500 instead of an unhandled rejection that kills
  // the process. Individual routes still handle their own error cases.
  handleRequest(req, res).catch((e) => {
    console.error('request handler error:', e)
    if (!res.headersSent) { try { json(res, { error: 'Internal error' }, 500) } catch { /* ignore */ } }
    else { try { res.destroy() } catch { /* ignore */ } }
  })
})

// Last-resort backstops: never let one bad request or a stream error on a
// piped socket take down the whole server (music for every venue).
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
process.on('uncaughtException',  (e) => console.error('uncaughtException:', e))

// Restore any 'ready' classify batches and sweep stale _incoming staging dirs.
recoverBatches()

server.listen(PORT, HOST, () => {
  console.log(`\nVEplay server  →  http://${HOST}:${PORT}`)
  console.log(`Music root     →  ${MUSIC_ROOT}`)
  console.log(`Data dir       →  ${DATA_DIR}`)
  const users = getUsers()
  console.log(`Users          →  ${users.length}  (${users.filter(u => u.role === 'admin').length} admin)\n`)
  const folders = listFolderIds()
  if (!folders.length) {
    console.log('  [no client folders yet — create one in the admin panel]')
  }
  for (const f of folders) {
    const { counts, sizeBytes } = folderStats(f)
    const parts = CATEGORIES.map(c => `${c}: ${counts[c]}`).join('  ')
    console.log(`  ${f.padEnd(24)}  ${parts}  (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log()
})
