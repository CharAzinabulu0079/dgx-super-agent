import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor, type WorkerRunInput } from '@superagent/chief-worker'
import { createRuntime } from '@superagent/server'
import { calcProject, tempDir, BUGGY_CALC, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { parseCandidates, CANDIDATES_FENCE, compareArms, mayPromote } from '../src/index.ts'

/** A task that PASSes on attempt 2; returns the runtime with reflected candidates. */
async function passedAfterFailure() {
  const root = calcProject()
  const rt = createRuntime({
    home: tempDir('sa-home-'),
    executor: new ScriptedExecutor(input => {
      if (input.attempt >= 2) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
      input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: input.attempt >= 2 ? 'add() used subtraction; switched to +' : 'looked fine' })
    }),
  })
  const project = await rt.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = rt.chief.createGoal(project.id, 'fix add')
  const task = rt.chief.addTask(project.id, goal.id, { title: 'fix add', instructions: '...' })
  await rt.chief.runGoal(project.id, goal.id)
  await rt.learning.reflect(project.id, task.id)
  return { rt, root, project, task }
}

/** Replay Workers: they only find the fix when a skill carrying it is in their prompt. */
function replayWorkers(behaviour: (i: WorkerRunInput) => void, starts: string[]) {
  return { executorFactory: () => new ScriptedExecutor(i => { starts.push(readFileSync(join(i.project.root, 'src/calc.js'), 'utf8')); behaviour(i) }), maxAttempts: 2 }
}

test('reflection yields candidates only — nothing becomes active knowledge on its own', async () => {
  const { rt, project } = await passedAfterFailure()
  const cands = rt.learning.learning.list()
  assert.deepEqual(cands.map(c => `${c.kind}:${c.status}:${c.source}`).sort(), ['memory:candidate:trace-rule', 'skill:candidate:trace-rule'])
  assert.match(cands.find(c => c.kind === 'memory')!.body, /subtraction/)
  assert.equal(rt.learning.memoryFor(project.id).length, 0)
  assert.equal(rt.learning.projectSkills(project.id).length, 0)
})

test('fresh replay: a skill that makes the fresh Worker succeed is promoted; the real tree is untouched', async () => {
  const { rt, root, project } = await passedAfterFailure()
  const starts: string[] = []
  rt.learning.replay = replayWorkers(i => {
    if (i.skills?.some(s => s.body.includes('switched to +'))) writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC)
  }, starts)
  const skill = rt.learning.learning.list().find(c => c.kind === 'skill')!
  const result = await rt.learning.evaluate(skill.id)
  assert.equal(result.status, 'promoted', result.decision)
  assert.match(result.comparison!.reason, /baseline failed/)
  const record = result.evals[0]!
  assert.equal(record.method, 'fresh-replay')
  assert.deepEqual(record.arms.map(a => `${a.arm}:${a.passed}`), ['baseline:false', 'candidate:true'])
  assert.ok(starts.every(s => s === BUGGY_CALC), 'every replay started from the reconstructed failing state')
  assert.equal(readFileSync(join(root, 'src/calc.js'), 'utf8'), FIXED_CALC, 'the user tree was not touched by replay')
  assert.ok(existsSync(join(rt.store.home, 'skills', skill.name, 'SKILL.md')))
  assert.deepEqual(rt.learning.projectSkills(project.id).map(s => s.name), [skill.name])
})

test('a skill with no measurable benefit is rejected and archived with the reason', async () => {
  const { rt } = await passedAfterFailure()
  rt.learning.replay = replayWorkers(i => { writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }, [])
  const skill = rt.learning.learning.list().find(c => c.kind === 'skill')!
  const r = await rt.learning.evaluate(skill.id)
  assert.equal(r.status, 'rejected')
  assert.match(r.decision!, /no measurable improvement/)
  assert.ok(existsSync(join(rt.store.home, 'learning', 'archived', `${skill.id}.json`)))
})

test('a skill that gets the Worker to tamper with tests is rejected (integrity), even though tests went green', async () => {
  const { rt } = await passedAfterFailure()
  rt.learning.replay = replayWorkers(i => {
    if (i.skills?.length) writeFileSync(join(i.project.root, 'test/calc.test.js'), 'import test from "node:test"\ntest("add", () => {})\n')
  }, [])
  const skill = rt.learning.learning.list().find(c => c.kind === 'skill')!
  const r = await rt.learning.evaluate(skill.id)
  assert.equal(r.status, 'rejected')
  assert.match(r.decision!, /integrity|did not pass/)
})

test('without a replay capability nothing evidence-governed is promoted (fail closed)', async () => {
  const { rt } = await passedAfterFailure()
  const skill = rt.learning.learning.list().find(c => c.kind === 'skill')!
  const r = await rt.learning.evaluate(skill.id)
  assert.equal(r.status, 'candidate')
  assert.match(r.decision!, /awaiting replay/)
  assert.throws(() => rt.learning.decide(skill.id, true), /requires fresh-replay evidence/, 'a human cannot force a skill without evidence')
})

test('memory is human-only and then reaches later Worker prompts', async () => {
  const { rt, project, root } = await passedAfterFailure()
  const memory = rt.learning.learning.list().find(c => c.kind === 'memory')!
  await assert.rejects(rt.learning.evaluate(memory.id), /human approval/)
  rt.learning.decide(memory.id, true, 'good lesson')
  writeFileSync(join(root, 'src/calc.js'), BUGGY_CALC)
  let seen: readonly string[] | undefined
  const rt2 = createRuntime({ home: rt.store.home, executor: new ScriptedExecutor(i => { seen = i.memory; writeFileSync(join(root, 'src/calc.js'), FIXED_CALC) }) })
  const goal = rt2.chief.createGoal(project.id, 'again')
  rt2.chief.addTask(project.id, goal.id, { title: 'fix add again', instructions: '...' })
  await rt2.chief.runGoal(project.id, goal.id)
  assert.match(seen?.[0] ?? '', /subtraction/)
})

test('policy candidates are replay-evaluated under the proposed policy and still need a human', async () => {
  const { rt, project, task } = await passedAfterFailure()
  const snapshot = rt.store.requireTask(project.id, task.id).baseline!.snapshot
  const policy = rt.learning.learning.add({
    kind: 'routing-policy', name: 'allow-three-attempts', description: 'give Workers a third attempt', scope: 'project', source: 'llm-reflection',
    body: '{"maxAttempts":3}', evidence: { projectId: project.id, taskId: task.id, receiptIds: [], failureSignatures: [], snapshot },
  })
  assert.throws(() => rt.learning.decide(policy.id, true), /fresh-replay evidence/)
  // Fresh Workers only get it right on their third try.
  rt.learning.replay = replayWorkers(i => { if (i.attempt >= 3) writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }, [])
  const evaluated = await rt.learning.evaluate(policy.id)
  assert.equal(evaluated.status, 'candidate', 'evidence alone is not enough for a policy change')
  assert.equal(evaluated.comparison!.improved, true)
  assert.deepEqual(evaluated.evals[0]!.arms.map(a => `${a.arm}:${a.passed}:${a.attempts}`), ['baseline:false:2', 'candidate:true:3'])
  assert.match(evaluated.decision!, /a human must also approve/)
  const promoted = rt.learning.decide(policy.id, true, 'ok for this project')
  assert.equal(promoted.status, 'promoted')
  assert.equal(readFileSync(join(rt.store.home, 'policies', 'allow-three-attempts.json'), 'utf8'), '{"maxAttempts":3}')
})

test('compare and governance rules', () => {
  const arm = (a: 'baseline' | 'candidate', passed: boolean, attempts: number, integrityBlocked = false) => ({ arm: a, passed, attempts, finalState: passed ? 'passed' : 'human_gate', gateResults: [], integrityBlocked, durationMs: 1 })
  assert.equal(compareArms([arm('baseline', false, 2), arm('candidate', true, 1)]).improved, true)
  assert.equal(compareArms([arm('baseline', true, 2), arm('candidate', true, 1)]).improved, true)
  assert.equal(compareArms([arm('baseline', true, 1), arm('candidate', true, 1)]).improved, false)
  assert.equal(compareArms([arm('baseline', false, 2), arm('candidate', true, 1, true)]).improved, false)
  const evidence = { comparison: { improved: true, reason: 'x' }, evals: [{ at: '', method: 'fresh-replay' as const, fresh: true, heldOutGates: true, arms: [] }] }
  assert.equal(mayPromote({ kind: 'skill', ...evidence }, false).ok, true)
  assert.equal(mayPromote({ kind: 'verifier-policy', ...evidence }, false).ok, false)
  assert.equal(mayPromote({ kind: 'verifier-policy', ...evidence }, true).ok, true)
  assert.equal(mayPromote({ kind: 'memory', comparison: undefined, evals: [] }, true).ok, true)
})

test('LLM reflection output is validated: bad kinds, names, sizes and non-JSON are dropped', () => {
  const good = { kind: 'skill', name: 'fix-plural', description: 'd', body: 'steps', rationale: 'r' }
  const block = (x: unknown) => `thoughts\n\`\`\`${CANDIDATES_FENCE}\n${JSON.stringify(x)}\n\`\`\``
  assert.deepEqual(parseCandidates(block([good])).map(c => c.name), ['fix-plural'])
  assert.deepEqual(parseCandidates(block([{ ...good, kind: 'rootkit' }, { ...good, name: '../../etc' }, { ...good, body: 'x'.repeat(9000) }, 'str'])), [])
  assert.deepEqual(parseCandidates('no block'), [])
  assert.deepEqual(parseCandidates(`\`\`\`${CANDIDATES_FENCE}\nnot json\n\`\`\``), [])
})
