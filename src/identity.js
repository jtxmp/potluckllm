// @ts-check
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function defaultIdentityDir () {
  return path.join(os.homedir(), '.potluck')
}

/**
 * Ed25519 public key for a 32-byte seed. Matches the keypair Hyperswarm
 * derives from the same `seed` option.
 *
 * @param {Buffer} seed
 */
export function publicKeyFromSeed (seed) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return spki.subarray(spki.length - 32)
}

/**
 * Loads the identity seed from `<dir>/identity.json`, creating it on first
 * run. The file holds the private seed, so it must not be readable by others.
 *
 * @param {string} [dir]
 * @returns {{ seed: Buffer, publicKey: Buffer, created: boolean }}
 */
export function loadOrCreateIdentity (dir = defaultIdentityDir()) {
  const file = path.join(dir, 'identity.json')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Another user who can write here could replace the identity file.
  const dirMode = fs.statSync(dir).mode & 0o777
  if (dirMode & 0o022) {
    throw new Error(`${dir} is writable by other users (mode ${dirMode.toString(8)}). Run: chmod 700 ${dir}`)
  }

  let created = false
  if (!fs.existsSync(file)) {
    const seed = crypto.randomBytes(32)
    fs.writeFileSync(file, JSON.stringify({ seed: seed.toString('hex') }) + '\n', { mode: 0o600, flag: 'wx' })
    created = true
  }

  const mode = fs.statSync(file).mode & 0o777
  if (mode & 0o077) {
    throw new Error(`${file} is accessible by other users (mode ${mode.toString(8)}). Run: chmod 600 ${file}`)
  }

  const seed = Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).seed ?? '', 'hex')
  if (seed.length !== 32) throw new Error(`${file} does not contain a valid 32-byte seed`)

  return { seed, publicKey: publicKeyFromSeed(seed), created }
}
