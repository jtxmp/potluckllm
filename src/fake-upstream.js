// @ts-check
// Fake OpenAI-compatible upstream for `potluck try`, development and tests
// (PRD D7). Lets anyone see potluck work without a GPU or Ollama.
//
//   fake-1b     streams REPLY one word per SSE event
//   fake-slow   streams 200 events, 50 ms apart, for disconnect tests
//   fake-stall  sends one event, then nothing until the client leaves
//
// Also serves /api/pull so tests can prove the provider never forwards it.
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const REPLY = 'Ship the smaller scope first and measure.'
export const MODELS = ['fake-1b', 'fake-slow', 'fake-stall']

/** @param {number} [port] */
export async function startFakeUpstream (port = 0) {
  const calls = []
  // Parsed chat request bodies, to check what the provider forwards.
  const bodies = []
  // Concurrent chat completions, to check the provider's queue.
  const stats = { active: 0, maxActive: 0 }

  const server = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`)

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
      return
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      bodies.push(parsed)
      const { model, stream } = parsed
      stats.maxActive = Math.max(stats.maxActive, ++stats.active)
      res.on('close', () => stats.active--)

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model, choices: [{ index: 0, message: { role: 'assistant', content: REPLY } }] }))
        return
      }

      if (model === 'fake-stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'hm' } }] })}\n\n`)
        return
      }

      const words = model === 'fake-slow' ? Array.from({ length: 200 }, (_, i) => `w${i} `) : REPLY.split(/(?<= )/)
      const delay = model === 'fake-slow' ? 50 : 5
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const word of words) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: word } }] })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      res.end('data: [DONE]\n\n')
      return
    }

    if (req.url === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"pulling"}')
      return
    }

    res.writeHead(404).end()
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    bodies,
    stats,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFakeUpstream(Number(process.argv[2] ?? 11434))
  console.error(`fake upstream on ${fake.url} (models: ${MODELS.join(', ')})`)
}
