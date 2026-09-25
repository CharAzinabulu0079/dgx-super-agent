import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Attempt, Task, WorkerReport } from '@superagent/contracts'
import { decideNext, trailingSameFailures } from '../src/index.ts'

const worker = { provider: 'local-default', model: 'default' }
const task = (over: Partial<Task['policy']> = {}): Task => ({
  id: 't', projectId: 'p', goalId: 'g', title: 't', instructions: '', scope: { paths: [], modules: [] }, gates: [], state: 'verifying', attempts: [],
  createdAt: '', updatedAt: '',
  policy: { model: { worker }, production_write: false, maxAttempts: 5, maxSameFailure: 2, strategies: ['retry-with-feedback', 'fresh-context'], ...over },
})
const att = (n: number, verdict: 'PASS' | 'FAIL', sig?: string, strategy: Attempt['strategy'] = 'retry-with-feedback'): Attempt =>
  ({ n, strategy, model: worker, workerId: `w${n}`, startedAt: '', verdict, failureSignature: sig })
const report = (human: boolean): WorkerReport => ({ task_id: 't', kind: 'blocker', current_state: '', progress: 0, changed_modules: [], verification_result: 'not_run', blocker: 'drop table?', next_action: null, human_required: human, model: worker, summary: '' })

test('worker human request beats a PASS verdict', () => {
  const d = decideNext({ task: task(), attempts: [att(1, 'PASS')], receipt: { verdict: 'PASS', reason: 'ok', changedModules: [] }, lastReport: report(true), protectedModules: [] })
  assert.equal(d.action, 'human_gate')
})

test('different failures keep retrying; identical ones switch strategy; budget ends in a Human Gate', () => {
  const r = { verdict: 'FAIL' as const, reason: 'x', changedModules: [] }
  assert.deepEqual(decideNext({ task: task(), attempts: [att(1, 'FAIL', 'a'), att(2, 'FAIL', 'b')], receipt: r, protectedModules: [] }), { action: 'retry', strategy: 'retry-with-feedback', switched: false, reason: 'retry under retry-with-feedback: x' })
  const sw = decideNext({ task: task(), attempts: [att(1, 'FAIL', 'a'), att(2, 'FAIL', 'a')], receipt: r, protectedModules: [] })
  assert.equal(sw.action === 'retry' && sw.strategy, 'fresh-context')
  const out = decideNext({ task: task({ maxAttempts: 2 }), attempts: [att(1, 'FAIL', 'a'), att(2, 'FAIL', 'b')], receipt: r, protectedModules: [] })
  assert.equal(out.action === 'human_gate' && out.reason, 'repeated-failure')
  assert.equal(trailingSameFailures([att(1, 'FAIL', 'a', 'fresh-context'), att(2, 'FAIL', 'a')], 'a', 'retry-with-feedback'), 1)
})
