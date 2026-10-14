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

/**
 * Shares a local OpenAI-compatible upstream with members of a team.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   upstream?: string,
 *   allowRemoteUpstream?: boolean,
 *   bootstrap?: { host: string, port: number }[],
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startProvider ({ seed, team, upstream = 'http://127.0.0.1:11434', allowRemoteUpstream = false, bootstrap, log }) {
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

  swarm.on('connection', (conn) => {
    const peer = shortKey(conn.remotePublicKey)
    /** @type {Map<string, AbortController>} */
    const inflight = new Map()

    log('connect', { peer, member: team.memberName(conn.remotePublicKey) })
    conn.on('error', (err) => log('conn-error', { peer, err: err.code || err.message }))
    conn.on('close', () => {
      for (const controller of inflight.values()) controller.abort()
      log('disconnect', { peer })
    })

    listModels(upstreamUrl, log).then((models) => send(conn, { t: 'hello', models }))

    onMessages(conn, (msg) => {
      if (msg.t === 'req') forward(conn, peer, msg, inflight)
      else if (msg.t === 'cancel') inflight.get(String(msg.id))?.abort()
    })
  })

  /**
   * @param {any} conn
   * @param {string} peer
   * @param {{ id: string, method: string, path: string, body?: string }} msg
   * @param {Map<string, AbortController>} inflight
   */
  async function forward (conn, peer, msg, inflight) {
    const id = String(msg.id)
    if (ALLOWED.get(msg.path) !== msg.method) {
      log('blocked', { peer, id, path: msg.path })
      send(conn, { t: 'err', id, status: 404, message: 'route not available through potluck' })
      return
    }

    const controller = new AbortController()
    inflight.set(id, controller)
    const started = Date.now()
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
        if (first) {
          log('first-chunk', { peer, id, ms: Date.now() - started })
          first = false
        }
        send(conn, { t: 'chunk', id, d: Buffer.from(chunk).toString('base64') })
      }
      send(conn, { t: 'end', id })
      log('end', { peer, id, status: res.status, ms: Date.now() - started })
    } catch (err) {
      const cancelled = controller.signal.aborted
      log(cancelled ? 'cancelled' : 'upstream-error', { peer, id, err: cancelled ? undefined : err.cause?.code || err.message })
      send(conn, { t: 'err', id, status: 502, message: cancelled ? 'request cancelled' : 'upstream request failed' })
    } finally {
      inflight.delete(id)
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
