import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor } from '@superagent/chief-worker'
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

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(v).slice(0, 400)}`)
    await sleep(100)
  }
}

test('API: project → goal → task → run → PASS, SSE stream, architecture, model selection, human gate, auth', async () => {
  const root = calcProject()
  let attempt = 0
  const runtime = createRuntime({
    home: tempDir('sa-home-'),
    executor: new ScriptedExecutor(input => {
      attempt++
      if (input.task.title === 'needs human') {
        input.report({ kind: 'blocker', current_state: 'q', progress: 0, changed_modules: [], verification_result: 'not_run', blocker: 'delete prod data?', next_action: null, human_required: true, summary: '' })
        return
      }
      if (attempt >= 2) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    }),
  })
  const token = 'test-token'
  const server = await startServer({ runtime, port: 0, humanToken: token, protectReads: true })
  try {
    await assert.rejects(api(server.url, 'GET', '/api/projects'), (e: any) => e.status === 401)
    const p = await api(server.url, 'POST', '/api/projects', { name: 'calc', root, defaultGates: [NODE_TEST_GATE] }, token)
    assert.equal(p.id, 'calc')

    // SSE subscriber collects live events.
    const received: any[] = []
    const ctrl = new AbortController()
    const sse = fetch(`${server.url}/api/events/stream?project=calc&token=${token}`, { signal: ctrl.signal }).then(async res => {
      const reader = res.body!.getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += new TextDecoder().decode(value)
        for (const block of buf.split('\n\n').slice(0, -1)) {
          const data = block.split('\n').find(l => l.startsWith('data: '))
          if (data) received.push(JSON.parse(data.slice(6)))
        }
        buf = buf.split('\n\n').at(-1)!
      }
    }).catch(() => {})
    await sleep(600)

    const goal = await api(server.url, 'POST', '/api/projects/calc/goals', { objective: 'fix add' }, token)
    const task = await api(server.url, 'POST', `/api/projects/calc/goals/${goal.id}/tasks`, { title: 'fix add', instructions: 'fix it' }, token)
    const updated = await api(server.url, 'POST', `/api/projects/calc/tasks/${task.id}/model`, { role: 'worker', model: 'anthropic/claude-opus-5-5' }, token)
    assert.deepEqual(updated.policy.model.worker, { provider: 'anthropic', model: 'claude-opus-5-5' })
    await api(server.url, 'POST', `/api/projects/calc/goals/${goal.id}/run`, {}, token)
    const detail = await until(() => api(server.url, 'GET', '/api/projects/calc', undefined, token), d => d.goal?.status === 'complete')
    assert.equal(detail.tasks[0].state, 'passed')
    assert.match(detail.report, /\[passed\] fix add/)
    const receipts = await api(server.url, 'GET', '/api/projects/calc/receipts', undefined, token)
    assert.deepEqual(receipts.map((r: any) => r.verdict).sort(), ['FAIL', 'PASS'])
    assert.ok(receipts.every((r: any) => r.model.model === 'claude-opus-5-5'))

    await until(async () => received.length, n => received.some(e => e.type === 'receipt/created') && received.some(e => e.type === 'goal/updated'))

    const graph = await api(server.url, 'GET', '/api/projects/calc/architecture', undefined, token)
    assert.ok(graph.nodes.length >= 1)
    assert.ok(Array.isArray(graph.edges))

    // Human gate via API.
    const goal2 = await api(server.url, 'POST', '/api/projects/calc/goals', { objective: 'risky' }, token)
    const t2 = await api(server.url, 'POST', `/api/projects/calc/goals/${goal2.id}/tasks`, { title: 'needs human', instructions: '...' }, token)
    await api(server.url, 'POST', `/api/projects/calc/goals/${goal2.id}/run`, {}, token)
    const blocked = await until(() => api(server.url, 'GET', '/api/projects/calc', undefined, token), d => d.goal?.status === 'blocked')
    const hg = blocked.humanGates.find((g: any) => g.status === 'open')
    assert.equal(hg.reason, 'worker-requested')
    const resolved = await api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'rejected', resolution: 'no' }, token)
    assert.equal(resolved.task.state, 'failed')
    assert.equal(resolved.task.id, t2.id)
    ctrl.abort()
    await sse
  } finally {
    await server.close()
  }
})

test('API refuses cross-origin and non-JSON POSTs (CSRF guard)', async () => {
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0 })
  try {
    const textPlain = await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'x', root: '/tmp' }) })
    assert.equal(textPlain.status, 415)
    const foreign = await fetch(`${server.url}/api/projects`, { headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.status, 403)
    const same = await fetch(`${server.url}/api/projects`, { headers: { origin: server.url } })
    assert.equal(same.status, 200)
  } finally {
    await server.close()
  }
})

test('privilege split: Workers (no token) and agents cannot resolve Human Gates or define gates; humans can', async () => {
  const root = calcProject()
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(i => { i.report({ kind: 'blocker', current_state: 'q', progress: 0, changed_modules: [], verification_result: 'not_run', blocker: 'drop prod?', next_action: null, human_required: true, summary: '' }) }) })
  const server = await startServer({ runtime, port: 0 })
  try {
    await assert.rejects(api(server.url, 'POST', '/api/projects', { name: 'calc', root }, server.agentToken), (e: any) => e.status === 403)
    await api(server.url, 'POST', '/api/projects', { name: 'calc', root, defaultGates: [NODE_TEST_GATE] }, server.humanToken)
    const goal = await api(server.url, 'POST', '/api/projects/calc/goals', { objective: 'x' }, server.agentToken)
    await assert.rejects(api(server.url, 'POST', `/api/projects/calc/goals/${goal.id}/tasks`, { title: 't', instructions: 'i', gates: [{ id: 'pwn', kind: 'command', command: 'exit 0', required: true }] }, server.agentToken), (e: any) => e.status === 400 && /registry/.test(e.message))
    const t = await api(server.url, 'POST', `/api/projects/calc/goals/${goal.id}/tasks`, { title: 't', instructions: 'i', gates: ['unit'], grants: { mayModifyVerification: true } }, server.agentToken)
    assert.equal(t.grants, undefined, 'agents cannot grant themselves permissions')
    await api(server.url, 'POST', `/api/projects/calc/goals/${goal.id}/run`, {}, server.agentToken)
    const blocked = await until(() => api(server.url, 'GET', '/api/projects/calc'), d => d.goal?.status === 'blocked')
    const hg = blocked.humanGates.find((g: any) => g.status === 'open')
    await assert.rejects(api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'approved' }), (e: any) => e.status === 401)
    await assert.rejects(api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'approved' }, server.agentToken), (e: any) => e.status === 403)
    await assert.rejects(api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'approved' }, 'guessed-token'), (e: any) => e.status === 401)
    const ok = await api(server.url, 'POST', `/api/projects/calc/human-gates/${hg.id}`, { decision: 'rejected' }, server.humanToken)
    assert.equal(ok.gate.status, 'rejected')
  } finally {
    await server.close()
  }
})
