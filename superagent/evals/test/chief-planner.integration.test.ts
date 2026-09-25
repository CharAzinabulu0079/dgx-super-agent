/**
 * Cloud v1.0: Chief decomposition and Reviewer as real DSH sessions (scripted model).
 * The planner's answer becomes validated tasks on registry gates; its attempt to write a
 * file is denied by the read-only advisor guard; the reviewer sees the task diff and its
 * rejection feeds the next Worker attempt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor, buildWorkerPrompt } from '@superagent/chief-worker'
import { createRuntime, setupDshProfiles } from '@superagent/server'
import { calcProject, startMockLlm, tempDir, text, toolCall, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'

test('DSH planner + reviewer: validated plan, read-only sessions, review feedback loop', { timeout: 400_000 }, async () => {
  const root = calcProject()
  const home = tempDir('sa-home-')
  setupDshProfiles(join(home, 'dsh-home'))
  const seen = { plannerTools: [] as string[], deniedWrite: false, reviewDiffs: [] as string[] }
  let reviews = 0
  const mock = await startMockLlm(req => {
    const all = JSON.stringify(req.messages)
    const last = JSON.stringify(req.messages.at(-1)?.content ?? '')
    if (all.includes('SuperAgent Chief planning step')) {
      seen.plannerTools = (req.tools ?? []).map(t => t.name)
      if (!last.includes('tool_result')) return toolCall('write', { file_path: join(root, 'PLANNER_WAS_HERE.md'), content: 'x' })
      seen.deniedWrite = /SuperAgent policy blocked this call/.test(last)
      return text('Plan:\n```superagent-plan\n' + JSON.stringify({ objective: 'Correct addition', tasks: [{ title: 'Fix add()', instructions: 'Make add(a, b) return the sum; keep the existing tests.', gates: ['unit'], review: true }] }) + '\n```')
    }
    if (all.includes('You are the SuperAgent Reviewer')) {
      seen.reviewDiffs.push(last)
      reviews++
      return text('```superagent-review\n' + JSON.stringify(reviews === 1 ? { approve: false, comments: 'Add a comment explaining add().' } : { approve: true, comments: 'ok' }) + '\n```')
    }
    return text('ok')
  })
  const prompts: string[] = []
  const runtime = createRuntime({
    home,
    advisorEnv: { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'k' },
    executor: new ScriptedExecutor(i => {
      prompts.push(buildWorkerPrompt(i, [NODE_TEST_GATE]))
      writeFileSync(join(i.project.root, 'src/calc.js'), i.attempt === 1 ? FIXED_CALC : `// add returns the sum of a and b\n${FIXED_CALC}`)
    }),
  })
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    const planned = await runtime.chief.planGoal('calc', 'the calculator adds wrong, fix it', { planner: runtime.planner })
    assert.equal(planned.plan.note, undefined, `planner fell back: ${planned.plan.note}`)
    assert.match(planned.plan.planner, /^dsh:/)
    assert.equal(planned.goal.objective, 'Correct addition')
    assert.deepEqual(planned.tasks.map(t => [t.title, t.gates.map(g => g.id).join(), t.review]), [['Fix add()', 'unit', true]])
    assert.ok(seen.plannerTools.includes('read'), 'planner can read')
    assert.ok(!seen.plannerTools.some(t => t.startsWith('superagent_')), 'planner has no SuperAgent tools')
    assert.ok(seen.deniedWrite, 'write denied by the advisor guard')
    assert.equal(existsSync(join(root, 'PLANNER_WAS_HERE.md')), false)

    const r = await runtime.chief.runGoal('calc', planned.goal.id)
    assert.equal(r.goal.status, 'complete')
    assert.equal(r.tasks[0]!.attempts.length, 2)
    assert.match(seen.reviewDiffs[0]!, /return a \+ b/, 'reviewer saw the diff')
    assert.match(prompts[1]!, /reviewer requested changes[\s\S]*Add a comment explaining add/)
  } finally {
    await mock.close()
  }
})
