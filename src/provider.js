// @ts-check
import Hyperswarm from 'hyperswarm'
import { onMessages, send } from './protocol.js'
import { shortKey } from './log.js'

// Only inference routes reach the upstream. Admin routes such as Ollama's
// /api/pull and /api/delete are never forwarded (PRD F7).
const ALLOWED = new Map([
  ['/v1/models', 'GET'],
  ['/v1/chat/completions', 'POST']
])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Requests waiting behind the one in progress. Beyond this, members get a 503
// instead of an ever-growing wait (PRD F8).
export const MAX_QUEUED = 16

/**
 * Shares a local OpenAI-compatible upstream with members of a team.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   upstream?: string,
 *   timeoutMs?: number,
 *   allowRemoteUpstream?: boolean,
 *   bootstrap?: { host: string, port: number }[],
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startProvider ({ seed, team, upstream = 'http://127.0.0.1:11434', timeoutMs = 120000, allowRemoteUpstream = false, bootstrap, log }) {
  const upstreamUrl = new URL(upstream)
  if (!allowRemoteUpstream && !LOOPBACK_HOSTS.has(upstreamUrl.hostname)) {
    throw new Error(`upstream ${upstreamUrl.origin} is not on this machine. Pass --allow-remote-upstream to use it anyway.`)
  }

  const swarm = new Hyperswarm({
    seed,
    bootstrap,
    firewall: (remoteKey) => {
      if (team.isMember(remoteKey)) return false
      log('reject', { peer: shortKey(remoteKey) })
      return true
    }
  })

  // One upstream request at a time, in arrival order, across all members.
  // A small GPU can't serve two generations at once (PRD F8).
  /** @type {Job[]} */
  const queue = []
  let running = false

  async function drain () {
    if (running) return
    running = true
    while (queue.length) await forward(/** @type {Job} */ (queue.shift()))
    running = false
  }

  swarm.on('connection', (conn) => {
    const peer = shortKey(conn.remotePublicKey)
    /** @type {Map<string, Job>} jobs from this peer, queued or running */
    const jobs = new Map()

    log('connect', { peer, member: team.memberName(conn.remotePublicKey) })
    // A peer that exits resets the stream. The 'disconnect' line covers it.
    conn.on('error', (err) => {
      if (err.code !== 'ECONNRESET') log('conn-error', { peer, err: err.code || err.message })
    })
    conn.on('close', () => {
      for (const job of jobs.values()) cancel(job)
      log('disconnect', { peer })
    })

    listModels(upstreamUrl, log).then((models) => send(conn, { t: 'hello', models }))

    onMessages(conn, (msg) => {
      if (msg.t === 'req') enqueue(conn, peer, msg, jobs)
      else if (msg.t === 'cancel') {
        const job = jobs.get(String(msg.id))
        if (job) cancel(job)
      }
    })
  })

  /**
   * @param {any} conn
   * @param {string} peer
   * @param {{ id: string, method: string, path: string, body?: string }} msg
   * @param {Map<string, Job>} jobs
   */
  function enqueue (conn, peer, msg, jobs) {
    const id = String(msg.id)
    if (ALLOWED.get(msg.path) !== msg.method) {
      log('blocked', { peer, id, path: msg.path })
      send(conn, { t: 'err', id, status: 404, message: 'route not available through potluck' })
      return
    }
    if (queue.length >= MAX_QUEUED) {
      log('busy', { peer, id, queued: queue.length })
      send(conn, { t: 'err', id, status: 503, message: 'provider is busy, try again shortly' })
      return
    }

    /** @type {Job} */
    const job = { conn, peer, id, msg, controller: new AbortController(), done: () => jobs.delete(id) }
    jobs.set(id, job)
    queue.push(job)
    if (running) log('queued', { peer, id, position: queue.length })
    drain()
  }

  /** @param {Job} job */
  function cancel (job) {
    const index = queue.indexOf(job)
    if (index !== -1) {
      queue.splice(index, 1)
      job.done()
      log('cancelled', { peer: job.peer, id: job.id, queued: true })
    } else {
      job.controller.abort()
    }
  }

  /** @param {Job} job */
  async function forward ({ conn, peer, id, msg, controller, done }) {
    const started = Date.now()
    let timedOut = false
    /** @type {NodeJS.Timeout | undefined} */
    let idle
    // Idle timeout, not total: a long answer that keeps streaming is fine.
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    }
    touch()
    log('request', { peer, id, path: msg.path })

    try {
      const res = await fetch(new URL(msg.path, upstreamUrl), {
        method: msg.method,
        headers: msg.body ? { 'content-type': 'application/json' } : {},
        body: msg.body,
        redirect: 'error',
        signal: controller.signal
      })
      send(conn, { t: 'head', id, status: res.status, contentType: res.headers.get('content-type') })

      let first = true
      for await (const chunk of res.body ?? []) {
        touch()
        if (first) {
          log('first-chunk', { peer, id, ms: Date.now() - started })
          first = false
        }
        send(conn, { t: 'chunk', id, d: Buffer.from(chunk).toString('base64') })
      }
      send(conn, { t: 'end', id })
      log('end', { peer, id, status: res.status, ms: Date.now() - started })
    } catch (err) {
      if (timedOut) {
        log('timeout', { peer, id, ms: Date.now() - started })
        send(conn, { t: 'err', id, status: 504, message: `upstream sent nothing for ${timeoutMs / 1000} s` })
      } else if (controller.signal.aborted) {
        log('cancelled', { peer, id })
        send(conn, { t: 'err', id, status: 499, message: 'request cancelled' })
      } else {
        log('upstream-error', { peer, id, err: err.cause?.code || err.message })
        send(conn, { t: 'err', id, status: 502, message: 'upstream request failed' })
      }
    } finally {
      clearTimeout(idle)
      done()
    }
  }

  const discovery = swarm.join(team.topic, { server: true, client: false })
  await discovery.flushed()
  log('serving', { team: team.name, key: shortKey(swarm.keyPair.publicKey), upstream: upstreamUrl.origin })

  return {
    publicKey: swarm.keyPair.publicKey,
    close: () => swarm.destroy()
  }
}

/**
 * @typedef {{
 *   conn: any,
 *   peer: string,
 *   id: string,
 *   msg: { id: string, method: string, path: string, body?: string },
 *   controller: AbortController,
 *   done: () => void
 * }} Job
 */

/**
 * Model ids the upstream hosts. An unreachable upstream advertises none.
 *
 * @param {URL} upstreamUrl
 * @param {(event: string, fields?: Record<string, unknown>) => void} log
 * @returns {Promise<string[]>}
 */
async function listModels (upstreamUrl, log) {
  try {
    const res = await fetch(new URL('/v1/models', upstreamUrl), { redirect: 'error', signal: AbortSignal.timeout(5000) })
    const body = await res.json()
    return (body.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string')
  } catch (err) {
    log('upstream-error', { path: '/v1/models', err: err.cause?.code || err.message })
    return []
  }
}
