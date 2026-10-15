// @ts-check
import { StringDecoder } from 'node:string_decoder'

// Newline-delimited JSON over one Hyperswarm connection (PRD D2).
//
// provider -> consumer   { t: 'hello', models: string[] }
// consumer -> provider   { t: 'req', id, method, path, body? }
// consumer -> provider   { t: 'cancel', id }
// provider -> consumer   { t: 'head', id, status, contentType }
// provider -> consumer   { t: 'chunk', id, d }        d = base64 bytes
// provider -> consumer   { t: 'end', id }
// provider -> consumer   { t: 'err', id, status, message }

// A single message larger than this ends the connection. Request bodies are
// capped well below it by the consumer.
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/**
 * @param {{ write: (data: string) => unknown, destroyed?: boolean }} conn
 * @param {object} message
 */
export function send (conn, message) {
  if (!conn.destroyed) conn.write(JSON.stringify(message) + '\n')
}

/**
 * Calls `onMessage` for every complete line. Malformed or oversized input
 * destroys the connection, since a member that sends it is misbehaving. So
 * does a message the handler throws on: one bad peer must not take down the
 * process.
 *
 * @param {import('node:stream').Duplex} conn
 * @param {(message: any) => void} onMessage
 */
export function onMessages (conn, onMessage) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  conn.on('data', (data) => {
    buffer += decoder.write(data)
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        conn.destroy(new Error('malformed message'))
        return
      }
      if (!message || typeof message.t !== 'string') continue
      try {
        onMessage(message)
      } catch (err) {
        conn.destroy(new Error(`protocol error: ${err.message}`))
        return
      }
    }
    if (buffer.length > MAX_MESSAGE_BYTES) conn.destroy(new Error('message too large'))
  })
}
