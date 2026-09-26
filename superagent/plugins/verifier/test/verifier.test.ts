import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calcProject, gitRepo, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import type { GateResult } from '@superagent/contracts'
import { baselineFindings, decideVerdict, failureSignature, parseNodeTest, parsePlaywrightJson, runCommandGate, scanHygiene, receiptSignature, Verifier } from '../src/index.ts'

const r = (over: Partial<GateResult>): GateResult => ({ gateId: 'g', kind: 'command', status: 'pass', required: true, durationMs: 1, summary: '', outputTail: '', ...over })

test('verdict: no required gates → FAIL; any required non-pass → FAIL; optional failures ignored', () => {
  assert.equal(decideVerdict([]).verdict, 'FAIL')
  assert.equal(decideVerdict([r({ required: false })]).verdict, 'FAIL')
  assert.equal(decideVerdict([r({}), r({ gateId: 'x', status: 'error' })]).verdict, 'FAIL')
  assert.equal(decideVerdict([r({}), r({ gateId: 'opt', status: 'fail', required: false })]).verdict, 'PASS')
})

test('failure signature ignores durations, temp paths, line numbers', () => {
  const a = failureSignature('unit', 'not ok 1 - add\n  error: expected 5 got -1 at /tmp/sa-repo-abc/test.js:4:10 (12ms)')
  const b = failureSignature('unit', 'not ok 1 - add\n  error: expected 5 got -1 at /tmp/sa-repo-xyz/test.js:9:3 (40ms)')
  const c = failureSignature('unit', 'not ok 1 - subtract\n  error: TypeError undefined is not a function')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(receiptSignature({ gateResults: [r({ status: 'pass' })] }), undefined)
})

test('node:test and Playwright JSON parsers', () => {
  assert.deepEqual(parseNodeTest('# tests 3\n# pass 2\n# fail 1\n# skipped 0'), { passed: 2, failed: 1, skipped: 0 })
  assert.deepEqual(parseNodeTest('ℹ tests 1\nℹ pass 1\nℹ fail 0'), { passed: 1, failed: 0, skipped: 0 })
  const pw = parsePlaywrightJson(JSON.stringify({ stats: { expected: 2, unexpected: 1, skipped: 0, flaky: 0 }, suites: [{ title: 'a.spec.ts', specs: [{ title: 'loads', tests: [{ status: 'unexpected', results: [{ error: { message: 'Timeout 5000ms\nstack' } }] }] }], suites: [] }] }))
  assert.equal(pw?.failed, 1)
  assert.deepEqual(pw?.failures, ['loads: Timeout 5000ms'])
})

test('command gate is not fooled by an inherited NODE_TEST_CONTEXT (regression: false PASS)', async () => {
  // This test itself runs under `node --test`, so NODE_TEST_CONTEXT is set here.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under node --test')
  const root = calcProject()
  const failing = await runCommandGate(NODE_TEST_GATE as never, root)
  assert.equal(failing.status, 'fail')
  assert.match(failing.summary, /1 failed/)
  assert.ok(failing.failureSignature)
  writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
  const passing = await runCommandGate(NODE_TEST_GATE as never, root)
  assert.equal(passing.status, 'pass', passing.outputTail)
})

test('command gate timeout is a fail with a stable signature', async () => {
  const root = calcProject()
  const res = await runCommandGate({ id: 'slow', kind: 'command', command: 'sleep 5', required: true, timeoutMs: 300 }, root)
  assert.equal(res.status, 'fail')
  assert.equal(res.failureSignature, 'slow:timeout')
})

test('hygiene gate blocks secrets, env files and model weights; ignores gitignored paths', () => {
  const root = gitRepo({ '.gitignore': 'ignored/\n', 'README.md': 'ok\n' })
  writeFileSync(join(root, '.env'), 'X=1\n')
  writeFileSync(join(root, 'weights.gguf'), 'x')
  writeFileSync(join(root, 'config.js'), `const key = "sk-${'a'.repeat(40)}"\n`)
  const findings = scanHygiene(root)
  const rules = findings.map(f => `${f.rule}:${f.file}`).sort()
  assert.deepEqual(rules, ['env-file:.env', 'forbidden-extension:weights.gguf', 'secret:config.js'])
})

test('timed-out gates get SIGTERM first so runners can stop their own servers', async () => {
  const root = calcProject()
  const marker = join(root, 'cleaned-up')
  const res = await runCommandGate({ id: 'srv', kind: 'command', command: `trap 'echo ok > ${marker}; exit 0' TERM; sleep 30 & wait`, required: true, timeoutMs: 300 }, root)
  assert.equal(res.failureSignature, 'srv:timeout')
  assert.equal(existsSync(marker), true, 'the TERM handler ran')
})

test('baseline: a test file that cannot load yet is not a named test to keep (found on DGX)', async () => {
  const root = gitRepo({
    'package.json': '{"type":"module"}',
    'calc.js': 'export function add(a, b) { return a + b }\n',
    'calc.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add, multiply } from './calc.js'\ntest('add', () => assert.equal(add(2, 3), 5))\ntest('multiply', () => assert.equal(multiply(4, 5), 20))\n",
  })
  const v = new Verifier()
  const task = { id: 'task_1' } as any
  const base = await v.baseline(task, root, [NODE_TEST_GATE])
  assert.equal(base.gates.unit!.status, 'fail')
  assert.deepEqual(base.gates.unit!.tests, [], 'the file-level load failure is not recorded')
  writeFileSync(join(root, 'calc.js'), 'export function add(a, b) { return a + b }\nexport function multiply(a, b) { return a * b }\n')
  const after = await v.runGate(NODE_TEST_GATE, { projectRoot: root, task, changedFiles: ['calc.js'] })
  assert.equal(after.status, 'pass')
  assert.deepEqual(baselineFindings([after], base), [])
  // A named test that existed at baseline must still be there.
  assert.equal(baselineFindings([after], { ...base, gates: { unit: { status: 'fail', tests: ['add', 'subtract'] } } })[0]!.kind, 'baseline-test-missing')
})
