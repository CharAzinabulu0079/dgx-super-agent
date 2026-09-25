/**
 * Directive §4.C end to end: Worker loop events → durable wakes → the server's Chief driver
 * delivers one coalesced digest into a persistent Chief DSH session, which uses its
 * superagent_* tools; the next wake resumes the same session. Routine progress never wakes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { createRuntime, setupDshProfiles, startServer } from '@superagent/server'
import { calcProject, startMockLlm, tempDir, text, toolCall, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'

test('Chief auto-wakes in a persistent DSH session from Worker events', { timeout: 400_000 }, async () => {
  const root = calcProject()
  const home = tempDir('sa-home-')
  setupDshProfiles(join(home, 'dsh-home'))
  const chiefPrompts: string[] = []
  const mock = await startMockLlm(req => {
    if (!req.tools?.length) return text('Chief')
    const last = JSON.stringify(req.messages.at(-1)?.content ?? '')
    if (last.includes('SuperAgent Chief wake')) {
      chiefPrompts.push(last)
      assert.ok(req.tools.some(t => t.name === 'superagent_status'))
      assert.ok(!req.tools.some(t => t.name === 'superagent_report'), 'Chief does not get Worker tools')
      return toolCall('superagent_status', { project: 'calc' })
    }
    return text('Noted. The human must decide the open gate; otherwise the goal is complete.')
  })
  const runtime = createRuntime({
    home,
    executor: new ScriptedExecutor(i => {
      for (let k = 0; k < 10; k++) i.report({ kind: 'progress', current_state: `step ${k}`, progress: k * 10, changed_modules: [], verification_result: 'not_run', blocker: null, next_action: null, human_required: false, summary: '' })
      if (i.attempt >= 3) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
    }),
  })
  const server = await startServer({ runtime, port: 0, chiefWake: { intervalMs: 200, minIntervalMs: 0, env: { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'k' } } })
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    const goal = runtime.chief.createGoal('calc', 'fix add')
    runtime.chief.addTask('calc', goal.id, { title: 'fix add', instructions: '...', policy: { maxSameFailure: 2 } })
    await runtime.chief.runGoal('calc', goal.id)

    const waitFor = async (pred: () => boolean, ms = 120_000) => {
      const end = Date.now() + ms
      while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await sleep(200) }
    }
    // Wakes arrive in real time: the strategy switch mid-run, then the final review.
    await waitFor(() => chiefPrompts.join('\n').includes('final-review'))
    await waitFor(() => runtime.store.listRecords<{ status: string }>('calc', 'wakes').every(w => w.status === 'delivered'))
    const all = chiefPrompts.join('\n')
    assert.match(all, /repeated-failure/)
    assert.doesNotMatch(all, /step 7/, 'routine progress is never in a digest')
    const deliveredBefore = chiefPrompts.length
    assert.ok(deliveredBefore <= 3, `wakes are sparse: ${deliveredBefore} Chief turns for a 3-attempt loop with 30 progress reports`)
    const session1 = runtime.store.getMeta<{ sessionId: string }>('calc', 'chief-session')!.sessionId

    // A later exceptional event wakes the same session (resumed, not a new one).
    runtime.store.emitTyped('architecture/drift', 'calc', { errors: 1 })
    await waitFor(() => chiefPrompts.length > deliveredBefore)
    await waitFor(() => runtime.store.listRecords<{ status: string }>('calc', 'wakes').every(w => w.status === 'delivered'))
    const session2 = runtime.store.getMeta<{ sessionId: string }>('calc', 'chief-session')!.sessionId
    assert.equal(session2, session1)
    const status = await (await fetch(`${server.url}/api/projects/calc/chief`)).json()
    assert.equal(status.enabled, true)
    assert.equal(status.pending, 0)
    // The resumed session carried the earlier turn: its request history contains the first digest.
    const resumed = mock.requests.filter(r => r.tools?.length && JSON.stringify(r.messages).includes('architecture-drift'))
    assert.ok(resumed.some(r => JSON.stringify(r.messages).includes('final-review')))
  } finally {
    await server.close()
    await mock.close()
  }
})
