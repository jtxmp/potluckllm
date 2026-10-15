// @ts-check
import crypto from 'node:crypto'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import Hyperswarm from 'hyperswarm'
import { onMessages, send } from './protocol.js'
import { createRejectLogger, shortKey } from './log.js'

const MAX_BODY_BYTES = 1024 * 1024
const MIN_LOOKUP_MS = 5000
const MAX_LOOKUP_MS = 60000

// Providers only ever relay these. Anything else is refused, so a provider
// can't get a browser to render its response as a page on this origin.
const CONTENT_TYPES = new Set(['application/json', 'text/event-stream'])
const MAX_MODELS = 1000
const MAX_MODEL_NAME = 200
const MAX_ERROR_MESSAGE = 500

/**
 * @typedef {{
 *   key: string,
 *   name: string | undefined,
 *   conn: any,
 *   models: string[],
 *   pending: Map<string, { onMessage: (msg: any) => void, fail: (message: string) => void }>
 * }} Provider
 */

/**
 * Connects to team providers and exposes them as one local
 * OpenAI-compatible endpoint.
 *
 * The endpoint listens on 127.0.0.1 only, and also refuses requests that a
 * web page could make: a Host other than this endpoint (DNS rebinding), any
 * Origin not in `allowOrigins` (cross-site requests) and POST bodies that
 * aren't `application/json` (which a page can only send after a CORS
 * preflight that this server never approves for other origins). With
 * `apiKey`, every request must also carry `Authorization: Bearer <apiKey>`,
 * which keeps out other users of the same machine.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   port?: number,
 *   apiKey?: string,
 *   allowOrigins?: string[],
 *   bootstrap?: { host: string, port: number }[],
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startConsumer ({ seed, team, port = 11500, apiKey, allowOrigins = [], bootstrap, log }) {
  /** @type {Map<string, Provider>} */
  const providers = new Map()
  const events = new EventEmitter()
  const origins = new Set(allowOrigins)
  const expectedKey = apiKey ? sha256(apiKey) : null
  /** @type {Set<string>} filled in once the port is known */
  const hosts = new Set()
  const logReject = createRejectLogger(log)
  let nextId = 0

  const swarm = new Hyperswarm({
    seed,
    bootstrap,
    firewall: (remoteKey) => {
      if (team.isMember(remoteKey)) return false
      logReject(remoteKey)
      return true
    }
  })

  swarm.on('connection', (conn) => {
    const key = conn.remotePublicKey.toString('hex')
    const peer = key.slice(0, 8)
    /** @type {Provider} */
    const provider = { key, name: team.memberName(conn.remotePublicKey), conn, models: [], pending: new Map() }
    providers.set(key, provider)
    log('connect', { peer, member: provider.name })

    // A peer that exits resets the stream. The 'disconnect' line covers it.
    conn.on('error', (err) => {
      if (err.code !== 'ECONNRESET') log('conn-error', { peer, err: err.code || err.message })
    })
    conn.on('close', () => {
      for (const request of provider.pending.values()) request.fail('provider disconnected')
      // Hyperswarm can replace a connection; only forget the provider if this
      // is still the current one.
      if (providers.get(key) === provider) providers.delete(key)
      log('disconnect', { peer })
      events.emit('change')
    })

    onMessages(conn, (msg) => {
      if (msg.t === 'hello') {
        provider.models = Array.isArray(msg.models)
          ? msg.models.filter((m) => typeof m === 'string' && m.length <= MAX_MODEL_NAME).slice(0, MAX_MODELS)
          : []
        log('hello', { peer, models: provider.models.length })
        events.emit('change')
      } else {
        provider.pending.get(String(msg.id))?.onMessage(msg)
      }
    })
  })

  const discovery = swarm.join(team.topic, { server: false, client: true })

  // Hyperswarm repeats its topic lookup only every 10 minutes, so a consumer
  // that starts before a provider has announced would wait that long. While
  // no provider is connected, look up again with backoff.
  let lookupDelay = MIN_LOOKUP_MS
  let lookupTimer = setTimeout(lookupAgain, lookupDelay)
  function lookupAgain () {
    if (providers.size === 0) {
      discovery.refresh().catch((err) => log('lookup-error', { err: err.message }))
      lookupDelay = Math.min(lookupDelay * 2, MAX_LOOKUP_MS)
    }
    lookupTimer = setTimeout(lookupAgain, lookupDelay)
  }
  events.on('change', () => {
    if (providers.size === 0) lookupDelay = MIN_LOOKUP_MS
  })

  const server = http.createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    handle(req, res).catch((err) => {
      log('http-error', { err: err.message })
      fail(res, 500, 'internal error')
    })
  })

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle (req, res) {
    if (!hosts.has(String(req.headers.host))) {
      log('refused', { reason: 'host' })
      return fail(res, 421, 'this endpoint only answers requests for 127.0.0.1 or localhost')
    }

    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!origins.has(origin)) {
        log('refused', { reason: 'origin', origin })
        return fail(res, 403, 'requests from web pages are refused. Use --allow-origin to permit one.')
      }
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET, POST')
        res.setHeader('access-control-allow-headers', 'authorization, content-type')
        res.setHeader('access-control-max-age', '600')
        res.writeHead(204).end()
        return
      }
    }

    if (expectedKey && !keyMatches(req.headers.authorization, expectedKey)) {
      log('refused', { reason: 'api-key' })
      res.setHeader('www-authenticate', 'Bearer')
      return fail(res, 401, 'missing or wrong API key')
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: listModels() })
    }

    if (req.method === 'GET' && pathname === '/potluck/status') {
      return json(res, 200, status())
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      if (mediaType(req.headers['content-type']) !== 'application/json') {
        return fail(res, 415, 'content-type must be application/json')
      }
      const body = await readBody(req)
      if (body === null) return fail(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
      let model
      try {
        model = JSON.parse(body).model
      } catch {
        return fail(res, 400, 'request body is not valid JSON')
      }
      const provider = pickProvider(model)
      if (!provider) return fail(res, 503, `no connected team member hosts model "${model}"`)
      return relay(provider, { method: 'POST', path: pathname, body }, res)
    }

    fail(res, 404, 'not found')
  }

  function listModels () {
    const seen = new Map()
    for (const provider of providers.values()) {
      for (const id of provider.models) {
        if (!seen.has(id)) seen.set(id, { id, object: 'model', owned_by: provider.name ?? provider.key.slice(0, 8) })
      }
    }
    return [...seen.values()]
  }

  /** Connected members and their models (PRD F6). Key prefixes only. */
  function status () {
    return {
      team: team.name,
      self: shortKey(swarm.keyPair.publicKey),
      providers: [...providers.values()].map((p) => ({
        name: p.name,
        key: p.key.slice(0, 8),
        models: p.models,
        inFlight: p.pending.size
      }))
    }
  }

  /** First connected provider that lists the model (PRD F5). */
  function pickProvider (model) {
    for (const provider of providers.values()) {
      if (provider.models.includes(model)) return provider
    }
    return undefined
  }

  /**
   * Forwards one request and streams the reply. Messages from the provider
   * are checked before they touch the HTTP response; a message that breaks
   * the protocol throws, which closes that provider's connection
   * (protocol.js) and fails its pending requests.
   *
   * @param {Provider} provider
   * @param {{ method: string, path: string, body?: string }} request
   * @param {http.ServerResponse} res
   */
  function relay (provider, request, res) {
    const id = String(++nextId)
    const peer = provider.key.slice(0, 8)
    const started = Date.now()
    let headSeen = false
    let first = true

    const finish = () => provider.pending.delete(id)
    provider.pending.set(id, {
      onMessage (msg) {
        if (msg.t === 'head') {
          if (headSeen) throw new Error('second head for one request')
          if (!isStatus(msg.status)) throw new Error('invalid status')
          headSeen = true
          const type = mediaType(msg.contentType)
          if (!CONTENT_TYPES.has(type)) {
            finish()
            send(provider.conn, { t: 'cancel', id })
            log('error', { peer, id, err: 'unsupported content type' })
            return fail(res, 502, 'provider returned an unsupported content type')
          }
          // setHeader, not writeHead options, so fail() can read it back.
          res.setHeader('content-type', type)
          res.writeHead(msg.status)
        } else if (msg.t === 'chunk') {
          if (!headSeen) throw new Error('chunk before head')
          if (typeof msg.d !== 'string') throw new Error('chunk data is not a string')
          if (first) {
            log('first-chunk', { peer, id, ms: Date.now() - started })
            first = false
          }
          res.write(Buffer.from(msg.d, 'base64'))
        } else if (msg.t === 'end') {
          finish()
          res.end()
          log('end', { peer, id, status: res.statusCode, ms: Date.now() - started })
        } else if (msg.t === 'err') {
          finish()
          const code = isStatus(msg.status) && msg.status >= 400 ? msg.status : 502
          log('error', { peer, id, status: code })
          fail(res, code, typeof msg.message === 'string' ? msg.message.slice(0, MAX_ERROR_MESSAGE) : 'provider error')
        }
      },
      fail (message) {
        finish()
        log('error', { peer, id, err: message })
        fail(res, 502, message)
      }
    })

    // The client went away before the provider finished: stop the upstream
    // work instead of spending GPU time on an answer nobody reads.
    res.on('close', () => {
      if (provider.pending.has(id)) {
        finish()
        send(provider.conn, { t: 'cancel', id })
        log('cancelled', { peer, id })
      }
    })

    log('request', { peer, id, path: request.path })
    send(provider.conn, { t: 'req', id, ...request })
  }

  /**
   * Applies an edited team file without a restart. Removed members are
   * disconnected at once; added members can connect, even if they were
   * rejected earlier.
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
    let added = false
    for (const member of team.members) {
      if (before.isMember(Buffer.from(member.key, 'hex'))) continue
      swarm.peers.get(member.key)?.ban(false)
      added = true
    }
    log('team-updated', { members: team.members.length })
    if (added) discovery.refresh().catch((err) => log('lookup-error', { err: err.message }))
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${name}:${address.port}`)
  log('listening', { url: `http://127.0.0.1:${address.port}/v1`, team: team.name, key: shortKey(swarm.keyPair.publicKey), apiKey: expectedKey ? 'required' : 'off' })

  return {
    port: address.port,
    providers,
    events,
    publicKey: swarm.keyPair.publicKey,
    updateTeam,
    close: async () => {
      clearTimeout(lookupTimer)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      await swarm.destroy()
    }
  }
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string | null>} null when the body is too large
 */
async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** @param {unknown} value */
function mediaType (value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
}

/** @param {unknown} status */
function isStatus (status) {
  return Number.isInteger(status) && /** @type {number} */ (status) >= 200 && /** @type {number} */ (status) <= 599
}

/** @param {string} value */
function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest()
}

/**
 * Constant-time comparison of a `Bearer` token against the expected key.
 *
 * @param {string | undefined} header
 * @param {Buffer} expected sha256 of the key
 */
function keyMatches (header, expected) {
  const match = /^Bearer (.+)$/.exec(header ?? '')
  return match !== null && crypto.timingSafeEqual(sha256(match[1]), expected)
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json (res, status, body) {
  res.setHeader('content-type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

/**
 * Error in OpenAI's shape. Once a streamed response has started, the status
 * can no longer change, so an SSE stream gets a final error event instead.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function fail (res, status, message) {
  if (res.writableEnded) return
  const error = { error: { message, type: 'potluck_error' } }
  if (!res.headersSent) return json(res, status, error)
  if (String(res.getHeader('content-type')).startsWith('text/event-stream')) {
    res.end(`data: ${JSON.stringify(error)}\n\n`)
  } else {
    res.destroy()
  }
}
