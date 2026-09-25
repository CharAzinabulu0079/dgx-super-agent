import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { decideToolCall, type ToolPolicy } from '@superagent/loop-policy'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { Chief, LoopEngine, PlanError, ScriptedExecutor, ScriptedReviewer, buildWorkerPrompt, parsePlan, parseReview, type Planner, type ReviewInput } from '../src/index.ts'

const REGISTRY = [NODE_TEST_GATE, { id: 'e2e', kind: 'e2e', command: 'x', required: true }] as never

test('parsePlan: accepts registry gate ids, rejects invented gates, inline gates and oversize plans', () => {
  const ok = parsePlan({ objective: 'o', tasks: [{ title: 'a', instructions: 'do a', gates: ['unit'], review: true }, { title: 'b', instructions: 'do b' }] }, REGISTRY, 'test')
  assert.equal(ok.tasks.length, 2)
  assert.deepEqual(ok.tasks[0]!.gates, ['unit'])
  assert.equal(ok.tasks[0]!.review, true)
  assert.deepEqual(ok.tasks[1]!.gates, [])
  assert.throws(() => parsePlan({ objective: 'o', tasks: [{ title: 'a', instructions: 'x', gates: ['always-pass'] }] }, REGISTRY, 't'), /not in the gate registry/)
  assert.throws(() => parsePlan({ objective: 'o', tasks: [{ title: 'a', instructions: 'x', gates: [{ id: 'g', command: 'true' }] }] }, REGISTRY, 't'), PlanError)
  assert.throws(() => parsePlan({ objective: 'o', tasks: Array.from({ length: 9 }, () => ({ title: 'a', instructions: 'x' })) }, REGISTRY, 't'), /at most 8/)
  assert.throws(() => parsePlan({ objective: 'o', tasks: [] }, REGISTRY, 't'), /non-empty/)
  assert.throws(() => parseReview('no block', 'r'), PlanError)
  assert.deepEqual(parseReview('```superagent-review\n{"approve":false,"comments":"handle zero"}\n```', 'r'), { approve: false, comments: 'handle zero', reviewer: 'r' })
})

function setup(executor: ConstructorParameters<typeof LoopEngine>[0]['executor'], reviewer?: ConstructorParameters<typeof LoopEngine>[0]['reviewer']) {
  const root = calcProject()
  const store = new StateStore(tempDir('sa-home-'))
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor, reviewer })
  const chief = new Chief(engine)
  const p = store.createProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] as never })
  return { root, store, engine, chief, p }
}

test('planGoal: a model plan becomes a goal with agent-scoped tasks; failures fall back to one task', async () => {
  const { store, chief, p } = setup(new ScriptedExecutor(() => {}))
  const planner: Planner = { name: 'fake', plan: async i => parsePlan({ objective: 'calc v2', tasks: [{ title: 'fix add', instructions: 'fix it', gates: ['unit'] }, { title: 'docs', instructions: 'document add', review: true }] }, i.gates, 'fake') }
  const r = await chief.planGoal(p.id, 'fix add and document it', { planner })
  assert.equal(r.goal.objective, 'calc v2')
  assert.equal(r.goal.request, 'fix add and document it')
  assert.deepEqual(r.tasks.map(t => [t.title, t.gates.map(g => g.id).join(','), t.review ?? false]), [['fix add', 'unit', false], ['docs', '', true]])
  assert.ok(store.readEvents(p.id).some(e => e.type === 'request/submitted'))

  const broken: Planner = { name: 'broken', plan: async () => { throw new PlanError('no `superagent-plan` block') } }
  const f = await chief.planGoal(p.id, 'make add handle strings\nand more', { planner: broken, review: true })
  assert.equal(f.tasks.length, 1)
  assert.equal(f.tasks[0]!.instructions, 'make add handle strings\nand more')
  assert.equal(f.tasks[0]!.review, true)
  assert.match(f.plan.note!, /planner broken failed/)
})

test('reviewer: can block a green attempt with comments the next attempt sees; approval passes', async () => {
  const prompts: string[] = []
  const seen: ReviewInput[] = []
  let reviews = 0
  const { store, chief, p } = setup(
    new ScriptedExecutor(i => {
      prompts.push(buildWorkerPrompt(i, [NODE_TEST_GATE]))
      writeFileSync(join(i.project.root, 'src/calc.js'), i.attempt === 1 ? FIXED_CALC : `${FIXED_CALC}// handles zero\n`)
    }),
    new ScriptedReviewer(input => { seen.push(input); return ++reviews === 1 ? { approve: false, comments: 'Please note zero handling explicitly.' } : { approve: true, comments: 'LGTM' } }),
  )
  const goal = chief.createGoal(p.id, 'fix add')
  const task = chief.addTask(p.id, goal.id, { title: 'fix add', instructions: 'fix add', review: true })
  const r = await chief.runGoal(p.id, goal.id)
  assert.equal(r.tasks[0]!.state, 'passed')
  assert.equal(store.requireTask(p.id, task.id).attempts.length, 2)
  assert.match(seen[0]!.diff, /\+export function add\(a, b\) \{ return a \+ b \}/, 'reviewer sees the task diff')
  assert.match(prompts[1]!, /reviewer requested changes[\s\S]*zero handling/)
  assert.deepEqual(store.requireTask(p.id, task.id).reviews!.map(x => x.approve), [false, true])
})

test('reviewer: never consulted on red gates; persistent rejection, crash or absence → human gate', async () => {
  let called = 0
  const red = setup(new ScriptedExecutor(() => {}), new ScriptedReviewer(() => { called++; return { approve: true, comments: '' } }))
  const g1 = red.chief.createGoal(red.p.id, 'x')
  red.chief.addTask(red.p.id, g1.id, { title: 't', instructions: 'i', review: true, policy: { maxAttempts: 2 } })
  await red.chief.runGoal(red.p.id, g1.id)
  assert.equal(called, 0, 'reviewer cannot rescue failing gates')

  const nay = setup(new ScriptedExecutor(i => { writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }), new ScriptedReviewer(() => ({ approve: false, comments: 'no' })))
  const g2 = nay.chief.createGoal(nay.p.id, 'x')
  nay.chief.addTask(nay.p.id, g2.id, { title: 't', instructions: 'i', review: true })
  const r2 = await nay.chief.runGoal(nay.p.id, g2.id)
  assert.equal(r2.tasks[0]!.state, 'human_gate')
  const gate = nay.store.listHumanGates(nay.p.id, 'open')[0]!
  assert.equal(gate.reason, 'review-disagreement')
  assert.equal(nay.engine.resolveHumanGate(nay.p.id, gate.id, 'approved', 'fine as is')!.state, 'passed', 'a human can overrule the reviewer')

  for (const reviewer of [new ScriptedReviewer(() => { throw new Error('model down') }), undefined]) {
    const s = setup(new ScriptedExecutor(i => { writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }), reviewer)
    const g = s.chief.createGoal(s.p.id, 'x')
    s.chief.addTask(s.p.id, g.id, { title: 't', instructions: 'i', review: true })
    const r = await s.chief.runGoal(s.p.id, g.id)
    assert.equal(r.tasks[0]!.state, 'human_gate')
    assert.equal(r.tasks[0]!.attempts.length, 1, 'no attempts burned on an unavailable reviewer')
  }
})

test('advisor sessions (planner/reviewer) are read-only and cannot read SuperAgent state', () => {
  const home = tempDir('sa-home-')
  const policy: ToolPolicy = { role: 'advisor', projectRoot: '/repo', verificationPaths: [], protectedModulePaths: [], approvedActions: [], forbiddenPaths: [home], apiOrigins: [], productionWrite: false, tempRoots: ['/tmp'] }
  assert.equal(decideToolCall(policy, 'read', { file_path: '/repo/src/a.ts' }).allow, true)
  assert.equal(decideToolCall(policy, 'grep', { pattern: 'x', path: '/repo' }).allow, true)
  assert.equal(decideToolCall(policy, 'read', { file_path: join(home, 'heldout/p/a.test.js') }).allow, false)
  for (const [tool, args] of [['write', { file_path: '/repo/a' }], ['bash', { command: 'ls' }], ['edit', { file_path: '/repo/a' }], ['mcp__playwright-mcp__browser_navigate', { url: 'x' }]] as const) {
    assert.equal(decideToolCall(policy, tool, args as never).allow, false, tool)
  }
})
