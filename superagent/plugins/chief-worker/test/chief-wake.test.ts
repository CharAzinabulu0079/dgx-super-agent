import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { classifyEvent } from '@superagent/loop-policy'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { Chief, ChiefDriver, LoopEngine, ScriptedExecutor, WakeMonitor, type ChiefChannel, type ChiefDigest } from '../src/index.ts'

class RecordingChannel implements ChiefChannel {
  readonly name = 'recording'
  readonly digests: ChiefDigest[] = []
  failNext = 0
  async deliver(d: ChiefDigest): Promise<{ sessionId: string }> {
    if (this.failNext > 0) { this.failNext--; throw new Error('chief model unavailable') }
    this.digests.push(d)
    return { sessionId: 'chief-session-1' }
  }
}

const ev = (type: string, data: Record<string, unknown>) => ({ seq: 1, ts: '', type, projectId: 'p', data }) as never

test('wake policy: exceptional events wake, ordinary progress does not', () => {
  assert.equal(classifyEvent(ev('worker/report', { report: { kind: 'progress', human_required: false } })), undefined)
  assert.equal(classifyEvent(ev('task/state', { from: 'pending', to: 'executing' })), undefined)
  assert.equal(classifyEvent(ev('loop/decision', { decision: { action: 'retry', switched: false } })), undefined)
  assert.equal(classifyEvent(ev('receipt/created', { verdict: 'FAIL', claimOverruled: false, impactedModules: [] })), undefined)
  assert.equal(classifyEvent(ev('loop/decision', { decision: { action: 'retry', switched: true, reason: 'same failure ×2' } }))?.reason, 'repeated-failure')
  assert.equal(classifyEvent(ev('human-gate/opened', { reason: 'irreversible-data', detail: 'rm' }))?.priority, 'high')
  assert.equal(classifyEvent(ev('receipt/created', { integrityBlocked: true, attempt: 1 }))?.reason, 'integrity-violation')
  assert.equal(classifyEvent(ev('receipt/created', { claimOverruled: true, attempt: 1 }))?.reason, 'claim-overruled')
  assert.equal(classifyEvent(ev('receipt/created', { impactedModules: ['a', 'b', 'c'] }))?.reason, 'architecture-impact')
  assert.equal(classifyEvent(ev('architecture/drift', { errors: 2 }))?.reason, 'architecture-drift')
  assert.equal(classifyEvent(ev('worker/report', { report: { kind: 'blocker', human_required: false, blocker: 'missing API key' } }))?.reason, 'worker-blocker')
  assert.equal(classifyEvent(ev('goal/updated', { status: 'complete' }))?.reason, 'final-review')
  assert.equal(classifyEvent(ev('goal/updated', { status: 'blocked' }))?.reason, 'goal-blocked')
})

async function loopWithWakes(channel: ChiefChannel) {
  const root = calcProject()
  const store = new StateStore(tempDir('sa-home-'))
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(i => {
    for (let k = 0; k < 5; k++) i.report({ kind: 'progress', current_state: `step ${k}`, progress: k * 10, changed_modules: [], verification_result: 'not_run', blocker: null, next_action: null, human_required: false, summary: '' })
    if (i.attempt >= 3) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
  }) })
  const chief = new Chief(engine)
  const p = store.createProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = chief.createGoal(p.id, 'fix add')
  chief.addTask(p.id, goal.id, { title: 'fix add', instructions: '...', policy: { maxSameFailure: 2 } })
  await chief.runGoal(p.id, goal.id)
  const driver = new ChiefDriver({ store, channel, minIntervalMs: 0, statusReport: id => chief.statusReport(id) })
  return { store, p, driver, chief }
}

test('Worker events wake the Chief once, coalesced; routine progress never does', async () => {
  const channel = new RecordingChannel()
  const { store, p, driver } = await loopWithWakes(channel)
  const delivered = await driver.tick()
  assert.equal(delivered.length, 1)
  const reasons = channel.digests[0]!.wakes.map(w => w.reason)
  assert.deepEqual([...new Set(reasons)].sort(), ['final-review', 'repeated-failure'])
  assert.ok(!reasons.some(r => r === ('worker-progress' as never)))
  assert.match(channel.digests[0]!.text, /\[passed\] fix add/)
  // Nothing new → no further Chief call.
  assert.equal((await driver.tick()).length, 0)
  const progressEvents = store.readEvents(p.id).filter(e => e.type === 'worker/report').length
  assert.ok(progressEvents >= 15, 'plenty of progress happened without waking the Chief')
})

test('pending wakes survive a restart and are delivered exactly once; the cursor prevents duplicates', async () => {
  const failing = new RecordingChannel()
  failing.failNext = 1
  const { store, p } = await loopWithWakes(failing)
  const d1 = new ChiefDriver({ store, channel: failing, minIntervalMs: 0, backoffMs: 0 })
  assert.equal((await d1.tick()).length, 0, 'first delivery failed')
  const pending = new WakeMonitor(store).pending(p.id)
  assert.ok(pending.length >= 2)
  assert.ok(pending.every(w => w.deliveries === 1 && w.lastError === 'chief model unavailable'))
  // "Restart": new store/monitor/driver instances over the same home.
  const store2 = new StateStore(store.home)
  const channel2 = new RecordingChannel()
  const d2 = new ChiefDriver({ store: store2, channel: channel2, minIntervalMs: 0 })
  assert.equal((await d2.tick()).length, 1)
  assert.equal(channel2.digests[0]!.wakes.length, pending.length, 'no wake re-created from already-processed events')
  assert.equal(new WakeMonitor(store2).pending(p.id).length, 0)
  assert.equal(new WakeMonitor(store2).scan(p.id).length, 0)
})

test('rate limit coalesces bursts; failures back off and give up after maxDeliveries', async () => {
  const channel = new RecordingChannel()
  const { store, p } = await loopWithWakes(channel)
  const driver = new ChiefDriver({ store, channel, minIntervalMs: 60_000 })
  const t0 = Date.now()
  assert.equal((await driver.tick(t0)).length, 1)
  store.emitTyped('architecture/drift', p.id, { errors: 1 })
  assert.equal((await driver.tick(t0 + 1_000)).length, 0, 'within the coalescing window')
  assert.equal((await driver.tick(t0 + 61_000)).length, 1)
  assert.equal(channel.digests[1]!.wakes[0]!.reason, 'architecture-drift')

  const broken = new RecordingChannel()
  broken.failNext = 99
  const d = new ChiefDriver({ store, channel: broken, minIntervalMs: 0, backoffMs: 1, maxDeliveries: 2 })
  store.emitTyped('goal/updated', p.id, { status: 'blocked', blocker: 'x' })
  await d.tick(t0 + 120_000)
  await d.tick(t0 + 240_000)
  const failed = store.listRecords<{ status: string; reason: string }>(p.id, 'wakes').filter(w => w.reason === 'goal-blocked')
  assert.deepEqual(failed.map(w => w.status), ['failed'])
})

test('low-priority-only wakes wait for a batch window', async () => {
  const channel = new RecordingChannel()
  const store = new StateStore(tempDir('sa-home-'))
  const p = store.createProject({ name: 'x', root: calcProject() })
  store.emitTyped('learning/candidate', p.id, { kind: 'skill', name: 'fix-x' })
  const driver = new ChiefDriver({ store, channel, minIntervalMs: 0, lowPriorityDelayMs: 60_000 })
  assert.equal((await driver.tick()).length, 0)
  assert.equal((await driver.tick(Date.now() + 61_000)).length, 1)
})
