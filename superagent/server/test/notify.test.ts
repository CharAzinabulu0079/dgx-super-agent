import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'
import { classify, saveNotify } from '../src/ops/notify.ts'

async function call(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('notifications: ntfy gets "needs your decision" in Chinese; secrets are write-only; human only', async () => {
  const got: any[] = []
  const ntfy = createServer((req, res) => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { got.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.end('{}') }) })
  await new Promise<void>(r => ntfy.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/sa-alerts`
  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(i => { i.report({ kind: 'blocker', current_state: 'q', progress: 0, changed_modules: [], verification_result: 'not_run', blocker: '要删除生产数据吗？', next_action: null, human_required: true, summary: '' }) }) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    assert.equal((await call(server.url, 'POST', '/api/system/notify', { channels: [] }, server.agentToken)).status, 403)
    const saved = await call(server.url, 'POST', '/api/system/notify', { channels: [{ kind: 'ntfy', url, token: 'tk_secret' }], events: { done: false } }, 'h')
    assert.equal(saved.status, 200)
    assert.doesNotMatch(JSON.stringify(saved.json), /tk_secret/)
    assert.equal(statSync(join(home, 'notify.json')).mode & 0o777, 0o600)
    // Saving again without the token keeps it.
    await call(server.url, 'POST', '/api/system/notify', { channels: [{ kind: 'ntfy', url }], events: { done: false } }, 'h')
    const t = await call(server.url, 'POST', '/api/system/notify/test', {}, 'h')
    assert.equal(t.json.results[0].ok, true)
    assert.equal(got.at(-1).auth, 'Bearer tk_secret')
    assert.equal(got.at(-1).topic, 'sa-alerts')

    await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    const goal = runtime.chief.createGoal('calc', 'g')
    runtime.chief.addTask('calc', goal.id, { title: '清理数据', instructions: 'i' })
    runtime.goals.start('calc', goal.id)
    await runtime.goals.idle('calc')
    for (let i = 0; i < 50 && got.length < 2; i++) await new Promise(r => setTimeout(r, 20))
    const push = got.find(g => /需要你决定/.test(g.title))
    assert.ok(push, JSON.stringify(got))
    assert.match(push.title, /calc/)
    assert.match(push.message, /清理数据|要删除生产数据/)
  } finally {
    await server.close()
    ntfy.close()
  }
})

test('notifications: which events notify; invalid channels are refused', () => {
  const e = (type: string, data: object) => ({ seq: 1, ts: '', type, projectId: 'p', data }) as any
  assert.equal(classify(e('goal/updated', { from: 'active', status: 'complete' })), 'done')
  assert.equal(classify(e('goal/updated', { from: 'active', status: 'failed' })), 'stuck')
  assert.equal(classify(e('human-gate/opened', {})), 'decision')
  assert.equal(classify(e('goal/updated', { from: 'active', status: 'active' })), undefined)
  const home = tempDir('sa-home-')
  assert.throws(() => saveNotify(home, { channels: [{ kind: 'telegram', botToken: 'x', chatId: '1' }] }), /bot token/)
  assert.throws(() => saveNotify(home, { channels: [{ kind: 'ntfy', url: 'ftp://x' }] }), /URL/)
  assert.throws(() => saveNotify(home, { channels: [{ kind: 'email' }] }), /kind/)
})
