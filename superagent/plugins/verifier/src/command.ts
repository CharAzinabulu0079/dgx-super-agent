/**
 * `command` / `e2e` gate runner: deterministic shell command, parsed by exit code,
 * node:test TAP/spec summary, or Playwright JSON reporter output.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GateResult, GateSpec } from '@superagent/contracts'
import { failureSignature, tail } from './signature.ts'

export interface ExecResult {
  readonly code: number | null
  readonly output: string
  readonly timedOut: boolean
  readonly durationMs: number
}

/** Host variables a gate may inherit; everything else (NODE_OPTIONS, npm_config_*, …) is dropped. */
export const GATE_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR',
  'PLAYWRIGHT_BROWSERS_PATH', 'SUPERAGENT_CHROMIUM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
]

/**
 * Gate environment: an allowlist of host variables plus the gate's declared `env`.
 * Inheriting the host environment let an outer runner rewrite results
 * (`NODE_TEST_CONTEXT` made nested `node --test` exit 0; `NODE_OPTIONS` can preload code).
 */
export function gateEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (GATE_ENV_ALLOWLIST.includes(k) || k.startsWith('LC_'))) env[k] = v
  }
  return { ...env, ...extra, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
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
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, sig)
      } catch (alreadyExited) {
        // The process group is gone; nothing left to kill.
        void alreadyExited
      }
    }
    // SIGTERM first: runners like Playwright start their webServer in its own process
    // group and only tear it down on a graceful exit; an immediate SIGKILL orphans it
    // (and its port). SIGKILL follows after a grace period.
    const kill = (): void => {
      signalGroup('SIGTERM')
      setTimeout(() => signalGroup('SIGKILL'), 5_000).unref()
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

export interface TestOutcome { readonly name: string; readonly ok: boolean }

/**
 * Test identities from node:test TAP output (`ok N - name` / `not ok N - name`,
 * any nesting). Absolute paths are made project-relative so identities are stable.
 */
export function parseTapTests(output: string, root = ''): TestOutcome[] {
  const out: TestOutcome[] = []
  for (const line of output.split('\n')) {
    const m = /^\s*(not )?ok \d+ - (.+?)(?:\s+#\s*(SKIP|TODO).*)?$/.exec(line)
    if (!m) continue
    let name = m[2]!.trim()
    if (root && name.startsWith(root)) name = name.slice(root.length + 1)
    out.push({ name, ok: !m[1] && !m[3] })
  }
  return out
}

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
export function parsePlaywrightJson(json: string): (Counts & { failures: string[]; tests: TestOutcome[] }) | undefined {
  try {
    const report = JSON.parse(json) as { stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number }; suites?: unknown[] }
    if (!report.stats) return undefined
    const failures: string[] = []
    const tests: TestOutcome[] = []
    const walk = (suite: any, prefix: string): void => {
      for (const spec of suite.specs ?? []) {
        const specTests = spec.tests ?? []
        tests.push({ name: `${prefix}${spec.title}`, ok: specTests.length > 0 && specTests.every((t: any) => t.status === 'expected' || t.status === 'flaky') })
        for (const test of specTests) {
          if (test.status === 'unexpected') {
            const err = test.results?.at(-1)?.error?.message ?? ''
            failures.push(`${prefix}${spec.title}: ${String(err).split('\n')[0]}`)
          }
        }
      }
      for (const child of suite.suites ?? []) walk(child, `${prefix}${child.title} › `)
    }
    for (const suite of report.suites ?? []) walk(suite, '')
    return { passed: (report.stats.expected ?? 0) + (report.stats.flaky ?? 0), failed: report.stats.unexpected ?? 0, skipped: report.stats.skipped ?? 0, failures, tests }
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
  // The report lives outside the worktree in a fresh directory, so a Worker cannot plant one.
  const reportDir = mkdtempSync(join(tmpdir(), 'sa-gate-'))
  const reportFile = join(reportDir, `${spec.id}.json`)
  const env: Record<string, string> = { ...(spec.env ?? {}), ...(spec.parser === 'playwright-json' ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile } : {}) }
  let r: ExecResult
  let reportJson: string | undefined
  try {
    r = await execShell(spec.command, cwd, spec.timeoutMs ?? 600_000, env, signal)
    reportJson = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : undefined
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
  const outputTail = tail(r.output)
  if (r.timedOut) {
    return { ...base, status: 'fail', durationMs: r.durationMs, summary: `timed out after ${spec.timeoutMs ?? 600_000}ms`, outputTail, failureSignature: `${spec.id}:timeout` }
  }
  let summary = `exit ${r.code}`
  let details: Record<string, unknown> | undefined
  let parsedFail: boolean | undefined
  let signatureBasis = r.output
  let tests: TestOutcome[] | undefined
  let executed: number | undefined
  if (spec.parser === 'node-test') {
    const c = parseNodeTest(r.output)
    tests = parseTapTests(r.output, cwd)
    if (c) {
      summary = `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (exit ${r.code})`
      details = { ...c }
      parsedFail = c.failed > 0
      executed = c.passed + c.failed
    }
  } else if (spec.parser === 'playwright-json') {
    const c = reportJson === undefined ? undefined : parsePlaywrightJson(reportJson)
    if (c) {
      summary = `E2E ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (exit ${r.code})`
      details = { passed: c.passed, failed: c.failed, skipped: c.skipped, failures: c.failures }
      parsedFail = c.failed > 0
      tests = c.tests
      executed = c.passed + c.failed
      if (c.failures.length) signatureBasis = c.failures.join('\n')
    } else {
      summary = `E2E report missing or unreadable (exit ${r.code})`
    }
  }
  // Suppression guard: a parsed gate that executed no tests (or fewer than required) fails.
  let suppressed = false
  if (spec.parser && executed !== undefined && (executed === 0 || executed < (spec.minTests ?? 1))) {
    suppressed = true
    summary = `${summary}; only ${executed} test(s) executed (minimum ${spec.minTests ?? 1})`
  }
  // A parser can only make a verdict stricter: a zero exit with parsed failures fails,
  // a non-zero exit never passes, and a parser that recognized nothing fails.
  const failed = r.code !== 0 || parsedFail === true || suppressed || (spec.parser !== undefined && spec.parser !== 'exit-code' && details === undefined)
  return {
    ...base,
    status: failed ? 'fail' : 'pass',
    durationMs: r.durationMs,
    summary,
    outputTail,
    failureSignature: failed ? (suppressed ? `${spec.id}:suppressed` : failureSignature(spec.id, signatureBasis)) : undefined,
    details,
    tests,
  }
}
