// @ts-check
/**
 * users.mjs — the users store.
 *
 * `users` is MUTABLE: routes replace it wholesale (delete client / delete user)
 * and push onto it (create). An imported binding cannot be reassigned across
 * modules, so the array is kept module-private and exposed only through the
 * accessors/mutators below. Every route mutates the store through these.
 */
import fs from 'node:fs'
import { CATEGORIES, VALID_CATEGORIES, USERS_FILE, DATA_DIR } from './config.mjs'
import { hashPassword } from './crypto.mjs'

/**
 * @typedef {Object} User
 * @property {string} username
 * @property {string} role
 * @property {string[]} categories
 * @property {string=} salt
 * @property {string=} hash
 * @property {string|null=} folderId
 * @property {string|null=} name
 * @property {boolean=} singlePlaylist
 * @property {boolean=} weakPassword
 * @property {boolean=} allowFolderSelector
 * @property {boolean=} allowShuffle
 * @property {boolean=} allowTrackList
 */

/** @returns {User[] | null} */
function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (Array.isArray(data.users)) return data.users
  } catch { /* fall through to seed */ }
  return null
}

// All users.json writes are serialized through this promise chain so that
// concurrent admin requests (upload + CRUD) never interleave writes.
let usersWriteQueue = Promise.resolve()

/**
 * Persist the current store atomically (tmp file + rename), serialized.
 * @returns {Promise<void>}
 */
export function saveUsers() {
  const data = JSON.stringify({ users }, null, 2)
  usersWriteQueue = usersWriteQueue
    .then(() => {
      const tmp = USERS_FILE + '.tmp'
      return fs.promises.writeFile(tmp, data).then(() => fs.promises.rename(tmp, USERS_FILE))
    })
    .catch(e => console.error('users.json write failed:', e))
  return usersWriteQueue
}

/** @type {User[]} */
let users = loadUsers() ?? seedDefaultAdmin()

function seedDefaultAdmin() {
  // First run: seed a default admin (change the password immediately!)
  const adminUser = process.env.ADMIN_USER || 'admin'
  const adminPass = process.env.ADMIN_PASS || 'admin'
  /** @type {User[]} */
  const seeded = [{ username: adminUser, role: 'admin', categories: [...CATEGORIES], ...hashPassword(adminPass) }]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: seeded }, null, 2))
  console.log('\n  ⚠  Seeded default admin →  login: %s   password: %s', adminUser, adminPass)
  console.log('     Change it in the admin panel right away.\n')
  return seeded
}

// ── accessors / mutators ─────────────────────────────────────────────────────

/** The live users array (read-only use: map / find / filter / some). @returns {User[]} */
export const getUsers = () => users

/**
 * @param {unknown} name
 * @returns {User | undefined}
 */
export const findUser = (name) => users.find(u => u.username.toLowerCase() === String(name || '').toLowerCase())

/** @param {User} u */
export const addUser = (u) => { users.push(u) }

/** Replace the whole store (used by the wholesale-filter delete routes). @param {User[]} arr */
export const setUsers = (arr) => { users = arr }

/**
 * @param {User} u
 * @returns {{ username: string, role: string, categories: string[], folderId: string|null, name: string|null, singlePlaylist: boolean, weakPassword: boolean, allowFolderSelector: boolean, allowShuffle: boolean, allowTrackList: boolean }}
 */
export const sanitize = (u) => ({
  username: u.username, role: u.role, categories: u.categories,
  folderId: u.folderId ?? null, name: u.name ?? null,
  singlePlaylist: u.singlePlaylist === true,
  weakPassword: u.weakPassword === true,
  // Opt-OUT flags: absent/undefined means "allowed". Legacy users in users.json
  // predate these fields and must keep their UI, so only an explicit `false` hides it.
  allowFolderSelector: u.allowFolderSelector !== false,
  allowShuffle: u.allowShuffle !== false,
  // Opt-IN, unlike the two above: the track list is a NEW screen, and turning it on
  // for every existing venue at once would change their player without anyone asking.
  allowTrackList: u.allowTrackList === true,
})

/**
 * Pick the per-client feature flags that are *explicitly* present as booleans in a
 * request body. Absent keys are omitted entirely so callers can distinguish
 * "not sent" (leave stored value alone) from "sent as false" (turn the flag off).
 * @param {Record<string, unknown>} body
 * @returns {{ allowFolderSelector?: boolean, allowShuffle?: boolean, allowTrackList?: boolean }}
 */
export const readFlags = (body) => {
  /** @type {{ allowFolderSelector?: boolean, allowShuffle?: boolean, allowTrackList?: boolean }} */
  const out = {}
  if (typeof body?.allowFolderSelector === 'boolean') out.allowFolderSelector = body.allowFolderSelector
  if (typeof body?.allowShuffle === 'boolean') out.allowShuffle = body.allowShuffle
  if (typeof body?.allowTrackList === 'boolean') out.allowTrackList = body.allowTrackList
  return out
}

/**
 * @param {unknown} cats
 * @returns {string[]}
 */
export const cleanCats = (cats) => Array.isArray(cats) ? [...new Set(cats)].filter(c => VALID_CATEGORIES.includes(c)) : []
