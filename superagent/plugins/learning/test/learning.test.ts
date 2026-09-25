import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor, type WorkerRunInput } from '@superagent/chief-worker'
import { createRuntime } from '@superagent/server'
import { calcProject, tempDir, BUGGY_CALC, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'

async function passedAfterFailure(onRun?: (i: WorkerRunInput) => void) {
  const root = calcProject()
  const rt = createRuntime({
    home: tempDir('sa-home-'),
    executor: new ScriptedExecutor(input => {
      onRun?.(input)
      if (input.attempt >= 2) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
      input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: input.attempt >= 2 ? 'add() used subtraction; switched to +' : 'looked fine' })
    }),
  })
  const project = await rt.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = rt.chief.createGoal(project.id, 'fix add')
  const task = rt.chief.addTask(project.id, goal.id, { title: 'fix add', instructions: '...' })
  await rt.chief.runGoal(project.id, goal.id)
  return { rt, root, project, task }
}

test('a task that PASSed after failing yields candidates only — nothing is promoted automatically', async () => {
  const { rt, project } = await passedAfterFailure()
  const cands = rt.learning.learning.list()
  assert.deepEqual(cands.map(c => `${c.kind}:${c.status}`).sort(), ['memory:candidate', 'skill:candidate'])
  const memory = cands.find(c => c.kind === 'memory')!
  assert.match(memory.body, /add\(\) used subtraction; switched to \+/)
  assert.equal(rt.learning.memoryFor(project.id).length, 0)
  assert.ok(rt.store.readEvents(project.id).some(e => e.type === 'learning/candidate'))
})

test('skill promotion requires its eval gates to PASS; a failing replay archives it', async () => {
  const { rt, root, project } = await passedAfterFailure()
  const skill = rt.learning.learning.list().find(c => c.kind === 'skill')!
  assert.throws(() => rt.learning.decideMemory(skill.id, true), /only through evaluate/)
  const promoted = await rt.learning.evaluate(skill.id)
  assert.equal(promoted.status, 'promoted')
  assert.ok(existsSync(join(rt.store.home, 'skills', skill.name, 'SKILL.md')))
  assert.deepEqual(rt.learning.projectSkills(project.id).map(s => s.name), [skill.name])
  await rt.scanArchitecture(project)
  assert.equal(JSON.parse(readFileSync(join(root, '.architecture/skills.json'), 'utf8'))[0].name, skill.name)

  // Second, independent run: the evidence no longer passes → archive.
  const second = await passedAfterFailure()
  const skill2 = second.rt.learning.learning.list().find(c => c.kind === 'skill')!
  writeFileSync(join(second.root, 'src/calc.js'), BUGGY_CALC)
  const archived = await second.rt.learning.evaluate(skill2.id)
  assert.equal(archived.status, 'archived')
  assert.equal(archived.decision, 'eval failed')
  await assert.rejects(second.rt.learning.evaluate(skill2.id), /archived/)
})

test('memory is promoted only by a human decision, then reaches later Worker prompts', async () => {
  const { rt, project, root } = await passedAfterFailure()
  const memory = rt.learning.learning.list().find(c => c.kind === 'memory')!
  await assert.rejects(rt.learning.evaluate(memory.id), /human approval/)
  rt.learning.decideMemory(memory.id, true, 'good lesson')
  assert.equal(rt.learning.memoryFor(project.id).length, 1)
  // A new task's Worker sees the approved lesson.
  writeFileSync(join(root, 'src/calc.js'), BUGGY_CALC)
  let seenMemory: readonly string[] | undefined
  const rt2 = createRuntime({
    home: rt.store.home,
    executor: new ScriptedExecutor(input => { seenMemory = input.memory; writeFileSync(join(root, 'src/calc.js'), FIXED_CALC) }),
  })
  const goal = rt2.chief.createGoal(project.id, 'again')
  rt2.chief.addTask(project.id, goal.id, { title: 'fix add again', instructions: '...' })
  await rt2.chief.runGoal(project.id, goal.id)
  assert.equal(seenMemory?.length, 1)
  assert.match(seenMemory![0]!, /subtraction/)
})
