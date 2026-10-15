#!/usr/bin/env node
// @ts-check
// M3 rehearsal: measures the PRD section 7 metrics on real networks.
//
//   provider machine:  potluck serve                      (leave it running)
//                      node scripts/rehearse.js baseline --label home
//   consumer machine:  node scripts/rehearse.js consumer --label home-hotspot
//   either machine:    node scripts/rehearse.js summary
//
// Results go to rehearsal/<label>-<mode>.json. They hold timings, status codes
// and key prefixes only: no prompts, completions, IP addresses or hostnames.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const BIN = path.join(ROOT, 'bin', 'potluck.js')
const OUT = path.join(ROOT, 'rehearsal')
const PROMPT = 'In two sentences, why should a team ship a smaller scope first?'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string' },
    model: { type: 'string', default: 'llama3.2:3b' },
    runs: { type: 'string', default: '6' },
    starts: { type: 'string', default: '5' },
    team: { type: 'string', default: 'team.json' },
    port: { type: 'string', default: '11510' },
    upstream: { type: 'string', default: 'http://127.0.0.1:11434' },
    'connect-timeout': { type: 'string', default: '60' }
  }
})

const [mode] = positionals

if (mode === 'baseline') await baseline()
else if (mode === 'consumer') await consumer()
else if (mode === 'summary') summary()
else {
  console.error('usage: node scripts/rehearse.js baseline|consumer --label <name> [--model m] [--runs n] [--starts n]\n       node scripts/rehearse.js summary')
  process.exit(1)
}

// Calls the upstream directly on the provider, for the "added time to first
// token" comparison.
async function baseline () {
  const label = requireLabel()
  await chat(values.upstream) // warm-up: loads the model into GPU memory
  const requests = []
  for (let i = 0; i < Number(values.runs); i++) requests.push(await chat(values.upstream))
  save(label, 'baseline', { requests })
  print(requests)
}

// Starts `potluck use` several times. Each start records how long discovery
// takes, then sends requests through it.
async function consumer () {
  const label = requireLabel()
  const base = `http://127.0.0.1:${values.port}`
  const starts = []

  for (let s = 0; s < Number(values.starts); s++) {
    console.error(`start ${s + 1}/${values.starts}: waiting for a provider (up to ${values['connect-timeout']} s)`)
    const t0 = performance.now()
    const child = spawn(process.execPath, [BIN, 'use', '--team', values.team, '--port', values.port], { stdio: ['ignore', 'ignore', 'pipe'] })
    const events = watch(child, t0)

    const hello = await Promise.race([
      events.wait('hello'),
      new Promise((resolve) => setTimeout(() => resolve(null), Number(values['connect-timeout']) * 1000)),
      events.exited
    ])

    /** @type {Record<string, unknown>} */
    const start = { start: s + 1, connected: Boolean(hello) }
    if (hello) {
      start.connectMs = events.at('connect')
      start.helloMs = events.at('hello')
      start.provider = hello.peer
      if (s === 0) await chat(base) // warm-up, not recorded
      start.requests = []
      for (let i = 0; i < Number(values.runs); i++) start.requests.push(await chat(base))
    } else {
      console.error(`start ${s + 1}: no provider within the timeout`)
    }
    starts.push(start)

    child.kill('SIGINT')
    await events.exited
    // Give the provider time to notice the disconnect before the next start.
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  save(label, 'consumer', { starts })
  const connected = starts.filter((s) => s.connected)
  console.log(`connected ${connected.length} of ${starts.length} starts, median time to provider ${ms(median(connected.map((s) => /** @type {number} */ (s.helloMs))))}`)
  print(connected.flatMap((s) => /** @type {any[]} */ (s.requests)))
}

function summary () {
  if (!fs.existsSync(OUT)) {
    console.error('no results yet in rehearsal/')
    process.exit(1)
  }
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).sort()
  const results = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
  const baselines = results.filter((r) => r.mode === 'baseline')
  const baselineTtft = median(baselines.flatMap((r) => r.requests.filter(ok).map((q) => q.ttftMs)))

  console.log(`provider baseline (${baselines.length} file(s)): median time to first token ${ms(baselineTtft)}`)
  console.log('')
  console.log('| Network pair | Starts connected | Median time to provider | Median time to first token | Added vs baseline | Median total | Failed requests |')
  console.log('|---|---|---|---|---|---|---|')
  for (const r of results.filter((x) => x.mode === 'consumer')) {
    const connected = r.starts.filter((s) => s.connected)
    const requests = connected.flatMap((s) => s.requests)
    const good = requests.filter(ok)
    const ttft = median(good.map((q) => q.ttftMs))
    const added = ttft === null || baselineTtft === null ? 'n/a' : ms(round(ttft - baselineTtft))
    console.log(`| ${r.label} | ${connected.length} of ${r.starts.length} | ${ms(median(connected.map((s) => s.helloMs)))} | ${ms(ttft)} | ${added} | ${ms(median(good.map((q) => q.totalMs)))} | ${requests.length - good.length} of ${requests.length} |`)
  }
}

/**
 * Streams one chat completion and times it from the client side.
 *
 * @param {string} base
 */
async function chat (base) {
  const t0 = performance.now()
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: values.model, stream: true, temperature: 0, seed: 1, messages: [{ role: 'user', content: PROMPT }] })
    })
    let ttftMs = null
    let chunks = 0
    let buf = ''
    for await (const piece of res.body ?? []) {
      buf += Buffer.from(piece).toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
        if (!delta) continue
        chunks++
        if (ttftMs === null) ttftMs = round(performance.now() - t0)
      }
    }
    return { status: res.status, ttftMs, totalMs: round(performance.now() - t0), chunks }
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message, ttftMs: null, totalMs: round(performance.now() - t0), chunks: 0 }
  }
}

/**
 * Follows the child's log lines (`<iso> <event> k=v ...`) and records when
 * each event first appeared, relative to t0.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} t0
 */
function watch (child, t0) {
  /** @type {Map<string, { ms: number, fields: Record<string, string> }>} */
  const seen = new Map()
  /** @type {Map<string, (fields: Record<string, string>) => void>} */
  const waiters = new Map()
  let buf = ''

  child.stderr?.on('data', (data) => {
    buf += data.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const [, event, ...rest] = buf.slice(0, nl).split(' ')
      buf = buf.slice(nl + 1)
      if (!event || seen.has(event)) continue
      const fields = Object.fromEntries(rest.map((kv) => kv.split('=')))
      seen.set(event, { ms: round(performance.now() - t0), fields })
      waiters.get(event)?.(fields)
    }
  })

  return {
    /** @param {string} event @returns {Promise<Record<string, string>>} */
    wait: (event) => new Promise((resolve) => {
      const hit = seen.get(event)
      if (hit) resolve(hit.fields)
      else waiters.set(event, resolve)
    }),
    /** @param {string} event */
    at: (event) => seen.get(event)?.ms ?? null,
    /** @type {Promise<null>} */
    exited: new Promise((resolve) => child.once('exit', () => resolve(null)))
  }
}

function requireLabel () {
  if (!values.label || !/^[a-z0-9-]+$/i.test(values.label)) {
    console.error('pass --label <name>, letters, digits and dashes only, for example --label home-hotspot')
    process.exit(1)
  }
  return values.label
}

/**
 * @param {string} label
 * @param {string} mode
 * @param {Record<string, unknown>} data
 */
function save (label, mode, data) {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${label}-${mode}.json`)
  const record = { label, mode, at: new Date().toISOString(), model: values.model, node: process.version, platform: os.platform(), ...data }
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  console.error(`saved ${file}`)
}

/** @param {{ status: number, ttftMs: number | null, totalMs: number }[]} requests */
function print (requests) {
  const good = requests.filter(ok)
  console.log(`requests ok ${good.length} of ${requests.length}, median time to first token ${ms(median(good.map((q) => q.ttftMs)))}, median total ${ms(median(good.map((q) => q.totalMs)))}`)
}

/** @param {{ status: number, ttftMs: number | null }} q */
function ok (q) {
  return q.status === 200 && q.ttftMs !== null
}

/** @param {(number | null)[]} xs */
function median (xs) {
  const sorted = /** @type {number[]} */ (xs.filter((x) => typeof x === 'number')).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** @param {number | null} x */
function ms (x) {
  return x === null ? 'n/a' : `${x} ms`
}

/** @param {number} x */
function round (x) {
  return Math.round(x * 10) / 10
}
