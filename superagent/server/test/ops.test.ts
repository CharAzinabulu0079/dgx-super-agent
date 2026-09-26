import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { loadModelRoutes } from '@superagent/chief-worker'
import { calcProject, gitRepo, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'
import { KEYLESS_ENV, removeProvider, saveProvider, storedConnection } from '../src/ops/providers.ts'

/** Minimal OpenAI-compatible server: /v1/models and /v1/chat/completions, key "sk-good". */
async function fakeProvider() {
  const calls: string[] = []
  const srv = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.headers.authorization !== 'Bearer sk-good') { res.writeHead(401).end('{}'); return }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen-coder' }, { id: 'qwen-max' }] })); return }
    if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'p' } }] })); return }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, calls, close: () => srv.close() }
}

async function call(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('provider wizard → presets → health: probe, test, save (key write-only), one-click preset, green models', async () => {
  const prov = await fakeProvider()
  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    assert.equal((await call(server.url, 'POST', '/api/system/providers/probe', { baseURL: prov.url, apiKey: 'sk-good' }, server.agentToken)).status, 403, 'human only')
    const bad = await call(server.url, 'POST', '/api/system/providers/probe', { baseURL: prov.url, apiKey: 'sk-bad' }, 'h')
    assert.equal(bad.json.kind, 'unauthorized')
    const down = await call(server.url, 'POST', '/api/system/providers/probe', { baseURL: 'http://127.0.0.1:9/v1' }, 'h')
    assert.equal(down.json.kind, 'unreachable')
    const ok = await call(server.url, 'POST', '/api/system/providers/probe', { baseURL: `${prov.url}/`, apiKey: 'sk-good' }, 'h')
    assert.deepEqual(ok.json.models, ['qwen-coder', 'qwen-max'])
    assert.equal((await call(server.url, 'POST', '/api/system/providers/test', { baseURL: prov.url, apiKey: 'sk-good', model: 'qwen-coder' }, 'h')).json.ok, true)
    assert.equal((await call(server.url, 'POST', '/api/system/providers', { name: 'dgx', api: 'openai-completions', baseURL: 'javascript:1', apiKey: 'x', models: ['m'] }, 'h')).status, 400)

    const saved = await call(server.url, 'POST', '/api/system/providers', { name: 'dgx', api: 'openai-completions', baseURL: prov.url, apiKey: 'sk-good', models: ['qwen-coder', 'qwen-max'], makeLocalDefault: true }, 'h')
    assert.equal(saved.status, 200)
    assert.deepEqual({ hasKey: saved.json.hasKey, local: saved.json.isLocalDefault }, { hasKey: true, local: true })
    const list = await call(server.url, 'GET', '/api/system/providers')
    assert.doesNotMatch(JSON.stringify(list.json), /sk-good/, 'the key is never returned')
    const routes = loadModelRoutes(home)
    assert.equal((routes.piAiProviders as any).dgx.apiKeyEnv, 'SA_KEY_DGX')
    assert.equal(routes.env!.SA_KEY_DGX, 'sk-good')
    assert.deepEqual(routes.aliases!['local-default'], { provider: 'dgx', model: 'qwen-coder' })
    assert.equal(statSync(join(home, 'model-routes.json')).mode & 0o777, 0o600)
    // Stored key is reused for probes without sending it again.
    assert.equal((await call(server.url, 'POST', '/api/system/providers/probe', { name: 'dgx' }, 'h')).json.ok, true)

    // Presets: an unset preset is unavailable; configure + apply switches every role at once.
    let presets = (await call(server.url, 'GET', '/api/system/presets')).json.presets
    assert.equal(presets.find((p: any) => p.id === 'budget').available, false)
    const budget = { id: 'budget', name: 'Budget', models: { chief: 'dgx/qwen-max', planner: 'dgx/qwen-max', worker: 'dgx/qwen-coder', reviewer: 'dgx/qwen-max', escalation: 'dgx/qwen-max' } }
    assert.equal((await call(server.url, 'POST', '/api/system/presets', { presets: [budget, { id: 'bad', models: { worker: 'nowhere/x' } }] }, 'h')).status, 200)
    presets = (await call(server.url, 'GET', '/api/system/presets')).json.presets
    assert.equal(presets.find((p: any) => p.id === 'bad').available, false)
    assert.equal((await call(server.url, 'POST', '/api/system/presets/bad/apply', {}, 'h')).status, 400)
    const applied = await call(server.url, 'POST', '/api/system/presets/budget/apply', {}, 'h')
    assert.deepEqual(applied.json.policy.models.worker, { provider: 'dgx', model: 'qwen-coder' })
    assert.equal(applied.json.presets.find((p: any) => p.id === 'budget').active, true)
    const goal = runtime.chief.createGoal('calc', 'g')
    const t = runtime.chief.addTask('calc', goal.id, { title: 't', instructions: 'i' })
    assert.deepEqual(t.policy.model.worker, { provider: 'dgx', model: 'qwen-coder' }, 'new tasks follow the preset')

    // Health: models probed (no tokens), all providers green; deep test is human-only.
    const completions = () => prov.calls.filter(c => c.includes('chat/completions')).length
    const before = completions()
    const health = (await call(server.url, 'GET', '/api/system/health')).json
    const dgx = health.checks.find((c: any) => c.id === 'models.dgx')
    assert.equal(dgx.status, 'ok', dgx.detail)
    assert.equal(completions(), before, 'the quick check spends no tokens')
    assert.equal((await call(server.url, 'POST', '/api/system/health', { deep: true }, server.agentToken)).status, 403)
    const deep = (await call(server.url, 'POST', '/api/system/health', { deep: true }, 'h')).json
    assert.match(deep.checks.find((c: any) => c.id === 'models.dgx').detail, /qwen-coder answered/)
  } finally {
    await server.close()
    prov.close()
  }
})

test('a keyless local server (llama.cpp) still gets a key reference, or DSH refuses to call it', () => {
  const home = tempDir('sa-home-')
  const view = saveProvider(home, { name: 'llamacpp', api: 'openai-completions', baseURL: 'http://127.0.0.1:30021/v1', models: [{ id: 'm' }], makeLocalDefault: true })
  assert.equal(view.hasKey, false, 'the placeholder is not reported as a key')
  const routes = loadModelRoutes(home)
  const env = (routes.piAiProviders as any).llamacpp.apiKeyEnv
  assert.equal(env, KEYLESS_ENV)
  assert.ok(routes.env![env], 'pi-ai: "No API key for provider" without it')
  assert.equal(storedConnection(home, 'llamacpp')!.apiKey, undefined, 'probes send no placeholder key')
  saveProvider(home, { name: 'other', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'x' }] })
  removeProvider(home, 'other')
  assert.ok(loadModelRoutes(home).env![KEYLESS_ENV], 'removing one keyless provider keeps the shared placeholder')
})

test('health goes red on real problems, and red blocks starting work unless forced', async () => {
  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const notGit = tempDir('sa-plain-')
    await runtime.addProject({ name: 'plain', root: notGit, defaultGates: [NODE_TEST_GATE] })
    await runtime.addProject({ name: 'ok', root: gitRepo({ 'a.txt': 'x' }), defaultGates: [NODE_TEST_GATE] })
    const h = (await call(server.url, 'GET', '/api/system/health')).json
    assert.equal(h.overall, 'red')
    assert.equal(h.checks.find((c: any) => c.id === 'project.plain.git').status, 'fail')
    const goal = runtime.chief.createGoal('plain', 'x')
    runtime.chief.addTask('plain', goal.id, { title: 't', instructions: 'i' })
    const refused = await call(server.url, 'POST', `/api/projects/plain/goals/${goal.id}/run`, {}, 'h')
    assert.equal(refused.status, 412)
    assert.match(refused.json.error, /not a git repository/)
    assert.equal(refused.json.checks[0].id, 'project.plain.git')
    assert.equal((await call(server.url, 'POST', `/api/projects/plain/goals/${goal.id}/run`, { force: true }, 'h')).status, 200, 'force overrides')
    // A DSH-backed runtime without the Worker profile is red (Workers would run unguarded).
    const dshRuntime = createRuntime({ home: tempDir('sa-home-') })
    const s2 = await startServer({ runtime: dshRuntime, port: 0 })
    try {
      const h2 = (await call(s2.url, 'GET', '/api/system/health')).json
      assert.equal(h2.checks.find((c: any) => c.id === 'dsh.worker-profile').status, 'fail')
      assert.equal(h2.checks.find((c: any) => c.id === 'dsh.chief-profile').status, 'warn')
    } finally {
      await s2.close()
    }
  } finally {
    await server.close()
  }
})
