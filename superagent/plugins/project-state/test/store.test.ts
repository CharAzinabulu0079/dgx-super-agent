import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tempDir } from '@superagent/testkit'
import { StateStore } from '../src/index.ts'

const policy = { model: { worker: { provider: 'local-default', model: 'default' } }, production_write: false, maxAttempts: 3, maxSameFailure: 2, strategies: ['retry-with-feedback' as const] }

test('projects are keyed by root and survive a new store instance', () => {
  const home = tempDir()
  const root = tempDir()
  const s1 = new StateStore(home)
  const p = s1.createProject({ name: 'Demo App', root })
  assert.equal(p.id, 'demo-app')
  assert.equal(s1.createProject({ name: 'other', root }).id, 'demo-app')
  const s2 = new StateStore(home)
  assert.deepEqual(s2.getProject('demo-app'), p)
  assert.equal(s2.findProjectByRoot(root)?.id, 'demo-app')
})

test('events get monotonic seq across store instances (cross-process appends)', () => {
  const home = tempDir()
  const a = new StateStore(home)
  const p = a.createProject({ name: 'p', root: tempDir() })
  const b = new StateStore(home)
  const e1 = a.emitTyped('chief/wake', p.id, { n: 1 })
  const e2 = b.emitTyped('chief/wake', p.id, { n: 2 })
  const e3 = a.emitTyped('chief/wake', p.id, { n: 3 })
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [2, 3, 4])
  assert.deepEqual(a.readEvents(p.id, 2).map(e => e.data.n), [2, 3])
})

test('goal/task lifecycle, state transitions emit events, reports feed worker view', () => {
  const s = new StateStore(tempDir())
  const p = s.createProject({ name: 'p', root: tempDir() })
  const g = s.createGoal(p.id, 'ship it')
  const t = s.createTask({ projectId: p.id, goalId: g.id, title: 't', instructions: 'i', scope: { paths: [], modules: [] }, gates: [], policy })
  assert.deepEqual(s.getGoal(p.id, g.id)!.taskIds, [t.id])
  s.updateTask(p.id, t.id, { state: 'executing' })
  const w = s.createWorker({ taskId: t.id, projectId: p.id, attempt: 1, executor: 'x', model: policy.model.worker })
  s.appendReport(p.id, w.id, { task_id: t.id, kind: 'progress', current_state: 'editing', progress: 40, changed_modules: ['ui'], verification_result: 'not_run', blocker: null, next_action: 'test', human_required: false, model: policy.model.worker, summary: '' })
  assert.deepEqual(s.getWorker(p.id, w.id)!.activeModules, ['ui'])
  const stateEvents = s.readEvents(p.id).filter(e => e.type === 'task/state')
  assert.deepEqual(stateEvents.map(e => e.data), [{ from: 'pending', to: 'executing' }])
  assert.equal(s.currentGoal(p.id)!.id, g.id)
})

test('ids are validated against path traversal', () => {
  const s = new StateStore(tempDir())
  assert.throws(() => s.getProject('../etc'), /invalid project id/)
})
