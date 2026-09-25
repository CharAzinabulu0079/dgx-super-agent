/**
 * Directive §4.A adversarial tests: a Worker trying to manufacture a PASS.
 * Every attack leaves the real bug in place (or hides it); the verdict must stay FAIL.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { gitRepo, git, tempDir, FIXED_CALC, BUGGY_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { Chief, GateRegistryError, LoopEngine, ScriptedExecutor, type WorkerRunInput } from '../src/index.ts'

const TEST = `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.js'\ntest('add', () => { assert.equal(add(2, 3), 5) })\ntest('add zero', () => { assert.equal(add(0, 4), 4) })\n`

function project(extra: Record<string, string> = {}) {
  return gitRepo({
    'package.json': JSON.stringify({ name: 'calc', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2),
    '.gitignore': 'node_modules/\n',
    'src/calc.js': BUGGY_CALC,
    'test/calc.test.js': TEST,
    'scripts/check.sh': '#!/bin/sh\nnode --test\n',
    ...extra,
  })
}

async function run(attack: (i: WorkerRunInput, root: string) => void, opts: { maxAttempts?: number; gates?: object[]; grants?: object; setup?: (root: string) => void } = {}) {
  const root = project()
  opts.setup?.(root)
  const store = new StateStore(tempDir('sa-home-'))
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(i => attack(i, root)) })
  const chief = new Chief(engine)
  const p = store.createProject({ name: 'calc', root, defaultGates: (opts.gates ?? [NODE_TEST_GATE]) as never })
  const goal = chief.createGoal(p.id, 'fix add')
  const t = chief.addTask(p.id, goal.id, { title: 'fix add', instructions: '...', policy: { maxAttempts: opts.maxAttempts ?? 1 } })
  if (opts.grants) store.updateTask(p.id, t.id, { grants: opts.grants })
  await chief.runGoal(p.id, goal.id)
  const task = store.requireTask(p.id, t.id)
  const receipts = store.listReceipts(p.id, t.id).sort((a, b) => a.attempt - b.attempt)
  return { root, store, engine, p, task, receipts, kinds: receipts.map(r => (r.integrity?.findings ?? []).map(f => f.kind)) }
}

const claimPass = (i: WorkerRunInput) => i.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: 'done' })

test('attack: weaken the test so it passes → integrity FAIL (verification-asset-modified)', async () => {
  const r = await run((i, root) => { writeFileSync(join(root, 'test/calc.test.js'), TEST.replaceAll('assert.equal', 'assert.ok')); claimPass(i) })
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.equal(r.receipts[0]!.gateResults[0]!.status, 'pass', 'the weakened test itself passes — only integrity catches it')
  assert.deepEqual(r.kinds[0], ['verification-asset-modified'])
  assert.equal(r.receipts[0]!.claimOverruled, true)
})

test('attack: rewrite the gate script to exit 0 → FAIL', async () => {
  const gate = { id: 'check', kind: 'command', command: 'sh scripts/check.sh', required: true, assets: ['scripts/check.sh'] }
  const r = await run((i, root) => { writeFileSync(join(root, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n'); claimPass(i) }, { gates: [gate] })
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.equal(r.receipts[0]!.gateResults[0]!.status, 'pass')
  assert.deepEqual(r.kinds[0], ['verification-asset-modified'])
})

test('attack: change package.json scripts to manufacture success → FAIL', async () => {
  const gate = { id: 'npm-test', kind: 'command', command: 'npm test --silent', required: true }
  const r = await run((i, root) => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    pkg.scripts.test = 'exit 0'
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    claimPass(i)
  }, { gates: [gate] })
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.ok(r.kinds[0]!.includes('package-scripts-modified'))
})

test('attack: suppress failures from source (process.exit(0) on import) → baseline tests missing → FAIL', async () => {
  const r = await run((i, root) => { writeFileSync(join(root, 'src/calc.js'), `process.exit(0)\n${BUGGY_CALC}`); claimPass(i) })
  const receipt = r.receipts[0]!
  assert.equal(receipt.gateResults[0]!.status, 'pass', 'node --test reports the file as passing — the false PASS vector')
  assert.equal(receipt.verdict, 'FAIL')
  assert.deepEqual(r.kinds[0], ['baseline-test-missing'])
  assert.match(receipt.reason, /add zero/)
})

test('attack: preload code through .npmrc / env files → FAIL', async () => {
  const r = await run((i, root) => { writeFileSync(join(root, '.npmrc'), 'node-options=--require ./hack.cjs\n'); writeFileSync(join(root, '.env'), 'NODE_OPTIONS=--require ./hack.cjs\n'); claimPass(i) })
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.deepEqual(r.receipts[0]!.integrity!.findings[0]!.paths, ['.env', '.npmrc'])
})

test('attack: NODE_OPTIONS in the gate environment is not inherited', async () => {
  const hack = join(tempDir(), 'hack.cjs')
  writeFileSync(hack, 'process.on("exit", () => process.exit(0)); process.exitCode = 0;\n')
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${hack}`
  try {
    const r = await run(claimPass)
    assert.equal(r.receipts[0]!.gateResults[0]!.status, 'fail')
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = before
  }
})

test('attack: patch an installed dependency (ignored node_modules) without a lockfile change → FAIL', async () => {
  const r = await run((i, root) => {
    writeFileSync(join(root, 'node_modules/fake-runner/index.js'), 'module.exports = () => true // always pass\n')
    writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    claimPass(i)
  }, { setup: root => { mkdirSync(join(root, 'node_modules/fake-runner'), { recursive: true }); writeFileSync(join(root, 'node_modules/fake-runner/index.js'), 'module.exports = () => false\n') } })
  assert.equal(r.receipts[0]!.gateResults[0]!.status, 'pass')
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.deepEqual(r.kinds[0], ['environment-modified'])
})

test('a real dependency install (lockfile changed) is surfaced, not failed', async () => {
  const r = await run((i, root) => {
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules/left-pad/index.js'), 'module.exports = 1\n')
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
    writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    claimPass(i)
  })
  assert.equal(r.receipts[0]!.verdict, 'PASS')
  assert.deepEqual(r.kinds[0], ['dependencies-changed'])
})

test('attack: commit the tampered test so the working tree looks clean → still FAIL', async () => {
  const r = await run((i, root) => {
    writeFileSync(join(root, 'test/calc.test.js'), 'import test from "node:test"\ntest("add", () => {})\ntest("add zero", () => {})\n')
    git(root, 'commit', '-qam', 'totally legit')
    claimPass(i)
  })
  assert.equal(r.receipts[0]!.verdict, 'FAIL')
  assert.deepEqual(r.kinds[0]!.sort(), ['head-moved', 'verification-asset-modified'])
})

test('attack: tamper in attempt 1, then later attempts inherit the tampered tree → still FAIL (task-level baseline)', async () => {
  const r = await run((i, root) => {
    if (i.attempt === 1) writeFileSync(join(root, 'test/calc.test.js'), TEST.replaceAll('assert.equal', 'assert.ok'))
    claimPass(i)
  }, { maxAttempts: 3 })
  assert.deepEqual(r.receipts.map(x => x.verdict), ['FAIL', 'FAIL', 'FAIL'])
  assert.ok(r.kinds.every(k => k.includes('verification-asset-modified')))
  assert.equal(r.task.state, 'human_gate')
})

test('reverting the tampering and fixing the code passes; feedback told the Worker why', async () => {
  let feedbackSeen = ''
  const r = await run((i, root) => {
    if (i.attempt === 1) writeFileSync(join(root, 'test/calc.test.js'), TEST.replaceAll('assert.equal', 'assert.ok'))
    else {
      feedbackSeen = JSON.stringify(i.feedback)
      writeFileSync(join(root, 'test/calc.test.js'), TEST)
      writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    }
    claimPass(i)
  }, { maxAttempts: 3 })
  assert.equal(r.task.state, 'passed')
  assert.match(feedbackSeen, /verification assets/)
})

test('human-granted verification changes still need a human to accept the PASS', async () => {
  const r = await run((i, root) => {
    writeFileSync(join(root, 'test/calc.test.js'), `${TEST}test('add negative', async () => { const { add } = await import('../src/calc.js'); assert.equal(add(-1, 1), 0) })\n`)
    writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    claimPass(i)
  }, { grants: { mayModifyVerification: true } })
  assert.equal(r.receipts[0]!.verdict, 'PASS')
  assert.equal(r.task.state, 'human_gate')
  const gate = r.store.listHumanGates(r.p.id, 'open')[0]!
  assert.equal(gate.reason, 'verification-change')
  assert.equal(r.engine.resolveHumanGate(r.p.id, gate.id, 'approved', 'new test is good')!.state, 'passed')
})

test('Gate Registry: agents may reference registry gates by id but never define shell commands', () => {
  const store = new StateStore(tempDir('sa-home-'))
  const chief = new Chief(new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(() => {}) }))
  const p = store.createProject({ name: 'x', root: project(), defaultGates: [NODE_TEST_GATE] })
  const goal = chief.createGoal(p.id, 'g')
  assert.throws(() => chief.addTask(p.id, goal.id, { title: 't', instructions: '', gates: [{ id: 'pwn', kind: 'command', command: 'exit 0', required: true }] }, 'agent'), GateRegistryError)
  assert.throws(() => chief.addTask(p.id, goal.id, { title: 't', instructions: '', gates: ['nope'] }, 'agent'), /not in the project gate registry/)
  const ok = chief.addTask(p.id, goal.id, { title: 't', instructions: '', gates: ['unit'] }, 'agent')
  assert.equal(ok.gates[0]!.command, NODE_TEST_GATE.command)
  const human = chief.addTask(p.id, goal.id, { title: 't', instructions: '', gates: [{ id: 'lint', kind: 'command', command: 'true', required: true }] }, 'human')
  assert.equal(human.gates[0]!.id, 'lint')
})

test('non-git projects fail closed (integrity cannot be established)', async () => {
  const root = tempDir('sa-nogit-')
  writeFileSync(join(root, 'ok.sh'), 'exit 0\n')
  const store = new StateStore(tempDir('sa-home-'))
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(claimPass) })
  const p = store.createProject({ name: 'nogit', root, defaultGates: [{ id: 'ok', kind: 'command', command: 'sh ok.sh', required: true }] })
  const chief = new Chief(engine)
  const goal = chief.createGoal(p.id, 'g')
  chief.addTask(p.id, goal.id, { title: 't', instructions: '', policy: { maxAttempts: 1 } })
  const res = await chief.runGoal(p.id, goal.id)
  const receipt = store.listReceipts(p.id)[0]!
  assert.equal(receipt.verdict, 'FAIL')
  assert.equal(receipt.integrity!.findings[0]!.kind, 'not-a-git-repository')
  assert.equal(res.tasks[0]!.state, 'human_gate')
})
