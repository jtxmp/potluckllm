// @ts-check
import Hyperswarm from 'hyperswarm'
import { onMessages, send } from './protocol.js'
import { createRejectLogger, shortKey } from './log.js'

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
// Requests one member may have queued or running at once, so one member
// can't fill the queue for everyone else.
export const MAX_PER_MEMBER = 4

/**
 * Shares a local OpenAI-compatible upstream with members of a team.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   upstream?: string,
 *   timeoutMs?: number,
 *   maxDurationMs?: number,
 *   maxTokens?: number,
 *   allowRemoteUpstream?: boolean,
 *   bootstrap?: { host: string, port: number }[],
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startProvider ({ seed, team, upstream = 'http://127.0.0.1:11434', timeoutMs = 120000, maxDurationMs = 600000, maxTokens = 4096, allowRemoteUpstream = false, bootstrap, log }) {
  const upstreamUrl = new URL(upstream)
  const loopback = LOOPBACK_HOSTS.has(upstreamUrl.hostname)
  if (!allowRemoteUpstream && !loopback) {
    throw new Error(`upstream ${upstreamUrl.origin} is not on this machine. Pass --allow-remote-upstream to use it anyway.`)
  }
  if (!loopback && upstreamUrl.protocol === 'http:') {
    // Prompts would cross the network unencrypted between here and the upstream.
    log('insecure-upstream', { upstream: upstreamUrl.origin })
  }

  const logReject = createRejectLogger(log)
  const swarm = new Hyperswarm({
    seed,
    bootstrap,
    firewall: (remoteKey) => {
      if (team.isMember(remoteKey)) return false
      logReject(remoteKey)
      return true
    }
  })

  // One upstream request at a time, in arrival order, across all members.
  // A small GPU can't serve two generations at once (PRD F8).
  /** @type {Job[]} */
  const queue = []
  /** @type {Job | null} */
  let current = null

  async function drain () {
    if (current) return
    while (queue.length) {
      current = /** @type {Job} */ (queue.shift())
      await forward(current)
    }
    current = null
  }

  /** @param {string} key */
  function jobsFor (key) {
    return queue.filter((job) => job.key === key).length + (current?.key === key ? 1 : 0)
  }

  swarm.on('connection', (conn) => {
    const key = conn.remotePublicKey.toString('hex')
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
      if (msg.t === 'req') enqueue(conn, key, peer, msg, jobs)
      else if (msg.t === 'cancel') {
        const job = jobs.get(String(msg.id))
        if (job) cancel(job)
      }
    })
  })

  /**
   * @param {any} conn
   * @param {string} key
   * @param {string} peer
   * @param {{ id: string, method: string, path: string, body?: unknown }} msg
   * @param {Map<string, Job>} jobs
   */
  function enqueue (conn, key, peer, msg, jobs) {
    const id = String(msg.id)
    if (ALLOWED.get(msg.path) !== msg.method) {
      log('blocked', { peer, id, path: msg.path })
      send(conn, { t: 'err', id, status: 404, message: 'route not available through potluck' })
      return
    }
    if (jobsFor(key) >= MAX_PER_MEMBER) {
      log('busy', { peer, id, reason: 'member' })
      send(conn, { t: 'err', id, status: 429, message: `you already have ${MAX_PER_MEMBER} requests waiting on this provider` })
      return
    }
    if (queue.length >= MAX_QUEUED) {
      log('busy', { peer, id, queued: queue.length })
      send(conn, { t: 'err', id, status: 503, message: 'provider is busy, try again shortly' })
      return
    }

    let body
    if (msg.method === 'POST') {
      body = capTokens(msg.body, maxTokens)
      if (body === null) {
        send(conn, { t: 'err', id, status: 400, message: 'request body is not a JSON object' })
        return
      }
    }

    /** @type {Job} */
    const job = { conn, key, peer, id, method: msg.method, path: msg.path, body, controller: new AbortController(), done: () => jobs.delete(id) }
    jobs.set(id, job)
    queue.push(job)
    if (current) log('queued', { peer, id, position: queue.length })
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
  async function forward ({ conn, peer, id, method, path, body, controller, done }) {
    const started = Date.now()
    /** @type {'idle' | 'duration' | null} */
    let stopped = null
    /** @type {NodeJS.Timeout | undefined} */
    let idle
    // Idle timeout: a long answer that keeps streaming is fine...
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(() => { stopped = 'idle'; controller.abort() }, timeoutMs)
    }
    // ...up to a total limit, so one request can't hold the GPU indefinitely.
    const total = setTimeout(() => { stopped = 'duration'; controller.abort() }, maxDurationMs)
    touch()
    log('request', { peer, id, path })

    try {
      const res = await fetch(new URL(path, upstreamUrl), {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
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
      if (stopped === 'idle') {
        log('timeout', { peer, id, ms: Date.now() - started })
        send(conn, { t: 'err', id, status: 504, message: `upstream sent nothing for ${timeoutMs / 1000} s` })
      } else if (stopped === 'duration') {
        log('too-long', { peer, id, ms: Date.now() - started })
        send(conn, { t: 'err', id, status: 504, message: `request exceeded the provider's ${maxDurationMs / 1000} s limit` })
      } else if (controller.signal.aborted) {
        log('cancelled', { peer, id })
        send(conn, { t: 'err', id, status: 499, message: 'request cancelled' })
      } else {
        log('upstream-error', { peer, id, err: err.cause?.code || err.message })
        send(conn, { t: 'err', id, status: 502, message: 'upstream request failed' })
      }
    } finally {
      clearTimeout(idle)
      clearTimeout(total)
      done()
    }
  }

  /**
   * Applies an edited team file without a restart. Removed members are
   * disconnected at once, which also cancels their requests.
   *
   * @param {import('./team.js').Team} next
   */
  function updateTeam (next) {
    if (!next.topic.equals(team.topic)) throw new Error('the team topic changed; restart to use the new topic')
    const before = team
    team = next
    for (const conn of swarm.connections) {
      if (!team.isMember(conn.remotePublicKey)) {
        log('removed', { peer: shortKey(conn.remotePublicKey) })
        conn.destroy()
      }
    }
    for (const member of team.members) {
      if (!before.isMember(Buffer.from(member.key, 'hex'))) swarm.peers.get(member.key)?.ban(false)
    }
    log('team-updated', { members: team.members.length })
  }

  const discovery = swarm.join(team.topic, { server: true, client: false })
  await discovery.flushed()
  log('serving', { team: team.name, key: shortKey(swarm.keyPair.publicKey), upstream: upstreamUrl.origin, maxTokens })

  return {
    publicKey: swarm.keyPair.publicKey,
    updateTeam,
    close: () => swarm.destroy()
  }
}

/**
 * @typedef {{
 *   conn: any,
 *   key: string,
 *   peer: string,
 *   id: string,
 *   method: string,
 *   path: string,
 *   body: string | undefined,
 *   controller: AbortController,
 *   done: () => void
 * }} Job
 */

/**
 * Returns the request body with `max_tokens` capped at `limit`, and set to
 * `limit` when absent. Returns null if the body isn't a JSON object.
 *
 * @param {unknown} body
 * @param {number} limit
 */
export function capTokens (body, limit) {
  if (typeof body !== 'string') return null
  let request
  try {
    request = JSON.parse(body)
  } catch {
    return null
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const value = request[field]
    if (value !== undefined && !(Number.isInteger(value) && value > 0 && value <= limit)) request[field] = limit
  }
  if (request.max_tokens === undefined && request.max_completion_tokens === undefined) request.max_tokens = limit
  return JSON.stringify(request)
}

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
