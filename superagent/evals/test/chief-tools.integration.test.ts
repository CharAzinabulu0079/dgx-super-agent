/**
 * Chief ↔ API: a DSH session with the SuperAgent bundle creates a goal and a task,
 * starts the loop and reads the progress report — all through `superagent_*` tools
 * against a live API server. Human Gates are not resolvable from tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { createRuntime, setupDshProfiles, startServer, WORKER_PROFILE } from '@superagent/server'
import { calcProject, runDsh, startMockLlm, tempDir, text, toolCall, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'

test('Chief DSH session drives goal → task → run → status through superagent_* tools', { timeout: 300_000 }, async () => {
  const root = calcProject()
  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(input => { writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC) }) })
  await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const server = await startServer({ runtime, port: 0 })
  const dshHome = join(home, 'chief-dsh-home')
  setupDshProfiles(dshHome, { chief: false }) // headless profile carrying the same bundle tools
  let goalId = ''
  const mock = await startMockLlm(req => {
    if (!req.tools?.length) return text('Chief')
    const history = JSON.stringify(req.messages)
    const step = req.messages.filter(m => m.role === 'assistant').length
    goalId = history.match(/goalId\\+":\\+"(goal_[a-z0-9]+)/)?.[1] ?? goalId
    switch (step) {
      case 0: return toolCall('superagent_create_goal', { project: 'calc', objective: 'make add() correct' })
      case 1: return toolCall('superagent_add_task', { project: 'calc', goal: goalId, title: 'fix add', instructions: 'fix src/calc.js', worker_model: 'anthropic/claude-opus-5-5' })
      case 2: return toolCall('superagent_run_goal', { project: 'calc', goal: goalId })
      default: return text('Started; I will report when the verifier decides.')
    }
  })
  try {
    const run = await runDsh({
      args: ['--profile', WORKER_PROFILE, 'Please fix add() in the calc project'], cwd: root, timeoutMs: 180_000,
      env: { DSH_HOME: dshHome, DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'mock-key', SUPERAGENT_API_URL: server.url },
    })
    assert.equal(run.exitCode, 0, run.stderr.slice(-800))
    assert.match(goalId, /^goal_/)
    for (let i = 0; i < 100 && runtime.store.getGoal('calc', goalId)?.status !== 'complete'; i++) await sleep(100)
    const task = runtime.store.listTasks('calc', goalId)[0]!
    assert.equal(task.state, 'passed')
    assert.deepEqual(task.policy.model.worker, { provider: 'anthropic', model: 'claude-opus-5-5' })

    // A second Chief turn reads the report through superagent_status.
    const mock2 = await startMockLlm(req => {
      if (!req.tools?.length) return text('Chief')
      return req.messages.some(m => m.role === 'assistant') ? text('reported') : toolCall('superagent_status', { project: 'calc' })
    })
    const status = await runDsh({ args: ['--profile', WORKER_PROFILE, '--json', 'report progress'], cwd: root, timeoutMs: 120_000, env: { DSH_HOME: dshHome, DEEPSEEK_BASE_URL: mock2.baseUrl, DEEPSEEK_API_KEY: 'k', SUPERAGENT_API_URL: server.url } })
    await mock2.close()
    assert.match(status.stdout, /\[passed\] fix add/)
    const toolNames = (mock2.requests.find(r => r.tools?.length)?.tools ?? []).map(t => t.name)
    assert.ok(!toolNames.some(n => /human|decide|approve/.test(n)), `no model tool may resolve Human Gates: ${toolNames.join(',')}`)
  } finally {
    await mock.close()
    await server.close()
  }
})
