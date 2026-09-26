import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, git, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { applyCleanup, createBackup, createRuntime, previewCleanup, startServer } from '../src/index.ts'

test('cleanup: preview then apply; keeps what open tasks and pending learning still need', async () => {
  const home = tempDir('sa-home-')
  const root = calcProject()
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(i => { writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }) })
  runtime.learning.replay = undefined
  await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const g = runtime.chief.createGoal('calc', 'g')
  const done = runtime.chief.addTask('calc', g.id, { title: 'done', instructions: 'i' })
  const kept = runtime.chief.addTask('calc', g.id, { title: 'kept for learning', instructions: 'i' })
  await runtime.chief.runGoal('calc', g.id)
  const open = runtime.chief.addTask('calc', runtime.chief.createGoal('calc', 'g2').id, { title: 'open', instructions: 'i' })
  git(root, 'update-ref', `refs/superagent/${open.id}/baseline`, 'HEAD')
  git(root, 'update-ref', 'refs/superagent/task_deleted/baseline', 'HEAD')
  const refsOf = (t: string) => git(root, 'for-each-ref', '--format=%(refname)', `refs/superagent/${t}/`).trim().split('\n').filter(Boolean)
  assert.ok(refsOf(done.id).length >= 3)

  // Leftovers: an orphaned Worker, a stale lease, old logs, a temp dir, old backups.
  const deadPid = spawnSync('true').pid!
  const w = runtime.store.createWorker({ taskId: open.id, projectId: 'calc', attempt: 1, executor: 'dsh-headless', model: { provider: 'x', model: 'y' } })
  runtime.store.updateWorker('calc', w.id, { status: 'running', pid: deadPid })
  mkdirSync(join(home, 'projects', 'calc', 'leases'), { recursive: true })
  writeFileSync(join(home, 'projects', 'calc', 'leases', `${open.id}.lock`), JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }))
  mkdirSync(join(home, 'runtime', 'workers', 'wkr_gone'), { recursive: true })
  writeFileSync(join(home, 'runtime', 'workers', 'wkr_gone', 'events.jsonl'), 'x'.repeat(1000))
  const temp = mkdtempSync(join(tmpdir(), 'sa-gate-'))
  utimesSync(temp, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000))
  for (let i = 0; i < 3; i++) createBackup(home, { label: `b${i}` })

  const ctx = { store: runtime.store, engine: runtime.engine, days: 0, keepBackups: 1, pendingLearningTasks: () => new Set([kept.id]) }
  const preview = Object.fromEntries(previewCleanup(ctx).map(i => [i.kind, i.count]))
  assert.equal(preview['orphan-workers'], 1)
  assert.equal(preview['stale-leases'], 1)
  assert.equal(preview['old-backups'], 2)
  assert.ok(preview['worker-logs']! >= 1)
  assert.ok(preview.temp! >= 1)
  assert.equal(existsSync(temp), true, 'preview changes nothing')

  const applied = applyCleanup(ctx, ['orphan-workers', 'stale-leases', 'snapshot-refs', 'worker-logs', 'temp', 'old-backups'])
  assert.ok(applied.length >= 5)
  assert.deepEqual(refsOf(done.id), [], 'finished task snapshots removed')
  assert.ok(refsOf(kept.id).length > 0, 'snapshots a pending learning candidate needs are kept')
  assert.deepEqual(refsOf(open.id), [`refs/superagent/${open.id}/baseline`], 'open task untouched')
  assert.deepEqual(refsOf('task_deleted'), [], 'refs of deleted tasks removed')
  assert.equal(runtime.store.getWorker('calc', w.id)!.status, 'killed')
  assert.equal(runtime.store.readLease('calc', open.id), undefined)
  assert.equal(existsSync(join(home, 'runtime', 'workers', 'wkr_gone')), false)
  assert.equal(existsSync(temp), false)
  assert.equal(previewCleanup(ctx).find(i => i.kind === 'old-backups')!.count, 0)

  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const res = await fetch(`${server.url}/api/system/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.agentToken}` }, body: JSON.stringify({ kinds: ['temp'] }) })
    assert.equal(res.status, 403, 'human only')
    const bad = await fetch(`${server.url}/api/system/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer h' }, body: JSON.stringify({ kinds: ['everything'] }) })
    assert.equal(bad.status, 400)
  } finally {
    await server.close()
  }
})
