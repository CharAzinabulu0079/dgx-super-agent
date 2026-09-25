import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calcProject, gitRepo, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import type { GateResult } from '@superagent/contracts'
import { decideVerdict, failureSignature, parseNodeTest, parsePlaywrightJson, runCommandGate, scanHygiene, receiptSignature } from '../src/index.ts'

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
