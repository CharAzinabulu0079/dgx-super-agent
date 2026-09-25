import { createHash } from 'node:crypto'

const FAILURE_LINE = /(fail|error|exception|not ok|assert|expected|received|✗|✘|panic|traceback|cannot|undefined is not)/i

/**
 * Normalize output into a stable failure identity so the loop breaker can tell
 * "the same failure again" from "a different failure" across attempts.
 * Numbers, hex ids, durations, paths' temp segments and timestamps are erased.
 * @param gateId - gate the output belongs to.
 * @param output - raw combined output.
 * @returns `<gateId>:<12 hex>`.
 */
export function failureSignature(gateId: string, output: string): string {
  const lines = output.split('\n').filter(l => FAILURE_LINE.test(l))
  const basis = (lines.length ? lines : output.split('\n').slice(-20))
    .map(normalizeLine)
    .filter(Boolean)
    .slice(0, 40)
    .join('\n')
  return `${gateId}:${createHash('sha1').update(basis).digest('hex').slice(0, 12)}`
}

export function normalizeLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<ts>')
    .replace(/\/tmp\/[^\s/]+/g, '/tmp/<tmp>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec)\b/g, '<dur>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tail(text: string, lines = 40, maxChars = 4000): string {
  const t = text.split('\n').slice(-lines).join('\n')
  return t.length > maxChars ? t.slice(-maxChars) : t
}
