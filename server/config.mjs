// @ts-check
/**
 * config.mjs — environment + constants for the VEplay server.
 * Pure module: no imports from other server/ modules (root of the dep graph).
 */
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This module lives in <root>/server/. The original monolithic server.mjs sat at
// <root>/ and derived every path from its own __dirname, so we resolve one level
// UP here to keep MUSIC_ROOT / DATA_DIR / classify paths byte-for-byte identical.
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const __dirname = path.resolve(HERE, '..')

export const PORT       = Number(process.env.PORT) || 3001
export const HOST       = process.env.HOST || '0.0.0.0'   // set 127.0.0.1 behind a reverse proxy
// Music root: override with MUSIC_ROOT env var. Layout: <MUSIC_ROOT>/<folderId>/<category>/*.mp3
export const MUSIC_ROOT = process.env.MUSIC_ROOT || path.resolve(__dirname, '..', 'VEplay_demo')
// Where users.json / .secret live (persistent, outside the repo in production)
export const DATA_DIR   = process.env.DATA_DIR || __dirname
export const CATEGORIES = ['morning', 'day', 'evening']
export const ALL_CATEGORY = 'all'
// Every valid on-disk category folder name: the three time slots + the single-playlist folder.
// Used for path validation, streaming and scanning (the time-of-day schedule itself stays CATEGORIES).
export const VALID_CATEGORIES = [...CATEGORIES, ALL_CATEGORY]
// Accepted audio extensions. THE SINGLE SOURCE OF TRUTH — used by BOTH the upload
// filter (uploads.mjs) and the listing/scan (folders.mjs scanFolder/folderStats),
// so a file the upload accepts is always the one the listing shows (and vice
// versa). Compare with path.extname(name).toLowerCase().
export const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'])

export const USERS_FILE  = path.join(DATA_DIR, 'users.json')
export const SECRET_FILE = path.join(DATA_DIR, '.secret')
export const TOKEN_TTL   = 1000 * 60 * 60 * 24 * 30   // 30 days

export const UPLOAD_MAX_FILE  = 200 * 1024 * 1024     // 200MB per file (manual /upload)
// NOTE: no per-request FILE-COUNT cap on the manual upload — busboy's `files`
// limit silently discards parts beyond the cap (no per-file event), which lost
// tracks. handleUpload now processes EVERY part and reports each rejection.

// ── VEclassify bridge config ─────────────────────────────────────────────────
// Staging area for folders being classified. Lives under MUSIC_ROOT so that the
// final rename into MUSIC_ROOT/<folderId>/<cat> stays on the same filesystem
// (fast rename, no cross-device copy). listFolderIds() skips names starting with
// '_', so this dir is never mistaken for a client folder.
export const INCOMING_DIR = path.join(MUSIC_ROOT, '_incoming')
// Batch state is mirrored here so a server restart mid-review doesn't lose a
// 'ready' batch (persistent, next to users.json in production).
export const PENDING_FILE = path.join(DATA_DIR, 'pending_batches.json')

// Interpreter that runs VEclassify. Default: the project venv if present, else
// 'python3'. Override with CLASSIFY_PYTHON (path to the venv python in prod).
export function resolveClassifyPython() {
  const win = path.resolve(__dirname, '..', 'VEclassify', '.venv', 'Scripts', 'python.exe')
  const nix = path.resolve(__dirname, '..', 'VEclassify', '.venv', 'bin', 'python')
  if (fs.existsSync(win)) return win
  if (fs.existsSync(nix)) return nix
  return 'python3'
}
export const PYTHON_BIN      = process.env.CLASSIFY_PYTHON || resolveClassifyPython()
export const CLASSIFY_SCRIPT = process.env.CLASSIFY_SCRIPT || path.resolve(__dirname, '..', 'VEclassify', 'classify_stage.py')
export const MAX_BATCH_FILES  = 500
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024   // 2 GB per batch
// Hard ceiling on one classifier run. Without it a python child that never exits
// (hung TCP connection to the Gemini endpoint, stuck librosa read) leaves the
// batch in 'classifying' forever and the admin's modal spins with no way out.
export const CLASSIFY_TIMEOUT_MS = Number(process.env.CLASSIFY_TIMEOUT_MS) || 60 * 60 * 1000   // 1 h
// After rejecting an upload with 413 we keep draining the request body for this
// long so the client actually receives the status code — destroying the socket
// while it is still sending surfaces as ECONNRESET instead of our error. The
// deadline stops a multi-GB body from holding the connection open forever.
export const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS) || 15 * 1000

// HTTP request timeouts. Audio uploads are large; Node's default requestTimeout
// (300 s) makes the server emit 408 mid-upload on slower links or big batches
// (uploading a whole folder to classify). Raise it (env-tunable). headersTimeout
// still guards slow-header slowloris. requestTimeout = 0 disables the cap entirely.
export const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60 * 60 * 1000)   // 1 hour
let   _headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS ?? 60 * 1000)                   // 60 s
// Node throws at startup if headersTimeout > requestTimeout (both non-zero) —
// clamp so a misconfigured env can never crash the server on boot.
if (REQUEST_TIMEOUT_MS > 0 && _headersTimeout > REQUEST_TIMEOUT_MS) _headersTimeout = REQUEST_TIMEOUT_MS
export const HEADERS_TIMEOUT_MS = _headersTimeout
export const CONN_CHECK_MS      = Number(process.env.CONN_CHECK_MS ?? 30 * 1000)             // timeout-enforcement granularity

// Content-Type for streaming each accepted extension (keep in sync with AUDIO_EXTS).
/** @type {Record<string, string>} */
export const MIME = {
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
}
