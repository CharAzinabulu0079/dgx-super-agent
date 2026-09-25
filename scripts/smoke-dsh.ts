/**
 * Phase A Foundation gate: the pinned DSH runtime boots, runs a session, and executes
 * the native `write` (File) and `bash` (Shell) tools — keyless, via the scripted mock LLM.
 *
 * Usage: node scripts/smoke-dsh.ts          (exit 0 = PASS)
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDsh, startMockLlm, text, toolCall, type MockTurn } from '../superagent/testkit/src/index.ts'
import lock from '../upstream/dsh.lock.json' with { type: 'json' }

const work = mkdtempSync(join(tmpdir(), 'sa-smoke-'))
const home = join(work, 'dsh-home')
const cwd = join(work, 'ws')
await import('node:fs/promises').then(fs => fs.mkdir(cwd, { recursive: true }))

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: string): void => { checks.push({ name, ok, detail }) }

const version = await runDsh({ args: ['--version'], cwd, env: { DSH_HOME: home } })
check('dsh --version matches lock', version.stdout.trim() === lock.npm.version, version.stdout.trim())

let toolRound = 0
const mock = await startMockLlm((request): MockTurn => {
  // Auxiliary requests (session title generation) carry no tools.
  if (!request.tools?.length) return text('Smoke session')
  const step = toolRound++
  if (step === 0) return toolCall('write', { file_path: join(cwd, 'smoke.txt'), content: 'SA_SMOKE_CONTENT\n' }, 'Writing file.')
  if (step === 1) return toolCall('bash', { command: 'cat smoke.txt && echo SHELL_OK', description: 'Read smoke file' })
  return text('SMOKE_DONE')
})
try {
  const run = await runDsh({
    args: ['headless', 'write smoke.txt then cat it'],
    cwd,
    env: { DSH_HOME: home, DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'mock-key' },
    timeoutMs: 180_000,
  })
  check('headless exits 0', run.exitCode === 0, `exit=${run.exitCode} stderr=${run.stderr.slice(-400)}`)
  check('final answer printed', run.stdout.includes('SMOKE_DONE'), run.stdout.slice(-200))
  check('File tool wrote file', existsSync(join(cwd, 'smoke.txt')) && readFileSync(join(cwd, 'smoke.txt'), 'utf8') === 'SA_SMOKE_CONTENT\n')
  const bashResult = JSON.stringify(mock.requests.at(-1)?.messages ?? [])
  const shellSeen = mock.requests.some(r => JSON.stringify(r.messages).includes('SHELL_OK'))
  check('Shell tool result reached model', shellSeen, bashResult.slice(0, 200))
  const sessionsDir = join(home, 'sessions')
  const persisted = existsSync(sessionsDir) && readdirSync(sessionsDir, { recursive: true }).some(f => String(f).includes('session'))
  check('Session persisted to DSH_HOME', persisted)
} finally {
  await mock.close()
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `  — ${c.detail}`}`)
const failed = checks.filter(c => !c.ok).length
console.log(failed === 0 ? `\nDSH smoke: PASS (${checks.length} checks, dsh ${lock.npm.version} @ ${lock.commitShort})` : `\nDSH smoke: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
