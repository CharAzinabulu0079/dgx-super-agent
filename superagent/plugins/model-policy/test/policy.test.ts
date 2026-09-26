import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'
import { Chief, LoopEngine, ScriptedExecutor, modelPatch, resolveRoute } from '@superagent/chief-worker'
import { LOCAL_DEFAULT, livePolicy, loadGlobalPolicy, modelForStrategy, parseModelSpec, parsePolicyLayer, resolveTaskPolicy, roleModel, saveGlobalPolicy } from '../src/index.ts'

const cheap = { provider: 'openai-compat', model: 'qwen-cheap' }
const opus = { provider: 'anthropic', model: 'claude-opus-5-5' }

test('model specs parse transparently', () => {
  assert.deepEqual(parseModelSpec('anthropic/claude-opus-5-5'), opus)
  assert.deepEqual(parseModelSpec('local-default'), LOCAL_DEFAULT)
  assert.deepEqual(parseModelSpec('openai-compat/qwen/qwen3-72b'), { provider: 'openai-compat', model: 'qwen/qwen3-72b' })
  assert.equal(parseModelSpec('nonsense'), undefined)
})

test('layers: defaults ← global ← project ← task pin; validation rejects bad input', () => {
  const home = tempDir()
  assert.deepEqual(loadGlobalPolicy(home), {})
  saveGlobalPolicy(home, parsePolicyLayer({ models: { worker: 'openai-compat/qwen-cheap', chief: 'anthropic/claude-opus-5-5' }, maxAttempts: 4 }))
  const global = loadGlobalPolicy(home)
  const project = parsePolicyLayer({ models: { reviewer: opus } })
  const { policy, pinned } = resolveTaskPolicy({ global, project }, { model: { escalation: opus } })
  assert.deepEqual(policy.model.worker, cheap)
  assert.deepEqual(policy.model.reviewer, opus)
  assert.equal(policy.maxAttempts, 4)
  assert.deepEqual(pinned, { escalation: opus })
  assert.deepEqual(modelForStrategy(policy, 'escalate-model'), opus)
  assert.throws(() => parsePolicyLayer({ models: { janitor: 'a/b' } }), /unknown role/)
  assert.throws(() => parsePolicyLayer({ models: { worker: 'nope' } }), /provider\/model/)
  assert.throws(() => parsePolicyLayer({ maxAttempts: 1000 }), /1\.\.50/)
  assert.deepEqual(roleModel(home, undefined, 'chief'), opus)
  assert.deepEqual(roleModel(home, undefined, 'reviewer'), cheap, 'unset roles fall back to the Worker default')
})

test('switching the global Worker default applies to queued un-pinned tasks immediately; pinned tasks keep their model', async () => {
  const root = calcProject()
  const store = new StateStore(tempDir('sa-home-'))
  const seen: string[] = []
  const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new ScriptedExecutor(i => { seen.push(`${i.task.title}=${i.model.provider}/${i.model.model}`); writeFileSync(join(root, 'src/calc.js'), FIXED_CALC) }) })
  const chief = new Chief(engine)
  const p = store.createProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = chief.createGoal(p.id, 'g')
  const free = chief.addTask(p.id, goal.id, { title: 'free', instructions: '' })
  const pinnedTask = chief.addTask(p.id, goal.id, { title: 'pinned', instructions: '', policy: { model: { worker: opus } } })
  assert.deepEqual(free.policy.model.worker, LOCAL_DEFAULT)
  // The human switches every Worker to a cheap API model — no model call, just config.
  saveGlobalPolicy(store.home, { models: { worker: cheap } })
  assert.deepEqual(livePolicy(store.home, p, free).model.worker, cheap)
  await chief.runGoal(p.id, goal.id)
  assert.deepEqual(seen, ['free=openai-compat/qwen-cheap', 'pinned=anthropic/claude-opus-5-5'])
  assert.deepEqual(store.listReceipts(p.id, free.id)[0]!.model, cheap)
  // A project override beats the global default.
  store.updateProject(p.id, { policy: { models: { worker: { provider: 'local-default', model: 'default' } } } })
  assert.deepEqual(livePolicy(store.home, store.requireProject(p.id), free).model.worker, LOCAL_DEFAULT)
  void pinnedTask
})

test('model routes map logical models onto DSH configuration (no automatic routing)', () => {
  const routes = {
    aliases: { 'local-default': { provider: 'dgx-local', model: 'qwen3-72b-instruct' } },
    piAiProviders: { 'dgx-local': { api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'DGX_LLM_KEY' } },
  }
  assert.deepEqual(resolveRoute(LOCAL_DEFAULT, routes), { provider: 'dgx-local', model: 'qwen3-72b-instruct' })
  assert.equal(resolveRoute(LOCAL_DEFAULT, {}), undefined)
  const rows = JSON.parse(modelPatch(LOCAL_DEFAULT, routes)!)
  assert.deepEqual(rows.map((r: { id: string }) => r.id), ['agent-default-model', 'llm-pi-ai'])
  assert.equal(modelPatch(LOCAL_DEFAULT, {}), undefined)
})

test('safe mode (autonomy): validated, project overrides global, default normal', async () => {
  const { autonomyFor, parsePolicyLayer, saveGlobalPolicy } = await import('../src/index.ts')
  const { tempDir } = await import('@superagent/testkit')
  assert.equal(parsePolicyLayer({ autonomy: 'high' }).autonomy, 'high')
  assert.throws(() => parsePolicyLayer({ autonomy: 'yolo' }), /autonomy/)
  assert.equal(parsePolicyLayer({ autonomy: null }).autonomy, undefined)
  const home = tempDir('sa-home-')
  assert.equal(autonomyFor(home), 'normal')
  saveGlobalPolicy(home, { autonomy: 'read-only' })
  assert.equal(autonomyFor(home), 'read-only')
  assert.equal(autonomyFor(home, { policy: { autonomy: 'high' } } as never), 'high')
})
