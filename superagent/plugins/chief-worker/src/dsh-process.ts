/** Streaming `dsh … --json` runner: parses newline-delimited run events as they arrive. */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dshBin } from '@superagent/testkit'

export interface DshStreamOptions {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly onEvent: (event: Record<string, unknown>) => void
  readonly logFile?: string
}

export interface DshStreamResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderrTail: string
}

export function runDshStreaming(options: DshStreamOptions): Promise<DshStreamResult> {
  return new Promise(resolve => {
    const child = spawn(dshBin(), [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let buffer = ''
    let stderr = ''
    let timedOut = false
    const kill = (): void => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch (alreadyExited) {
        void alreadyExited
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs)
    options.signal.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        if (options.logFile) appendFileSync(options.logFile, `${line}\n`)
        try {
          options.onEvent(JSON.parse(line) as Record<string, unknown>)
        } catch (notJson) {
          // Non-JSON stdout noise is logged above and otherwise ignored.
          void notJson
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
    })
    child.on('close', exitCode => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', kill)
      resolve({ exitCode, timedOut, stderrTail: stderr.slice(-4000) })
    })
  })
}
