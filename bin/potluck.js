#!/usr/bin/env node
// @ts-check
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { loadOrCreateIdentity, defaultIdentityDir } from '../src/identity.js'
import { readTeam } from '../src/team.js'
import { startProvider } from '../src/provider.js'
import { startConsumer } from '../src/consumer.js'
import { createLogger } from '../src/log.js'

const USAGE = `potluck: your team's private LLMs, shared peer-to-peer

Usage:
  potluck id                                   Print your public key (creates it on first run)
  potluck serve --team <file> [--upstream <url>] [--allow-remote-upstream]
                                               Share your local models with the team
  potluck use --team <file> [--port <n>]       Use the team's models at http://127.0.0.1:<port>/v1

Options:
  --team <file>        Team file (default: ./team.json)
  --upstream <url>     OpenAI-compatible server to share (default: http://127.0.0.1:11434)
  --port <n>           Local port for 'use' (default: 11500)
  --bootstrap <list>   DHT bootstrap nodes as host:port,host:port (for local testing)
  -h, --help           Show this help
  -v, --version        Show the version`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: 'string', default: 'team.json' },
    upstream: { type: 'string', default: 'http://127.0.0.1:11434' },
    'allow-remote-upstream': { type: 'boolean', default: false },
    port: { type: 'string', default: '11500' },
    bootstrap: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
  }
})

const log = createLogger()

async function main () {
  const [command] = positionals

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return
  }

  if (values.help || !command) {
    console.log(USAGE)
    return
  }

  if (command === 'id') {
    const identity = loadOrCreateIdentity()
    if (identity.created) console.error(`Created a new identity in ${defaultIdentityDir()}`)
    console.log(identity.publicKey.toString('hex'))
    return
  }

  if (command === 'serve' || command === 'use') {
    const { seed } = loadOrCreateIdentity()
    const team = readTeam(values.team)
    const bootstrap = parseBootstrap(values.bootstrap)

    const node = command === 'serve'
      ? await startProvider({ seed, team, upstream: values.upstream, allowRemoteUpstream: values['allow-remote-upstream'], bootstrap, log })
      : await startConsumer({ seed, team, port: parsePort(values.port), bootstrap, log })

    const shutdown = () => {
      log('shutdown')
      node.close().then(() => process.exit(0), () => process.exit(1))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return
  }

  throw new Error(`unknown command "${command}". Run: potluck --help`)
}

/** @param {string | undefined} list */
function parseBootstrap (list) {
  if (!list) return undefined
  return list.split(',').map((entry) => {
    const [host, port] = entry.split(':')
    return { host, port: Number(port) }
  })
}

/** @param {string} value */
function parsePort (value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port "${value}"`)
  return port
}

main().catch((err) => {
  console.error(`potluck: ${err.message}`)
  process.exit(1)
})
