import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calcProject, git, tempDir, FIXED_CALC } from '@superagent/testkit'
import type { GateSpec, Task } from '@superagent/contracts'
import { Verifier, resolveHeldOutSource, HeldOutError } from '../src/index.ts'

export const HELDOUT_TEST = `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.js'\ntest('adds negatives', () => { assert.equal(add(10, -4), 6) })\ntest('adds zero', () => { assert.equal(add(0, 7), 7) })\n`
const GATE: GateSpec = { id: 'acceptance', kind: 'command', command: 'node --test acceptance/*.test.js', required: true, parser: 'node-test', heldOut: { source: 'calc', mountAt: 'acceptance' } }
const task = { id: 't1', projectId: 'p' } as unknown as Task

function heldOutHome(): string {
  const root = tempDir('sa-heldout-home-')
  mkdirSync(join(root, 'calc'), { recursive: true })
  writeFileSync(join(root, 'calc', 'add.test.js'), HELDOUT_TEST)
  return root
}

test('held-out gate runs hidden tests against the working tree without touching it', async () => {
  const root = calcProject()
  const v = new Verifier({ heldOutRoot: heldOutHome() })
  const before = await v.runGate(GATE, { projectRoot: root, task, changedFiles: [] })
  assert.equal(before.status, 'fail')
  assert.equal(before.heldOut, true)
  writeFileSync(join(root, 'src/calc.js'), FIXED_CALC) // uncommitted change counts
  const after = await v.runGate(GATE, { projectRoot: root, task, changedFiles: [] })
  assert.equal(after.status, 'pass', after.summary)
  assert.deepEqual(after.tests?.map(t => t.name).sort(), ['adds negatives', 'adds zero'])
  assert.equal(existsSync(join(root, 'acceptance')), false, 'held-out files never enter the worktree')
  assert.equal(git(root, 'for-each-ref', 'refs/superagent/').trim(), '', 'temporary snapshot refs are removed')
})

test('Worker files at the mount path are replaced by the held-out tests', async () => {
  const root = calcProject()
  mkdirSync(join(root, 'acceptance'))
  writeFileSync(join(root, 'acceptance/add.test.js'), `import test from 'node:test'\ntest('adds negatives', () => {})\ntest('adds zero', () => {})\n`)
  const r = await new Verifier({ heldOutRoot: heldOutHome() }).runGate(GATE, { projectRoot: root, task, changedFiles: [] })
  assert.equal(r.status, 'fail', 'planted passing copies do not count')
  assert.match(readFileSync(join(root, 'acceptance/add.test.js'), 'utf8'), /test\('adds zero', \(\) => \{\}\)/)
})

test('held-out misconfiguration fails closed', async () => {
  const root = calcProject()
  assert.equal((await new Verifier().runGate(GATE, { projectRoot: root, task, changedFiles: [] })).status, 'error')
  const home = heldOutHome()
  assert.throws(() => resolveHeldOutSource(home, '../etc'), HeldOutError)
  const missing = await new Verifier({ heldOutRoot: home }).runGate({ ...GATE, heldOut: { source: 'nope', mountAt: 'acceptance' } }, { projectRoot: root, task, changedFiles: [] })
  assert.equal(missing.status, 'error')
  assert.match(missing.summary, /missing/)
})
