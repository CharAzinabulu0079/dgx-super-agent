import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '@superagent/testkit'
import { modelPatch, resolveRoute } from '@superagent/chief-worker'
import { DEFAULT_POLICY, LOCAL_DEFAULT, modelForStrategy, parseModelSpec, resolveTaskPolicy } from '../src/index.ts'

test('model specs parse transparently', () => {
  assert.deepEqual(parseModelSpec('anthropic/claude-opus-5-5'), { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(parseModelSpec('local-default'), LOCAL_DEFAULT)
  assert.deepEqual(parseModelSpec('openai-compat/qwen/qwen3-72b'), { provider: 'openai-compat', model: 'qwen/qwen3-72b' })
  assert.equal(parseModelSpec('nonsense'), undefined)
})

test('policy layering: defaults → project policy.json → task override; escalation only via strategy', () => {
  const root = tempDir()
  assert.deepEqual(resolveTaskPolicy(root), DEFAULT_POLICY)
  mkdirSync(join(root, '.superagent'))
  writeFileSync(join(root, '.superagent/policy.json'), JSON.stringify({ model: { reviewer: { provider: 'anthropic', model: 'claude-opus-5-5' } }, maxAttempts: 4 }))
  const p = resolveTaskPolicy(root, { model: { worker: { provider: 'local', model: 'qwen' }, escalation: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
  assert.equal(p.maxAttempts, 4)
  assert.deepEqual(p.model.reviewer, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(modelForStrategy(p, 'retry-with-feedback'), { provider: 'local', model: 'qwen' })
  assert.deepEqual(modelForStrategy(p, 'escalate-model'), { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(p.production_write, false)
  assert.throws(() => resolveTaskPolicy(root, { strategies: ['yolo'] }), /policy.strategies/)
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
  assert.equal(rows[1].config.providers['dgx-local'].baseURL, 'http://127.0.0.1:8000/v1')
  assert.equal(modelPatch(LOCAL_DEFAULT, {}), undefined)
})
