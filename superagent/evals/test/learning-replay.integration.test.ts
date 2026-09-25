/**
 * Directive §4.D end to end with real DSH sessions:
 * trace → DSH LLM reflection proposes a skill → fresh replay in a reconstructed worktree,
 * baseline arm vs candidate arm with fresh DSH Workers → compare → promote.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshHeadlessExecutor, REPORT_FENCE, ScriptedExecutor } from '@superagent/chief-worker'
import { createRuntime } from '@superagent/server'
import { DshReflector, llmExtractor, CANDIDATES_FENCE, LearningService } from '@superagent/learning'
import { calcProject, startMockLlm, tempDir, text, toolCall, BUGGY_CALC, FIXED_CALC, NODE_TEST_GATE } from '@superagent/testkit'

test('DSH reflection proposes a skill; fresh DSH replay proves it helps; it is promoted', { timeout: 600_000 }, async () => {
  const root = calcProject()
  const home = tempDir('sa-home-')
  const rt = createRuntime({ home, executor: new ScriptedExecutor(i => { if (i.attempt >= 2) writeFileSync(join(root, 'src/calc.js'), FIXED_CALC) }) })
  const project = await rt.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = rt.chief.createGoal(project.id, 'fix add')
  const task = rt.chief.addTask(project.id, goal.id, { title: 'fix add', instructions: 'Make the unit tests pass.' })
  await rt.chief.runGoal(project.id, goal.id)

  const replayRoots = new Set<string>()
  const mock = await startMockLlm(req => {
    if (!req.tools?.length) return text('t')
    const all = JSON.stringify(req.messages)
    if (all.includes('SuperAgent reflection step')) {
      assert.match(all, /Attempt 1/)
      return text(`Reflection.\n\`\`\`${CANDIDATES_FENCE}\n${JSON.stringify([
        { kind: 'skill', name: 'calc-add-operator', description: 'Fix add() operator', body: 'KNOWN FIX: in src/calc.js add() must use a + b, not a - b.', rationale: 'attempt 1 failed on add(2,3)' },
        { kind: 'memory', name: 'calc-lesson', description: 'lesson', body: 'add() regressions come from operator typos' },
      ])}\n\`\`\``)
    }
    // Replay Worker (fresh context in a reconstructed worktree).
    const promptIndex = req.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SuperAgent Worker'))
    const prompt = JSON.stringify(req.messages[promptIndex]?.content ?? '')
    const workdir = /Work only inside ([^ .]+)\./.exec(prompt)?.[1] ?? ''
    replayRoots.add(workdir)
    const step = req.messages.slice(promptIndex + 1).filter(m => m.role === 'assistant').length
    const knows = prompt.includes('KNOWN FIX')
    if (knows && step === 0) return toolCall('read', { file_path: join(workdir, 'src/calc.js') })
    if (knows && step === 1) return toolCall('write', { file_path: join(workdir, 'src/calc.js'), content: FIXED_CALC })
    return text(`done\n\`\`\`${REPORT_FENCE}\n{"kind":"result","current_state":"done","progress":100,"verification_result":"claimed_pass","summary":"${knows ? 'applied known fix' : 'guessing'}"}\n\`\`\``)
  })
  try {
    const env = { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'k' }
    const learning = new LearningService(rt.store, rt.verifier, {
      extractors: [llmExtractor(new DshReflector({ stateHome: home, env }))],
      replay: { executorFactory: () => new DshHeadlessExecutor({ profile: 'headless', env, timeoutMs: 120_000 }), maxAttempts: 2 },
    })
    const proposed = await learning.reflect(project.id, task.id)
    assert.deepEqual(proposed.map(c => `${c.kind}:${c.source}`).sort(), ['memory:llm-reflection', 'skill:llm-reflection'])
    const skill = proposed.find(c => c.kind === 'skill')!
    const result = await learning.evaluate(skill.id)
    assert.equal(result.status, 'promoted', result.decision)
    assert.deepEqual(result.evals[0]!.arms.map(a => `${a.arm}:${a.passed}`), ['baseline:false', 'candidate:true'])
    assert.ok(replayRoots.size >= 2 && ![...replayRoots].includes(root), 'replay Workers ran in fresh worktrees, not the user tree')
    assert.equal(readFileSync(join(root, 'src/calc.js'), 'utf8'), FIXED_CALC)
    assert.notEqual(BUGGY_CALC, FIXED_CALC)
    const memory = proposed.find(c => c.kind === 'memory')!
    await assert.rejects(learning.evaluate(memory.id), /human approval/)
  } finally {
    await mock.close()
  }
})
