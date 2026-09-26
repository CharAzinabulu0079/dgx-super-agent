/** Streaming `dsh … --json` runner: parses newline-delimited run events as they arrive. */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshBin } from '@superagent/testkit'

/** API credentials never reach a Worker process (it could otherwise resolve Human Gates over HTTP). */
export const SCRUBBED_WORKER_ENV = ['SUPERAGENT_TOKEN', 'SUPERAGENT_HUMAN_TOKEN', 'SUPERAGENT_AGENT_TOKEN']

/**
 * Child environment. Credentials are never inherited from this process (e.g. an exported
 * `SUPERAGENT_HUMAN_TOKEN` for `sa serve`); with `keepCredentials` only those passed
 * explicitly in `extra` (the Chief's agent token) reach the child.
 */
export function workerEnv(extra: Record<string, string | undefined>, keepCredentials = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of SCRUBBED_WORKER_ENV) delete env[k]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  if (!keepCredentials) for (const k of SCRUBBED_WORKER_ENV) delete env[k]
  return env
}

/**
 * Read isolation for model sessions without a second OS user (NEXT_STEPS P0 #2): the
 * DSH Landlock sandbox only confines writes, so a same-user Worker could still *read*
 * the agent token, held-out tests or the service's human token. When bubblewrap works
 * (unprivileged user namespaces), non-Chief sessions run with those paths covered by
 * empty tmpfs mounts. Everything else (project, model server, DSH home) is unchanged.
 * `SUPERAGENT_SANDBOX=off` disables it; without bwrap the old behaviour stays and
 * health reports it.
 */
export function hiddenPaths(stateHome: string | undefined, home = homedir()): string[] {
  const paths = [join(home, '.config', 'superagent')]
  if (stateHome) paths.push(...['secrets', 'heldout', 'backups'].map(d => join(stateHome, d)))
  return paths.filter(p => existsSync(p))
}

let bwrapWorks: boolean | undefined
export function readIsolation(): { available: boolean; reason: string } {
  if (process.env.SUPERAGENT_SANDBOX === 'off') return { available: false, reason: 'disabled (SUPERAGENT_SANDBOX=off)' }
  bwrapWorks ??= spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true'], { stdio: 'ignore', timeout: 5_000 }).status === 0
  return bwrapWorks
    ? { available: true, reason: 'bubblewrap hides secrets, held-out tests, backups and ~/.config/superagent from Workers' }
    : { available: false, reason: 'bubblewrap (bwrap) not usable: Workers can read secrets and held-out tests as the server user' }
}

/** `[command, args]` for a model session, wrapped in bwrap when isolation applies. */
export function sandboxed(bin: string, args: readonly string[], hide: readonly string[]): [string, string[]] {
  if (!hide.length || !readIsolation().available) return [bin, [...args]]
  return ['bwrap', ['--dev-bind', '/', '/', '--die-with-parent', ...hide.flatMap(p => ['--tmpfs', p]), '--', bin, ...args]]
}

export interface DshStreamOptions {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly onEvent: (event: Record<string, unknown>) => void
  readonly logFile?: string
  /** Only the Chief channel passes its agent token through; Workers never do. */
  readonly keepCredentials?: boolean
  readonly onSpawn?: (pid: number) => void
}

export interface DshStreamResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderrTail: string
}

export function runDshStreaming(options: DshStreamOptions): Promise<DshStreamResult> {
  return new Promise(resolve => {
    // The Chief keeps its agent token by design; every other session is read-isolated.
    const [bin, argv] = options.keepCredentials ? [dshBin(), [...options.args]] : sandboxed(dshBin(), options.args, hiddenPaths(options.env.SUPERAGENT_HOME))
    const child = spawn(bin, argv, {
      cwd: options.cwd,
      env: workerEnv(options.env, options.keepCredentials),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    if (child.pid) options.onSpawn?.(child.pid)
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
