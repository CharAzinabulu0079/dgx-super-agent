/**
 * Launch the pinned DSH runtime (`node_modules/.bin/dsh`) as a subprocess.
 *
 * stdin is always `ignore`: `dsh headless` reads a piped stdin to EOF, so an open
 * pipe hangs the run.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Resolve the pinned `dsh` binary, preferring `SUPERAGENT_DSH_BIN`. */
export function dshBin(): string {
  const override = process.env.SUPERAGENT_DSH_BIN
  if (override) return override
  const local = join(REPO_ROOT, 'node_modules', '.bin', 'dsh')
  if (!existsSync(local)) throw new Error(`pinned dsh runtime missing at ${local}; run \`pnpm install\` at the repo root`)
  return local
}

export interface DshRunOptions {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface DshRunResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
}

/**
 * Run `dsh <args>` to completion.
 * @param options - argv, working directory, extra environment, timeout.
 * @returns captured output and exit status; never throws on non-zero exit.
 */
export function runDsh(options: DshRunOptions): Promise<DshRunResult> {
  const started = Date.now()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dshBin(), [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, options.timeoutMs ?? 300_000)
    child.on('error', error => {
      clearTimeout(timer)
      if ((error as NodeJS.ErrnoException).name === 'AbortError') {
        resolvePromise({ exitCode: null, signal: 'SIGTERM', stdout, stderr, timedOut, durationMs: Date.now() - started })
      } else reject(error)
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - started })
    })
  })
}
