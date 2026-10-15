// @ts-check

// Values made only of these characters are written as they are. Anything else
// (spaces, newlines, quotes, non-ASCII) is JSON-quoted, so a value that comes
// from a peer can't start a new log line or pass as another field.
const PLAIN = /^[A-Za-z0-9._:/@+-]*$/

/**
 * One line per event on stderr: `<iso time> <event> key=value ...`.
 * Callers must never pass prompt or completion content.
 *
 * @param {{ write: (line: string) => unknown }} [stream]
 * @returns {(event: string, fields?: Record<string, unknown>) => void}
 */
export function createLogger (stream = process.stderr) {
  return (event, fields = {}) => {
    const parts = [new Date().toISOString(), event]
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) parts.push(`${key}=${formatValue(value)}`)
    }
    stream.write(parts.join(' ') + '\n')
  }
}

/** @param {unknown} value */
export function formatValue (value) {
  const text = String(value)
  return PLAIN.test(text) ? text : JSON.stringify(text)
}

/** Short, log-safe form of a public key. */
export function shortKey (key) {
  return Buffer.from(key).toString('hex').slice(0, 8)
}

/**
 * Logs rejected connections without letting someone who knows the topic
 * flood the log: each key at most once per window, and at most
 * `maxPerWindow` keys per window. The next line after a window with
 * suppressed attempts reports how many there were.
 *
 * @param {(event: string, fields?: Record<string, unknown>) => void} log
 * @param {{ windowMs?: number, maxPerWindow?: number, now?: () => number }} [opts]
 * @returns {(remoteKey: Buffer) => void}
 */
export function createRejectLogger (log, { windowMs = 60000, maxPerWindow = 20, now = Date.now } = {}) {
  let windowStart = -Infinity
  let logged = new Set()
  let suppressed = 0

  return (remoteKey) => {
    const time = now()
    if (time - windowStart >= windowMs) {
      if (suppressed) log('reject-suppressed', { count: suppressed })
      windowStart = time
      logged = new Set()
      suppressed = 0
    }
    const peer = shortKey(remoteKey)
    if (logged.has(peer) || logged.size >= maxPerWindow) {
      suppressed++
      return
    }
    logged.add(peer)
    log('reject', { peer })
  }
}
