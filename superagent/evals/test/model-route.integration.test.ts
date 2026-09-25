/**
 * DGX model path (Freeze §0.1-9, §11): the logical `local-default` model is mapped by
 * `model-routes.json` onto a custom `llm-pi-ai` route (here Anthropic-compatible, on DGX an
 * OpenAI-compatible local server) and reaches the wire with the configured model id.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, DshHeadlessExecutor, LoopEngine, REPORT_FENCE } from '@superagent/chief-worker'
import { gitRepo, startMockLlm, tempDir, text } from '@superagent/testkit'

test('local-default → model-routes.json → llm-pi-ai custom route → wire', { timeout: 180_000 }, async () => {
  const mock = await startMockLlm(req => text(req.tools?.length
    ? `ok\n\`\`\`${REPORT_FENCE}\n{"kind":"result","current_state":"done","progress":100,"verification_result":"claimed_pass","summary":"routed"}\n\`\`\``
    : 'title'))
  try {
    const home = tempDir('sa-home-')
    writeFileSync(join(home, 'model-routes.json'), JSON.stringify({
      aliases: { 'local-default': { provider: 'dgx-local', model: 'qwen-local-test' } },
      piAiProviders: { 'dgx-local': { api: 'anthropic-messages', baseURL: mock.baseUrl.replace(/\/v1$/, ''), apiKeyEnv: 'DGX_LLM_KEY', models: [{ id: 'qwen-local-test', contextWindow: 131072 }] } },
      env: { DGX_LLM_KEY: 'local-key' },
    }))
    const store = new StateStore(home)
    const engine = new LoopEngine({ store, verifier: new Verifier(), executor: new DshHeadlessExecutor({ profile: 'headless', timeoutMs: 120_000 }) })
    const root = gitRepo({ 'README.md': 'x\n' })
    const project = store.createProject({ name: 'route', root, defaultGates: [{ id: 'noop', kind: 'command', command: 'true', required: true }] })
    const chief = new Chief(engine)
    const goal = chief.createGoal(project.id, 'route check')
    chief.addTask(project.id, goal.id, { title: 'say ok', instructions: 'reply' })
    const r = await chief.runGoal(project.id, goal.id)
    assert.equal(r.tasks[0]!.state, 'passed', chief.statusReport(project.id))
    const models = mock.requests.filter(q => q.tools?.length).map(q => q.model)
    assert.ok(models.length >= 1)
    assert.ok(models.every(m => m === 'qwen-local-test'), JSON.stringify(models))
    const receipt = store.listReceipts(project.id)[0]!
    assert.deepEqual(receipt.model, { provider: 'local-default', model: 'default' })
  } finally {
    await mock.close()
  }
})
