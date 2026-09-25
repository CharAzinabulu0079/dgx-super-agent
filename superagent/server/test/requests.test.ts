import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor, parsePlan, type Planner } from '@superagent/chief-worker'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'

async function api(base: string, method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status })
  return json
}
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(v).slice(0, 400)}`)
    await sleep(100)
  }
}

const planner: Planner = {
  name: 'fake',
  plan: async i => parsePlan({ objective: 'Fix the calculator', tasks: [{ title: 'fix add', instructions: i.request, gates: ['unit'] }] }, i.gates, 'fake'),
}

test('one-box request: plan → goal → run to PASS, narrated activity; a second request queues', async () => {
  const root = calcProject()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const runtime = createRuntime({
    home: tempDir('sa-home-'), planner,
    executor: new ScriptedExecutor(async i => {
      if (i.task.instructions.includes('slow')) await gate
      writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC)
    }),
  })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const p = await api(server.url, 'POST', '/api/projects', { name: 'calc', root }, 'h')
    assert.deepEqual(p.defaultGates.map((g: { id: string }) => g.id), ['unit', 'architecture'], 'gates auto-detected')
    await assert.rejects(api(server.url, 'POST', '/api/projects/calc/requests', { request: 'x' }), /credential/)
    const first = await api(server.url, 'POST', '/api/projects/calc/requests', { request: 'slow: make add correct' }, server.agentToken)
    assert.equal(first.run.started, true)
    assert.equal(first.plan.planner, 'fake')
    assert.equal(first.tasks[0].gates[0].id, 'unit')
    const second = await api(server.url, 'POST', '/api/projects/calc/requests', { request: 'also keep it correct' }, 'h')
    assert.equal(second.run.queued, true, 'one goal per worktree; the next waits')
    release()
    await until(() => api(server.url, 'GET', '/api/projects/calc'), (s: any) => s.goals.every((g: any) => g.status === 'complete'))
    const activity = await api(server.url, 'GET', '/api/projects/calc/activity')
    const text = activity.map((a: any) => a.text).join('\n')
    assert.match(text, /Planned your request into 1 task: fix add/)
    assert.match(text, /“fix add”: independent checks passed/)
    assert.match(text, /Goal complete/)
  } finally {
    await server.close()
  }
})

test('goal runs survive a restart, and approving a human gate resumes the goal', async () => {
  const root = calcProject()
  const home = tempDir('sa-home-')
  // Server 1 "crashes" with a goal requested but never run.
  const rt1 = createRuntime({ home, planner, executor: new ScriptedExecutor(() => {}) })
  await rt1.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const planned = await rt1.chief.planGoal('calc', 'fix add')
  rt1.store.updateGoal('calc', planned.goal.id, { runRequested: true })

  let human = true
  const rt2 = createRuntime({
    home, planner,
    executor: new ScriptedExecutor(i => {
      if (human) {
        human = false
        i.report({ kind: 'blocker', current_state: 'q', progress: 0, changed_modules: [], verification_result: 'not_run', blocker: 'which rounding?', next_action: null, human_required: true, summary: '' })
        return
      }
      writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC)
    }),
  })
  const server = await startServer({ runtime: rt2, port: 0, humanToken: 'h', resumeGoals: true })
  try {
    const blocked = await until(() => rt2.store.getGoal('calc', planned.goal.id)!, g => g.status === 'blocked')
    assert.equal(blocked.runRequested, false)
    const hg = rt2.store.listHumanGates('calc', 'open')[0]!
    const r = await api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'approved', resolution: 'round half up' }, 'h')
    assert.equal(r.resumed, true)
    await until(() => rt2.store.getGoal('calc', planned.goal.id)!, g => g.status === 'complete')
  } finally {
    await server.close()
  }
})
