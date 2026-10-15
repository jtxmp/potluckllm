// @ts-check
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import { MAX_PER_MEMBER, MAX_QUEUED, capTokens, startProvider } from '../src/provider.js'
import { startConsumer } from '../src/consumer.js'
import { loadOrCreateIdentity, publicKeyFromSeed } from '../src/identity.js'
import { addMember, createTeam, parseTeam, watchTeamFile, writeTeamFile } from '../src/team.js'
import { createLogger, createRejectLogger } from '../src/log.js'
import { onMessages, send } from '../src/protocol.js'
import { REPLY, startFakeOllama } from './fake-ollama.js'

let testnet
let fake
const cleanup = []

beforeAll(async () => {
  testnet = await createTestnet(3)
  fake = await startFakeOllama()
})

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

afterAll(async () => {
  await fake.close()
  await testnet.destroy()
})

function identity () {
  const seed = crypto.randomBytes(32)
  return { seed, key: publicKeyFromSeed(seed).toString('hex') }
}

// Teams built from the same `topic` find each other; each member list is
// that side's own allow-list.
function team (members, topic = crypto.randomBytes(32).toString('hex')) {
  let file = { ...createTeam('test', { name: 'm0', key: members[0].key }), topic }
  members.slice(1).forEach((m, i) => { file = addMember(file, `m${i + 1}`, m.key) })
  return parseTeam(file)
}

function logger () {
  const events = []
  const log = (event, fields = {}) => events.push({ event, ...fields })
  return { log, events, has: (event) => events.some((e) => e.event === event) }
}

async function waitFor (check, timeout = 15000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function provider (id, t, extra = {}) {
  const logs = logger()
  const node = await startProvider({ seed: id.seed, team: t, upstream: fake.url, bootstrap: testnet.bootstrap, log: logs.log, ...extra })
  cleanup.push(() => node.close())
  return { node, logs }
}

async function consumer (id, t, extra = {}) {
  const logs = logger()
  const node = await startConsumer({ seed: id.seed, team: t, port: 0, bootstrap: testnet.bootstrap, log: logs.log, ...extra })
  cleanup.push(() => node.close())
  const base = `http://127.0.0.1:${node.port}`
  return { node, logs, base }
}

async function connectedPair () {
  const a = identity()
  const b = identity()
  const t = team([a, b])
  const p = await provider(a, t)
  const c = await consumer(b, t)
  await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
  return { a, b, t, p, c }
}

// A member speaking the wire protocol directly, bypassing the consumer's
// own checks.
async function rawMember (id, t) {
  const swarm = new Hyperswarm({ seed: id.seed, bootstrap: testnet.bootstrap })
  cleanup.push(() => swarm.destroy())
  const conn = await new Promise((resolve) => {
    swarm.on('connection', (c) => { c.on('error', () => {}); resolve(c) })
    swarm.join(t.topic, { server: false, client: true })
  })
  const replies = []
  onMessages(conn, (msg) => replies.push(msg))
  return { conn, replies }
}

// A member running modified provider code: answers every request with
// whatever `reply(id)` returns.
async function rawProvider (id, t, reply) {
  const swarm = new Hyperswarm({ seed: id.seed, bootstrap: testnet.bootstrap })
  cleanup.push(() => swarm.destroy())
  swarm.on('connection', (conn) => {
    conn.on('error', () => {})
    send(conn, { t: 'hello', models: ['evil'] })
    onMessages(conn, (msg) => {
      if (msg.t === 'req') for (const m of reply(msg.id)) send(conn, m)
    })
  })
  await swarm.join(t.topic, { server: true, client: false }).flushed()
}

const POTLUCK = path.resolve(import.meta.dirname, '../bin/potluck.js')

function cli (args, home, cwd = home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [POTLUCK, ...args], { cwd, env: { ...process.env, HOME: home } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

function chat (base, model, stream = true, signal) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
    signal
  })
}

function sseContent (text) {
  return text.split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '')
    .join('')
}

describe('relay between team members', () => {
  test('lists the provider models', async () => {
    const { c } = await connectedPair()
    const res = await fetch(`${c.base}/v1/models`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map((m) => m.id)).toEqual(['fake-1b', 'fake-slow', 'fake-stall'])
    expect(body.data[0].owned_by).toBe('m0')
  })

  test('streams a chat completion intact and logs timings', async () => {
    const { c, p } = await connectedPair()
    const res = await chat(c.base, 'fake-1b')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(sseContent(text)).toBe(REPLY)
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    await waitFor(() => c.logs.has('end'))
    for (const event of ['request', 'first-chunk', 'end']) {
      expect(c.logs.has(event)).toBe(true)
      expect(p.logs.has(event)).toBe(true)
    }
  })

  test('returns a non-streamed completion', async () => {
    const { c } = await connectedPair()
    const res = await chat(c.base, 'fake-1b', false)
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe(REPLY)
  })

  test('never logs prompt content', async () => {
    const { c, p } = await connectedPair()
    await (await chat(c.base, 'fake-1b')).text()
    const logged = JSON.stringify([...c.logs.events, ...p.logs.events])
    expect(logged).not.toContain('hi')
    expect(logged).not.toContain('Ship the smaller')
  })
})

describe('discovery', () => {
  test('a consumer started before the provider still connects', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    const c = await consumer(b, t)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await provider(a, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0), 20000)
  })
})

describe('consumer errors', () => {
  test('503 when no member hosts the model', async () => {
    const { c } = await connectedPair()
    const res = await chat(c.base, 'gpt-5')
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain('gpt-5')
  })

  test('400 on invalid JSON, 404 on unknown routes, 413 on oversized bodies', async () => {
    const { c } = await connectedPair()
    const bad = await fetch(`${c.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(bad.status).toBe(400)
    const unknown = await fetch(`${c.base}/api/pull`, { method: 'POST', body: '{}' })
    expect(unknown.status).toBe(404)
    const big = await fetch(`${c.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) })
    expect(big.status).toBe(413)
  })
})

describe('access control', () => {
  test('provider rejects a consumer that is not on the team', async () => {
    const a = identity()
    const outsider = identity()
    const topic = crypto.randomBytes(32).toString('hex')
    const p = await provider(a, team([a], topic))
    // The outsider has the topic and lists the provider's key, but the
    // provider's team file does not list the outsider.
    const c = await consumer(outsider, team([outsider, a], topic))
    await waitFor(() => p.logs.has('reject'))
    expect(c.node.providers.size).toBe(0)
  })

  test('consumer rejects a provider that is not on the team', async () => {
    const b = identity()
    const rogue = identity()
    const topic = crypto.randomBytes(32).toString('hex')
    const p = await provider(rogue, team([rogue, b], topic))
    const c = await consumer(b, team([b], topic))
    await waitFor(() => c.logs.has('reject'))
    expect(c.node.providers.size).toBe(0)
    expect(p.logs.has('connect')).toBe(false)
  })

  test('provider never forwards routes outside the allow-list, even from a member', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await provider(a, t)

    const { conn, replies } = await rawMember(b, t)
    send(conn, { t: 'req', id: 'x', method: 'POST', path: '/api/pull', body: '{"name":"evil"}' })

    await waitFor(() => replies.some((m) => m.id === 'x'))
    expect(replies.find((m) => m.id === 'x')).toMatchObject({ t: 'err', status: 404 })
    expect(fake.calls).not.toContain('POST /api/pull')
  })

  test('refuses an upstream that is not on this machine', async () => {
    const a = identity()
    await expect(startProvider({ seed: a.seed, team: team([a]), upstream: 'http://example.com:11434', log: () => {} }))
      .rejects.toThrow(/not on this machine/)
  })
})

describe('failure handling', () => {
  test('provider dropping mid-stream ends the SSE stream with an error and the consumer keeps serving', async () => {
    const { c, p } = await connectedPair()
    const res = await chat(c.base, 'fake-slow')
    const reader = res.body.getReader()
    await reader.read()
    await p.node.close()

    let text = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += Buffer.from(value).toString()
    }
    expect(text).toContain('provider disconnected')

    const models = await fetch(`${c.base}/v1/models`)
    expect(models.status).toBe(200)
    expect((await models.json()).data).toEqual([])
  })

  test('client aborting a request cancels the upstream work', async () => {
    const { c, p } = await connectedPair()
    const controller = new AbortController()
    const res = await chat(c.base, 'fake-slow', true, controller.signal)
    await res.body.getReader().read()
    controller.abort()
    await waitFor(() => p.logs.has('cancelled'))
    expect(p.logs.has('end')).toBe(false)
  })
})

describe('status endpoint', () => {
  test('lists connected members by name with key prefixes and models', async () => {
    const { a, c } = await connectedPair()
    const res = await fetch(`${c.base}/potluck/status`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.team).toBe('test')
    expect(body.self).toHaveLength(8)
    expect(body.providers).toEqual([{ name: 'm0', key: a.key.slice(0, 8), models: ['fake-1b', 'fake-slow', 'fake-stall'], inFlight: 0 }])
  })
})

describe('provider limits', () => {
  test('runs one upstream request at a time, in order', async () => {
    const { c, p } = await connectedPair()
    fake.stats.maxActive = 0
    const texts = await Promise.all([1, 2, 3].map(async () => sseContent(await (await chat(c.base, 'fake-1b')).text())))
    expect(texts).toEqual([REPLY, REPLY, REPLY])
    expect(fake.stats.maxActive).toBe(1)
    expect(p.logs.has('queued')).toBe(true)
  })

  test('limits each member to a few requests at once', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    const p = await provider(a, t)
    const { conn, replies } = await rawMember(b, t)
    const body = JSON.stringify({ model: 'fake-slow', stream: true, messages: [] })
    for (let i = 0; i < MAX_PER_MEMBER + 2; i++) send(conn, { t: 'req', id: `q${i}`, method: 'POST', path: '/v1/chat/completions', body })
    await waitFor(() => replies.filter((m) => m.t === 'err' && m.status === 429).length === 2)
    expect(replies.filter((m) => m.t === 'err').map((m) => m.id)).toEqual([`q${MAX_PER_MEMBER}`, `q${MAX_PER_MEMBER + 1}`])
    expect(p.logs.events.some((e) => e.event === 'busy' && e.reason === 'member')).toBe(true)
  })

  test('answers 503 once the shared queue is full', async () => {
    const a = identity()
    const members = Array.from({ length: 5 }, identity)
    const t = team([a, ...members])
    const p = await provider(a, t)
    const raws = await Promise.all(members.map((m) => rawMember(m, t)))
    const body = JSON.stringify({ model: 'fake-slow', stream: true, messages: [] })
    // 5 members x 4 requests = 20: one runs, 16 wait, 3 are refused.
    raws.forEach(({ conn }, i) => {
      for (let j = 0; j < MAX_PER_MEMBER; j++) send(conn, { t: 'req', id: `m${i}-${j}`, method: 'POST', path: '/v1/chat/completions', body })
    })
    const refused = () => raws.flatMap((r) => r.replies).filter((m) => m.t === 'err' && m.status === 503)
    await waitFor(() => refused().length === 20 - 1 - MAX_QUEUED)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(refused()).toHaveLength(20 - 1 - MAX_QUEUED)
    expect(p.logs.has('busy')).toBe(true)
  })

  test('stops a request that streams past the total time limit', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    const p = await provider(a, t, { maxDurationMs: 300 })
    const c = await consumer(b, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    const text = await (await chat(c.base, 'fake-slow')).text()
    expect(text).toContain('exceeded')
    expect(p.logs.has('too-long')).toBe(true)
  })

  test('caps max_tokens on every chat request', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await provider(a, t, { maxTokens: 256 })
    const c = await consumer(b, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    const post = (extra) => fetch(`${c.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-1b', stream: false, messages: [], ...extra })
    }).then((r) => r.text())
    await post({ max_tokens: 1000000 })
    expect(fake.bodies.at(-1).max_tokens).toBe(256)
    await post({})
    expect(fake.bodies.at(-1).max_tokens).toBe(256)
    await post({ max_tokens: 50 })
    expect(fake.bodies.at(-1).max_tokens).toBe(50)
  })

  test('capTokens rejects bodies that are not JSON objects', () => {
    expect(capTokens('[1]', 10)).toBeNull()
    expect(capTokens('nope', 10)).toBeNull()
    expect(capTokens(undefined, 10)).toBeNull()
    expect(JSON.parse(capTokens('{"max_completion_tokens":-1}', 10))).toEqual({ max_completion_tokens: 10 })
  })

  test('aborts an upstream that goes quiet and tells the client', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    const p = await provider(a, t, { timeoutMs: 300 })
    const c = await consumer(b, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    const text = await (await chat(c.base, 'fake-stall')).text()
    expect(text).toContain('upstream sent nothing')
    expect(p.logs.has('timeout')).toBe(true)
  })
})

describe('shared identity', () => {
  test('a member can run serve and use with the same key', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await provider(a, t)
    await provider(b, t)
    // Consumer reuses b's key, as when one person runs both commands.
    const c = await consumer(b, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    const res = await chat(c.base, 'fake-1b')
    expect(sseContent(await res.text())).toBe(REPLY)
    const status = await (await fetch(`${c.base}/potluck/status`)).json()
    expect(status.providers.map((x) => x.name)).toEqual(['m0'])
  })
})

describe('team commands', () => {
  test('init creates a private team file with the caller as first member', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-cli-'))
    const id = await cli(['id'], home)
    const init = await cli(['team', 'init', 'demo', '--member', 'laptop-a'], home)
    expect(init.code).toBe(0)
    const file = path.join(home, 'team.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(data.name).toBe('demo')
    expect(data.members).toEqual([{ name: 'laptop-a', key: id.stdout.trim() }])
  })

  test('init refuses to overwrite an existing team file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-cli-'))
    await cli(['team', 'init', 'demo'], home)
    const before = fs.readFileSync(path.join(home, 'team.json'), 'utf8')
    const again = await cli(['team', 'init', 'other'], home)
    expect(again.code).toBe(1)
    expect(again.stderr).toContain('already exists')
    expect(fs.readFileSync(path.join(home, 'team.json'), 'utf8')).toBe(before)
  })

  test('add appends a member and rejects bad keys and duplicates', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-cli-'))
    await cli(['team', 'init', 'demo', '--member', 'a'], home)
    const b = identity()
    expect((await cli(['team', 'add', 'laptop-b', b.key.toUpperCase()], home)).code).toBe(0)
    expect((await cli(['team', 'add', 'x', 'nope'], home)).stderr).toContain('invalid public key')
    expect((await cli(['team', 'add', 'laptop-c', b.key], home)).stderr).toContain('already a member')
    const data = JSON.parse(fs.readFileSync(path.join(home, 'team.json'), 'utf8'))
    expect(data.members.map((m) => m.name)).toEqual(['a', 'laptop-b'])
    expect(data.members[1].key).toBe(b.key)
  })
})

describe('identity and team file', () => {
  test('creates a private identity once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-id-'))
    const first = loadOrCreateIdentity(dir)
    const second = loadOrCreateIdentity(dir)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.publicKey.equals(first.publicKey)).toBe(true)
    expect(fs.statSync(path.join(dir, 'identity.json')).mode & 0o777).toBe(0o600)
  })

  test('refuses an identity file other users can read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-id-'))
    loadOrCreateIdentity(dir)
    fs.chmodSync(path.join(dir, 'identity.json'), 0o644)
    expect(() => loadOrCreateIdentity(dir)).toThrow(/chmod 600/)
  })

  test('derives the same public key as Hyperswarm', async () => {
    const seed = crypto.randomBytes(32)
    const swarm = new Hyperswarm({ seed, bootstrap: testnet.bootstrap })
    expect(publicKeyFromSeed(seed).equals(swarm.keyPair.publicKey)).toBe(true)
    await swarm.destroy()
  })

  test('validates team files', () => {
    const a = identity()
    expect(() => addMember(createTeam('t', { name: 'a', key: a.key }), 'b', 'not-a-key')).toThrow(/invalid public key/)
    expect(() => addMember(createTeam('t', { name: 'a', key: a.key }), 'b', a.key)).toThrow(/already a member/)
    expect(() => parseTeam({ name: 't', topic: 'short', members: [] })).toThrow(/topic/)
  })
})

describe('local endpoint guard', () => {
  test('refuses a Host other than localhost, as DNS rebinding would send', async () => {
    const { c } = await connectedPair()
    // fetch sets Host itself, so send this one with http.request.
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: c.node.port, path: '/potluck/status', headers: { host: `rebind.example:${c.node.port}` } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      }).on('error', reject)
    })
    expect(status).toBe(421)
    expect(c.logs.events.some((e) => e.event === 'refused' && e.reason === 'host')).toBe(true)
  })

  test('refuses cross-site requests before anything reaches the provider', async () => {
    const { c } = await connectedPair()
    const before = fake.calls.length
    const fromPage = await fetch(`${c.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ model: 'fake-1b', messages: [] })
    })
    expect(fromPage.status).toBe(403)
    // The form-style request a page can send without a CORS preflight.
    const simple = await fetch(`${c.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ model: 'fake-1b', messages: [] })
    })
    expect(simple.status).toBe(415)
    expect(fake.calls.length).toBe(before)
  })

  test('serves an allowed origin, including the CORS preflight', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await provider(a, t)
    const c = await consumer(b, t, { allowOrigins: ['http://localhost:3000'] })
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    const preflight = await fetch(`${c.base}/v1/chat/completions`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    const res = await fetch(`${c.base}/v1/models`, { headers: { origin: 'http://localhost:3000' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('requires the API key when one is set', async () => {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await provider(a, t)
    const c = await consumer(b, t, { apiKey: 'correct-key' })
    expect((await fetch(`${c.base}/v1/models`)).status).toBe(401)
    expect((await fetch(`${c.base}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${c.base}/v1/models`, { headers: { authorization: 'Bearer correct-key' } })).status).toBe(200)
  })
})

describe('hostile provider', () => {
  async function against (reply) {
    const a = identity()
    const b = identity()
    const t = team([a, b])
    await rawProvider(a, t, reply)
    const c = await consumer(b, t)
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0))
    // A broken reply may end the HTTP connection instead of sending a status.
    const res = await chat(c.base, 'evil', false).catch(() => null)
    return { c, res }
  }

  test('an invalid status closes that provider, not the consumer', async () => {
    const { c, res } = await against((id) => [{ t: 'head', id, status: 'not-a-status', contentType: 'application/json' }])
    expect(res.status).toBe(502)
    await waitFor(() => c.logs.has('disconnect'))
    expect((await fetch(`${c.base}/potluck/status`)).status).toBe(200)
  })

  test('a content type other than JSON or SSE is refused', async () => {
    const { c, res } = await against((id) => [
      { t: 'head', id, status: 200, contentType: 'text/html' },
      { t: 'chunk', id, d: Buffer.from('<script>alert(1)</script>').toString('base64') },
      { t: 'end', id }
    ])
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.text()).not.toContain('<script>')
    // A bad reply fails that request only; the provider stays connected.
    expect(c.node.providers.size).toBe(1)
  })

  test('malformed chunks close that provider, not the consumer', async () => {
    const { c, res } = await against((id) => [
      { t: 'head', id, status: 200, contentType: 'application/json' },
      { t: 'chunk', id, d: 12345 }
    ])
    await res?.text().catch(() => {})
    await waitFor(() => c.logs.has('disconnect'))
    expect((await fetch(`${c.base}/potluck/status`)).status).toBe(200)
  })
})

describe('logging', () => {
  test('a value from a peer cannot forge a log line', () => {
    const lines = []
    const log = createLogger({ write: (line) => lines.push(line) })
    log('error', { status: '502\n2026-01-01T00:00:00.000Z reject peer=deadbeef', peer: 'abcd1234' })
    expect(lines).toHaveLength(1)
    expect(lines[0].trim().split('\n')).toHaveLength(1)
    expect(lines[0]).toContain('status="502\\n2026')
    expect(lines[0]).toContain('peer=abcd1234')
  })

  test('rejected connections are logged at a bounded rate', () => {
    const events = []
    let time = 0
    const logReject = createRejectLogger((event, fields) => events.push({ event, ...fields }), { windowMs: 1000, maxPerWindow: 2, now: () => time })
    const key = (n) => Buffer.alloc(32, n)
    logReject(key(1))
    logReject(key(1))
    logReject(key(2))
    logReject(key(3))
    expect(events.map((e) => e.event)).toEqual(['reject', 'reject'])
    time = 1000
    logReject(key(1))
    expect(events.slice(2)).toEqual([{ event: 'reject-suppressed', count: 2 }, { event: 'reject', peer: '01010101' }])
  })
})

describe('team changes without a restart', () => {
  test('removing a member disconnects them at once', async () => {
    const { a, b, t, p, c } = await connectedPair()
    p.node.updateTeam(parseTeam({ name: t.name, topic: t.topic.toString('hex'), members: [{ name: 'm0', key: a.key }] }))
    await waitFor(() => c.node.providers.size === 0)
    expect(p.logs.events.some((e) => e.event === 'removed' && e.peer === b.key.slice(0, 8))).toBe(true)
  })

  test('adding a member who was rejected earlier lets them connect', async () => {
    const a = identity()
    const b = identity()
    const topic = crypto.randomBytes(32).toString('hex')
    const p = await provider(a, team([a], topic))
    const c = await consumer(b, team([b, a], topic))
    await waitFor(() => p.logs.has('reject'))
    p.node.updateTeam(team([a, b], topic))
    await waitFor(() => [...c.node.providers.values()].some((x) => x.models.length > 0), 25000)
  }, 30000)

  test('refuses a changed topic', async () => {
    const { a, p } = await connectedPair()
    expect(() => p.node.updateTeam(team([a]))).toThrow(/topic changed/)
  })

  test('watchTeamFile reports edits, including atomic replacement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-watch-'))
    const file = path.join(dir, 'team.json')
    const a = identity()
    const data = createTeam('t', { name: 'a', key: a.key })
    writeTeamFile(file, data, { create: true })
    const seen = []
    const errors = []
    const stop = watchTeamFile(file, (next) => seen.push(next.members.length), (err) => errors.push(err.message), { intervalMs: 50 })
    cleanup.push(async () => stop())
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeTeamFile(file, addMember(data, 'b', identity().key))
    await waitFor(() => seen.includes(2), 5000)
    fs.writeFileSync(file, '{broken')
    await waitFor(() => errors.length > 0, 5000)
  })
})

describe('local hardening', () => {
  test('refuses an identity folder other users can write to', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-id-'))
    fs.chmodSync(dir, 0o777)
    expect(() => loadOrCreateIdentity(dir)).toThrow(/chmod 700/)
  })

  test('team init warns when the team file would be committed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-cli-'))
    await new Promise((resolve) => execFile('git', ['init', '-q'], { cwd: home }, resolve))
    const warned = await cli(['team', 'init', 'demo'], home)
    expect(warned.stderr).toContain('.gitignore')
    fs.rmSync(path.join(home, 'team.json'))
    fs.writeFileSync(path.join(home, '.gitignore'), 'team.json\n')
    const quiet = await cli(['team', 'init', 'demo'], home)
    expect(quiet.code).toBe(0)
    expect(quiet.stderr).not.toContain('.gitignore')
  })

  test('logs a warning for a remote upstream over plain HTTP', async () => {
    const a = identity()
    const p = await provider(a, team([a]), { upstream: 'http://192.0.2.1:11434', allowRemoteUpstream: true })
    expect(p.logs.events).toContainEqual({ event: 'insecure-upstream', upstream: 'http://192.0.2.1:11434' })
  })
})
