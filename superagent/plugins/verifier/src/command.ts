/**
 * `command` / `e2e` gate runner: deterministic shell command, parsed by exit code,
 * node:test TAP/spec summary, or Playwright JSON reporter output.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GateResult, GateSpec } from '@superagent/contracts'
import { failureSignature, tail } from './signature.ts'

export interface ExecResult {
  readonly code: number | null
  readonly output: string
  readonly timedOut: boolean
  readonly durationMs: number
}

/**
 * Gate environment: the host environment minus variables that let an outer
 * process capture or rewrite the gate's result. `NODE_TEST_CONTEXT` in particular
 * makes a nested `node --test` report to its parent and exit 0 (a false PASS).
 */
export function gateEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, CI: '1', FORCE_COLOR: '0' }
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE']) delete env[key]
  return env
}

export function execShell(command: string, cwd: string, timeoutMs: number, env: Record<string, string> = {}, signal?: AbortSignal): Promise<ExecResult> {
  const started = Date.now()
  return new Promise(res => {
    const child = spawn('bash', ['-c', command], { cwd, env: gateEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    let timedOut = false
    const onData = (chunk: Buffer): void => {
      output += String(chunk)
      if (output.length > 2_000_000) output = output.slice(-1_000_000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const kill = (): void => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch (alreadyExited) {
        // The process group is gone; nothing left to kill.
        void alreadyExited
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', error => { output += `\n[spawn error] ${String(error)}`; })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      res({ code, output, timedOut, durationMs: Date.now() - started })
    })
  })
}

interface Counts { passed: number; failed: number; skipped: number }

/** Parse node:test output (TAP `# pass N` / spec `ℹ pass N`). */
export function parseNodeTest(output: string): Counts | undefined {
  const grab = (key: string): number | undefined => {
    const m = output.match(new RegExp(`^[#ℹ]\\s*${key}\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) : undefined
  }
  const passed = grab('pass')
  const failed = grab('fail')
  if (passed === undefined && failed === undefined) return undefined
  return { passed: passed ?? 0, failed: failed ?? 0, skipped: grab('skipped') ?? 0 }
}

/** Parse a Playwright JSON report's `stats`. */
export function parsePlaywrightJson(json: string): (Counts & { failures: string[] }) | undefined {
  try {
    const report = JSON.parse(json) as { stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number }; suites?: unknown[] }
    if (!report.stats) return undefined
    const failures: string[] = []
    const walk = (suite: any, prefix: string): void => {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.status === 'unexpected') {
            const err = test.results?.at(-1)?.error?.message ?? ''
            failures.push(`${prefix}${spec.title}: ${String(err).split('\n')[0]}`)
          }
        }
      }
      for (const child of suite.suites ?? []) walk(child, `${prefix}${child.title} › `)
    }
    for (const suite of report.suites ?? []) walk(suite, '')
    return { passed: (report.stats.expected ?? 0) + (report.stats.flaky ?? 0), failed: report.stats.unexpected ?? 0, skipped: report.stats.skipped ?? 0, failures }
  } catch (notJson) {
    void notJson
    return undefined
  }
}

export async function runCommandGate(spec: GateSpec, projectRoot: string, signal?: AbortSignal): Promise<GateResult> {
  const cwd = resolve(projectRoot, spec.cwd ?? '.')
  const base = { gateId: spec.id, kind: spec.kind, required: spec.required }
  if (!spec.command) return { ...base, status: 'error', durationMs: 0, summary: 'gate has no command', outputTail: '' }
  if (!existsSync(cwd)) return { ...base, status: 'error', durationMs: 0, summary: `cwd missing: ${cwd}`, outputTail: '', failureSignature: `${spec.id}:cwd-missing` }
  const reportFile = join(cwd, `.sa-gate-${spec.id}.json`)
  const env: Record<string, string> = spec.parser === 'playwright-json' ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile } : {}
  const r = await execShell(spec.command, cwd, spec.timeoutMs ?? 600_000, env, signal)
  const outputTail = tail(r.output)
  if (r.timedOut) {
    return { ...base, status: 'fail', durationMs: r.durationMs, summary: `timed out after ${spec.timeoutMs ?? 600_000}ms`, outputTail, failureSignature: `${spec.id}:timeout` }
  }
  let summary = `exit ${r.code}`
  let details: Record<string, unknown> | undefined
  let parsedFail: boolean | undefined
  let signatureBasis = r.output
  if (spec.parser === 'node-test') {
    const c = parseNodeTest(r.output)
    if (c) {
      summary = `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (exit ${r.code})`
      details = { ...c }
      parsedFail = c.failed > 0
    }
  } else if (spec.parser === 'playwright-json') {
    const raw = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : r.output
    const c = parsePlaywrightJson(raw)
    if (c) {
      summary = `E2E ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (exit ${r.code})`
      details = { passed: c.passed, failed: c.failed, skipped: c.skipped, failures: c.failures }
      parsedFail = c.failed > 0
      if (c.failures.length) signatureBasis = c.failures.join('\n')
    } else {
      summary = `E2E report missing or unreadable (exit ${r.code})`
    }
  }
  // A parser can only make a verdict stricter: a zero exit with parsed failures fails,
  // a non-zero exit never passes.
  const failed = r.code !== 0 || parsedFail === true || (spec.parser === 'playwright-json' && details === undefined)
  return {
    ...base,
    status: failed ? 'fail' : 'pass',
    durationMs: r.durationMs,
    summary,
    outputTail,
    failureSignature: failed ? failureSignature(spec.id, signatureBasis) : undefined,
    details,
  }
}
