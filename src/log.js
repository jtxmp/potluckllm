// @ts-check

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
      if (value !== undefined) parts.push(`${key}=${value}`)
    }
    stream.write(parts.join(' ') + '\n')
  }
}

/** Short, log-safe form of a public key. */
export function shortKey (key) {
  return Buffer.from(key).toString('hex').slice(0, 8)
}
