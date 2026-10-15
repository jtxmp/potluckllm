#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { loadOrCreateIdentity, defaultIdentityDir } from '../src/identity.js'
import { addMember, createTeam, readTeam, readTeamFile, watchTeamFile, writeTeamFile } from '../src/team.js'
import { startProvider } from '../src/provider.js'
import { startConsumer } from '../src/consumer.js'
import { createLogger } from '../src/log.js'

const USAGE = `potluck: your team's private LLMs, shared peer-to-peer

Usage:
  potluck id                                   Print your public key (creates it on first run)
  potluck team init <team-name> [--member <name>]
                                               Create a team file with you as the first member
  potluck team add <name> <public-key>         Add a member to the team file
  potluck serve [--upstream <url>] [--timeout <s>] [--max-duration <s>] [--max-tokens <n>]
                                               Share your local models with the team
  potluck use [--port <n>] [--allow-origin <list>]
                                               Use the team's models at http://127.0.0.1:<port>/v1

Options:
  --team <file>        Team file (default: ./team.json)
  --member <name>      Your name in a new team file (default: this machine's hostname)
  --upstream <url>     OpenAI-compatible server to share (default: http://127.0.0.1:11434)
  --timeout <s>        Abort an upstream request after this many idle seconds (default: 120)
  --max-duration <s>   Abort any request after this many seconds in total (default: 600)
  --max-tokens <n>     Cap max_tokens on every chat request (default: 4096)
  --allow-remote-upstream
                       Allow an upstream that is not on this machine
  --port <n>           Local port for 'use' (default: 11500)
  --allow-origin <list>
                       Web origins allowed to call 'use', as a comma-separated list
                       (default: none; requests from web pages are refused)
  --bootstrap <list>   DHT bootstrap nodes as host:port,host:port (for local testing)
  -h, --help           Show this help
  -v, --version        Show the version

Environment:
  POTLUCK_API_KEY      If set, 'use' requires it as the API key (Authorization: Bearer)

Both 'serve' and 'use' reload the team file when it changes. Removed members
are disconnected at once.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: 'string', default: 'team.json' },
    member: { type: 'string' },
    upstream: { type: 'string', default: 'http://127.0.0.1:11434' },
    timeout: { type: 'string', default: '120' },
    'max-duration': { type: 'string', default: '600' },
    'max-tokens': { type: 'string', default: '4096' },
    'allow-origin': { type: 'string' },
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

  if (command === 'team') {
    teamCommand(positionals.slice(1))
    return
  }

  if (command === 'serve' || command === 'use') {
    const { seed } = loadOrCreateIdentity()
    const team = readTeam(values.team)
    const bootstrap = parseBootstrap(values.bootstrap)

    const node = command === 'serve'
      ? await startProvider({
        seed,
        team,
        upstream: values.upstream,
        timeoutMs: parseSeconds(values.timeout) * 1000,
        maxDurationMs: parseSeconds(values['max-duration']) * 1000,
        maxTokens: parseCount(values['max-tokens']),
        allowRemoteUpstream: values['allow-remote-upstream'],
        bootstrap,
        log
      })
      : await startConsumer({
        seed,
        team,
        port: parsePort(values.port),
        apiKey: process.env.POTLUCK_API_KEY || undefined,
        allowOrigins: parseList(values['allow-origin']),
        bootstrap,
        log
      })

    const stopWatching = watchTeamFile(values.team, (next) => {
      try {
        node.updateTeam(next)
      } catch (err) {
        log('team-reload-error', { err: err.message })
      }
    }, (err) => log('team-reload-error', { err: err.message }))

    const shutdown = () => {
      log('shutdown')
      stopWatching()
      node.close().then(() => process.exit(0), () => process.exit(1))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return
  }

  throw new Error(`unknown command "${command}". Run: potluck --help`)
}

/** @param {string[]} args */
function teamCommand ([sub, ...args]) {
  if (sub === 'init') {
    const [teamName] = args
    if (!teamName) throw new Error('usage: potluck team init <team-name> [--member <name>]')
    const { publicKey } = loadOrCreateIdentity()
    const member = values.member ?? os.hostname()
    try {
      writeTeamFile(values.team, createTeam(teamName, { name: member, key: publicKey.toString('hex') }), { create: true })
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`${values.team} already exists. Delete it first or pass --team <other file>.`)
      throw err
    }
    console.log(`Created ${values.team} for team "${teamName}" with you as "${member}".`)
    if (trackedByGit(values.team)) {
      console.error(`Warning: ${values.team} is inside a git repository and not ignored. Add it to .gitignore so the topic and member list are never committed.`)
    }
    console.log('Add members with: potluck team add <name> <public-key>')
    console.log('Then share the file with them over a private channel.')
    return
  }

  if (sub === 'add') {
    const [name, key] = args
    if (!name || !key) throw new Error('usage: potluck team add <name> <public-key>')
    writeTeamFile(values.team, addMember(readTeamFile(values.team), name, key.toLowerCase()))
    console.log(`Added "${name}" (${key.slice(0, 8)}) to ${values.team}. Share the updated file with the team.`)
    return
  }

  throw new Error('usage: potluck team init <team-name> | potluck team add <name> <public-key>')
}

/** @param {string} value */
function parseSeconds (value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid timeout "${value}"`)
  return seconds
}

/**
 * True when `file` is inside a git work tree and git would not ignore it.
 * False when it is ignored, outside a repository, or git is not installed.
 *
 * @param {string} file
 */
function trackedByGit (file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { stdio: 'ignore' })
    return false
  } catch (err) {
    // check-ignore exits 1 for "not ignored" and 128 outside a repository.
    return err.status === 1
  }
}

/** @param {string} value */
function parseCount (value) {
  const count = Number(value)
  if (!Number.isInteger(count) || count <= 0) throw new Error(`invalid number "${value}"`)
  return count
}

/** @param {string | undefined} list */
function parseList (list) {
  return list ? list.split(',').map((item) => item.trim()).filter(Boolean) : []
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
