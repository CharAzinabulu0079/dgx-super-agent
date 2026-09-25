import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { Chief, LoopEngine, ScriptedExecutor, type ChiefWake, type WorkerRunInput } from '../src/index.ts'

function setup(script: (input: WorkerRunInput) => void | Promise<void>, policy?: unknown) {
  const root = calcProject()
  const store = new StateStore(tempDir('sa-home-'))
  const wakes: ChiefWake[] = []
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(script), onChiefWake: w => { wakes.push(w) } })
  const chief = new Chief(engine)
  const project = store.createProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = chief.createGoal(project.id, 'make add() correct')
  const task = chief.addTask(project.id, goal.id, { title: 'fix add', instructions: 'fix src/calc.js', policy })
  return { root, store, engine, chief, project, goal, task, wakes }
}

test('fail → retry with feedback → PASS; the Worker claim is overruled when gates fail', async () => {
  const seen: WorkerRunInput[] = []
  const { root, store, chief, project, goal, wakes } = setup(input => {
    seen.push(input)
    if (input.attempt === 1) {
      // Claims success without fixing anything.
      input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: 'all good' })
      return
    }
    assert.equal(input.feedback.length, 1)
    assert.equal(input.feedback[0]!.claimOverruled, true)
    assert.match(input.feedback[0]!.failingGates[0]!.summary, /1 failed/)
    writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC)
    input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: ['calc'], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: 'fixed add' })
  })
  const result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.goal.status, 'complete')
  const task = result.tasks[0]!
  assert.equal(task.state, 'passed')
  assert.equal(task.attempts.length, 2)
  const receipts = store.listReceipts(project.id, task.id).sort((a, b) => a.attempt - b.attempt)
  assert.deepEqual(receipts.map(r => r.verdict), ['FAIL', 'PASS'])
  assert.equal(receipts[0]!.claimOverruled, true)
  assert.deepEqual(receipts[1]!.changedFiles, ['src/calc.js'])
  assert.equal(readFileSync(join(root, 'src/calc.js'), 'utf8'), FIXED_CALC)
  assert.equal(seen[1]!.strategy, 'retry-with-feedback')
  assert.ok(wakes.some(w => w.reason === 'claim-overruled'))
  assert.ok(wakes.some(w => w.reason === 'task-passed'))
  const types = store.readEvents(project.id).map(e => e.type)
  for (const t of ['task/created', 'worker/started', 'worker/report', 'receipt/created', 'loop/decision', 'task/state']) assert.ok(types.includes(t as never), t)
})

test('repeated identical failure switches strategy, then escalates to a Human Gate (no infinite retry)', async () => {
  const strategies: string[] = []
  const { store, chief, project, goal, wakes } = setup(input => { strategies.push(input.strategy) }, {
    maxAttempts: 10, maxSameFailure: 2, strategies: ['retry-with-feedback', 'fresh-context', 'escalate-model'],
  })
  const result = await chief.runGoal(project.id, goal.id)
  // escalate-model is skipped: the policy names no escalation model.
  assert.deepEqual(strategies, ['retry-with-feedback', 'retry-with-feedback', 'fresh-context', 'fresh-context'])
  assert.equal(result.tasks[0]!.state, 'human_gate')
  assert.equal(result.goal.status, 'blocked')
  const gates = store.listHumanGates(project.id, 'open')
  assert.equal(gates.length, 1)
  assert.equal(gates[0]!.reason, 'repeated-failure')
  assert.ok(wakes.some(w => w.reason === 'strategy-switch'))
})

test('escalate-model strategy runs the escalation model and records it in the receipt', async () => {
  const models: string[] = []
  const { store, chief, project, goal } = setup(input => {
    models.push(`${input.model.provider}/${input.model.model}`)
    if (input.strategy === 'escalate-model') writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC)
  }, {
    maxSameFailure: 1, strategies: ['retry-with-feedback', 'escalate-model'],
    model: { worker: { provider: 'local-default', model: 'default' }, escalation: { provider: 'anthropic', model: 'claude-opus-5-5' } },
  })
  const result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.tasks[0]!.state, 'passed')
  assert.deepEqual(models, ['local-default/default', 'anthropic/claude-opus-5-5'])
  const pass = store.listReceipts(project.id).find(r => r.verdict === 'PASS')!
  assert.deepEqual(pass.model, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(pass.strategy, 'escalate-model')
})

test('a task with no gates never PASSes on a Worker claim alone', async () => {
  const { store, engine, chief, project, goal } = setup(input => {
    input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: 'trust me' })
  }, { maxAttempts: 1 })
  store.updateProject(project.id, { defaultGates: [] })
  const task = store.listTasks(project.id, goal.id)[0]!
  const { task: after } = await engine.runTask(project.id, task.id)
  assert.equal(after.state, 'human_gate')
  const receipt = store.listReceipts(project.id, task.id)[0]!
  assert.equal(receipt.verdict, 'FAIL')
  assert.match(receipt.reason, /no required gates/)
  void chief
})

test('Worker-requested human decision opens a gate; approval re-enters the loop with steer', async () => {
  let steerSeen: string | undefined
  const { store, engine, chief, project, goal } = setup(input => {
    if (input.attempt === 1) {
      input.report({ kind: 'blocker', current_state: 'blocked', progress: 10, changed_modules: [], verification_result: 'not_run', blocker: 'should add() also accept strings?', next_action: 'ask', human_required: true, summary: 'product question' })
      return
    }
    steerSeen = input.steer
    writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC)
  })
  let result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.goal.status, 'blocked')
  const gate = store.listHumanGates(project.id, 'open')[0]!
  assert.equal(gate.reason, 'worker-requested')
  const task = engine.resolveHumanGate(project.id, gate.id, 'approved', 'numbers only')!
  assert.equal(task.state, 'pending')
  result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.goal.status, 'complete')
  assert.equal(steerSeen, 'numbers only')
})

test('protected module change requires a human gate even when gates pass', async () => {
  const { store, engine, chief, project, goal } = setup(input => {
    writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC)
    input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: ['core-auth'], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: '' })
  })
  store.updateProject(project.id, { protectedModules: ['core-auth'] })
  const result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.tasks[0]!.state, 'human_gate')
  const gate = store.listHumanGates(project.id, 'open')[0]!
  assert.equal(gate.reason, 'protected-module')
  assert.equal(engine.resolveHumanGate(project.id, gate.id, 'approved', 'ok')!.state, 'passed')
})

test('crash recovery: interrupted attempt is closed and the loop resumes from persisted state', async () => {
  const { store, project, goal, root } = setup(() => {})
  const task = store.listTasks(project.id, goal.id)[0]!
  // Simulate a process that died mid-attempt.
  const worker = store.createWorker({ taskId: task.id, projectId: project.id, attempt: 1, executor: 'scripted', model: task.policy.model.worker })
  store.updateWorker(project.id, worker.id, { status: 'running' })
  store.updateTask(project.id, task.id, { state: 'executing', attempts: [{ n: 1, strategy: 'retry-with-feedback', model: task.policy.model.worker, workerId: worker.id, startedAt: new Date().toISOString() }] })

  // "Restart": a brand-new store + engine over the same home.
  const store2 = new StateStore(store.home)
  const engine2 = new LoopEngine({ store: store2, verifier: new Verifier(), executor: new ScriptedExecutor(input => { writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC) }) })
  const recovered = engine2.recoverInterrupted(project.id)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0]!.state, 'retrying')
  assert.equal(store2.getWorker(project.id, worker.id)!.status, 'killed')
  const { task: after } = await engine2.runTask(project.id, task.id)
  assert.equal(after.state, 'passed')
  assert.equal(after.attempts.length, 2)
  assert.equal(after.attempts[1]!.n, 2)
  void root
})

test('stop aborts the running Worker and leaves the task stopped', async () => {
  let release!: () => void
  const started = new Promise<void>(r => { release = r })
  const { engine, project, goal, store } = setup(input => new Promise<void>(resolve => {
    release()
    input.signal.addEventListener('abort', () => resolve(), { once: true })
  }).then(() => ({ exit: 'cancelled' as const })) as never)
  const task = store.listTasks(project.id, goal.id)[0]!
  const run = engine.runTask(project.id, task.id)
  await started
  engine.stop(project.id, task.id)
  const { task: after } = await run
  assert.equal(after.state, 'stopped')
  assert.equal(store.listReceipts(project.id).length, 0)
})

test('an executor that throws yields a crashed attempt that is still verified — never a stuck task', async () => {
  const { store, project, goal } = setup(() => {})
  const throwing = new LoopEngine({ store, verifier: new Verifier(), executor: { name: 'boom', run: async i => { if (i.attempt === 1) throw new Error('spawn ENOENT'); writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC); return { exit: 'completed' } } } })
  const task = store.listTasks(project.id, goal.id)[0]!
  const { task: after } = await throwing.runTask(project.id, task.id)
  assert.equal(after.state, 'passed')
  assert.equal(store.listWorkers(project.id).every(w => w.status === 'exited'), true)
})

test('re-running a goal resumes a task the human stopped', async () => {
  let runs = 0
  const { store, engine, chief, project, goal } = setup(input => { runs++; if (runs > 1) writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC) })
  const task = store.listTasks(project.id, goal.id)[0]!
  engine.stop(project.id, task.id)
  assert.equal(store.requireTask(project.id, task.id).state, 'stopped')
  const r = await chief.runGoal(project.id, goal.id)
  assert.equal(r.tasks[0]!.state, 'passed')
})
