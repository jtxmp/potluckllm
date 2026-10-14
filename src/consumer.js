// @ts-check
import http from 'node:http'
import { EventEmitter } from 'node:events'
import Hyperswarm from 'hyperswarm'
import { onMessages, send } from './protocol.js'
import { shortKey } from './log.js'

const MAX_BODY_BYTES = 1024 * 1024
const MIN_LOOKUP_MS = 5000
const MAX_LOOKUP_MS = 60000

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
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   port?: number,
 *   bootstrap?: { host: string, port: number }[],
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startConsumer ({ seed, team, port = 11500, bootstrap, log }) {
  /** @type {Map<string, Provider>} */
  const providers = new Map()
  const events = new EventEmitter()
  let nextId = 0

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
    const key = conn.remotePublicKey.toString('hex')
    const peer = key.slice(0, 8)
    /** @type {Provider} */
    const provider = { key, name: team.memberName(conn.remotePublicKey), conn, models: [], pending: new Map() }
    providers.set(key, provider)
    log('connect', { peer, member: provider.name })

    conn.on('error', (err) => log('conn-error', { peer, err: err.code || err.message }))
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
        provider.models = Array.isArray(msg.models) ? msg.models.filter((m) => typeof m === 'string') : []
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
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: listModels() })
    }

    if (req.method === 'GET' && pathname === '/potluck/status') {
      return json(res, 200, status())
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
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
   * @param {Provider} provider
   * @param {{ method: string, path: string, body?: string }} request
   * @param {http.ServerResponse} res
   */
  function relay (provider, request, res) {
    const id = String(++nextId)
    const peer = provider.key.slice(0, 8)
    const started = Date.now()
    let first = true

    const finish = () => provider.pending.delete(id)
    provider.pending.set(id, {
      onMessage (msg) {
        if (msg.t === 'head') {
          // setHeader, not writeHead options, so fail() can read it back.
          res.setHeader('content-type', msg.contentType || 'application/json')
          res.writeHead(msg.status)
        } else if (msg.t === 'chunk') {
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
          log('error', { peer, id, status: msg.status })
          fail(res, msg.status || 502, msg.message || 'provider error')
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

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  log('listening', { url: `http://127.0.0.1:${address.port}/v1`, team: team.name, key: shortKey(swarm.keyPair.publicKey) })

  return {
    port: address.port,
    providers,
    events,
    publicKey: swarm.keyPair.publicKey,
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
