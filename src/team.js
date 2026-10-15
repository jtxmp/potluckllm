// @ts-check
import crypto from 'node:crypto'
import fs from 'node:fs'

const HEX32 = /^[0-9a-f]{64}$/

/**
 * @typedef {{ name: string, key: string }} Member
 * @typedef {{ name: string, topic: string, members: Member[] }} TeamFile
 * @typedef {{
 *   name: string,
 *   topic: Buffer,
 *   members: Member[],
 *   isMember: (key: Buffer) => boolean,
 *   memberName: (key: Buffer) => string | undefined
 * }} Team
 */

/** @param {string} key */
export function isValidKey (key) {
  return typeof key === 'string' && HEX32.test(key)
}

/**
 * Validates a parsed team file and returns lookup helpers.
 *
 * @param {TeamFile} data
 * @returns {Team}
 */
export function parseTeam (data) {
  if (!data || typeof data.name !== 'string') throw new Error('team file: missing "name"')
  if (!isValidKey(data.topic)) throw new Error('team file: "topic" must be 64 lowercase hex characters')
  if (!Array.isArray(data.members)) throw new Error('team file: "members" must be an array')

  const byKey = new Map()
  for (const member of data.members) {
    if (!member || typeof member.name !== 'string' || !isValidKey(member.key)) {
      throw new Error(`team file: invalid member ${JSON.stringify(member)}`)
    }
    byKey.set(member.key, member.name)
  }

  return {
    name: data.name,
    topic: Buffer.from(data.topic, 'hex'),
    members: data.members,
    isMember: (key) => byKey.has(key.toString('hex')),
    memberName: (key) => byKey.get(key.toString('hex'))
  }
}

/**
 * @param {string} file
 * @returns {TeamFile}
 */
export function readTeamFile (file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  parseTeam(data)
  return data
}

/** @param {string} file */
export function readTeam (file) {
  return parseTeam(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/**
 * Writes the team file atomically. With `create`, refuses to replace an
 * existing file so `team init` can't wipe a team by accident.
 *
 * @param {string} file
 * @param {TeamFile} data
 * @param {{ create?: boolean }} [opts]
 */
export function writeTeamFile (file, data, { create = false } = {}) {
  parseTeam(data)
  const json = JSON.stringify(data, null, 2) + '\n'
  if (create) {
    fs.writeFileSync(file, json, { mode: 0o600, flag: 'wx' })
    return
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, json, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * @param {string} name
 * @param {Member} firstMember
 * @returns {TeamFile}
 */
export function createTeam (name, firstMember) {
  const team = { name, topic: crypto.randomBytes(32).toString('hex'), members: [] }
  return addMember(team, firstMember.name, firstMember.key)
}

/**
 * @param {TeamFile} team
 * @param {string} name
 * @param {string} key
 * @returns {TeamFile}
 */
export function addMember (team, name, key) {
  if (!isValidKey(key)) throw new Error(`invalid public key: expected 64 lowercase hex characters, got "${key}"`)
  if (team.members.some((m) => m.key === key)) throw new Error(`key ${key.slice(0, 8)} is already a member`)
  if (team.members.some((m) => m.name === name)) throw new Error(`member name "${name}" is already taken`)
  return { ...team, members: [...team.members, { name, key }] }
}

/**
 * Calls `onTeam` with the parsed team each time the file changes, so edits
 * apply without a restart. Polls the file's metadata once a second, which
 * also catches the atomic rename that `writeTeamFile` does. A file that
 * fails to parse is reported and ignored; the previous team stays in force.
 *
 * @param {string} file
 * @param {(team: Team) => void} onTeam
 * @param {(err: Error) => void} onError
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void} stops watching
 */
export function watchTeamFile (file, onTeam, onError, { intervalMs = 1000 } = {}) {
  const listener = (/** @type {fs.Stats} */ now, /** @type {fs.Stats} */ before) => {
    if (now.mtimeMs === before.mtimeMs && now.ino === before.ino && now.size === before.size) return
    try {
      onTeam(readTeam(file))
    } catch (err) {
      onError(err)
    }
  }
  fs.watchFile(file, { interval: intervalMs }, listener)
  return () => fs.unwatchFile(file, listener)
}
