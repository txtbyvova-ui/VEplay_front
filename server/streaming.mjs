// @ts-check
/**
 * streaming.mjs — HTTP Range parsing and audio streaming (Range-aware, 206/416).
 */
import fs   from 'node:fs'
import path from 'node:path'
import { MIME } from './config.mjs'

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

// Parse a single-range "bytes=" header into {start,end} clamped to [0,total-1].
// Supports suffix ranges ("bytes=-500"). Returns null for a full-content request,
// or 'invalid' for a malformed / unsatisfiable range (→ caller replies 416).
/**
 * @param {string | string[] | undefined} rangeHeader
 * @param {number} total
 * @returns {{ start: number, end: number } | 'invalid' | null}
 */
export function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
  if (!m) return 'invalid'
  const [, a, b] = m
  if (a === '' && b === '') return 'invalid'

  let start, end
  if (a === '') {
    // suffix: last N bytes
    const n = parseInt(b, 10)
    if (!Number.isFinite(n) || n <= 0) return 'invalid'
    start = Math.max(0, total - n)
    end   = total - 1
  } else {
    start = parseInt(a, 10)
    end   = b === '' ? total - 1 : parseInt(b, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= total) return 'invalid'
  if (end >= total) end = total - 1
  return { start, end }
}

// Pipe a read stream to the response, tearing down the socket on async read
// errors (file deleted mid-stream, disk error) instead of leaving it to crash.
/**
 * @param {import('node:fs').ReadStream} stream
 * @param {ServerResponse} res
 */
export function pipeStream(stream, res) {
  stream.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Stream error') } else res.destroy() })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} filePath
 */
export function streamAudio(req, res, filePath) {
  const ext   = path.extname(filePath).toLowerCase()
  const mime  = MIME[ext] ?? 'application/octet-stream'
  const total = fs.statSync(filePath).size
  const range = parseRange(req.headers['range'], total)

  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': mime })
    res.end()
    return
  }

  if (range) {
    const { start, end } = range
    const chunk = end - start + 1
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   mime,
    })
    pipeStream(fs.createReadStream(filePath, { start, end }), res)
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
    })
    pipeStream(fs.createReadStream(filePath), res)
  }
}
