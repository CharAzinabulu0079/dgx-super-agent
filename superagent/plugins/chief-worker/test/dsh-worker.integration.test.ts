/**
 * Real DSH runtime as the Worker (keyless: scripted mock model).
 * Attempt 1 writes a wrong fix and claims PASS → verifier FAIL (claim overruled).
 * Attempt 2 continues the same DSH Session with verifier feedback → correct fix → PASS.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { calcProject, startMockLlm, tempDir, text, toolCall, NODE_TEST_GATE, FIXED_CALC} from '@superagent/testkit'
import { Chief, DshHeadlessExecutor, LoopEngine, REPORT_FENCE } from '../src/index.ts'

const report = (claim: string, summary: string): string =>
  `Done.\n\`\`\`${REPORT_FENCE}\n${JSON.stringify({ kind: 'result', current_state: 'done', progress: 100, changed_modules: ['calc'], verification_result: claim, blocker: null, next_action: null, human_required: false, summary })}\n\`\`\``

test('DSH Worker: fail → resume session with feedback → PASS; model policy reaches the wire', { timeout: 300_000 }, async () => {
  const root = calcProject()
  const mock = await startMockLlm(req => {
    if (!req.tools?.length) return text('Fix calc')
    // Steps since the latest Worker prompt: read → write → final report.
    const promptIndex = req.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SuperAgent Worker'))
    const prompt = JSON.stringify(req.messages[promptIndex]?.content ?? '')
    const step = req.messages.slice(promptIndex + 1).filter(m => m.role === 'assistant').length
    const attempt2 = prompt.includes('Attempt 2 (strategy')
    if (attempt2) {
      assert.match(prompt, /Previous attempts/)
      assert.match(prompt, /the gates disagreed/)
    }
    if (step === 0) return toolCall('read', { file_path: join(root, 'src/calc.js') })
    if (step === 1) return toolCall('write', { file_path: join(root, 'src/calc.js'), content: attempt2 ? FIXED_CALC : 'export function add(a, b) { return a * b }\n' })
    return text(report('claimed_pass', attempt2 ? 'fixed add properly' : 'fixed add'))
  })
  try {
    const home = tempDir('sa-home-')
    const store = new StateStore(home)
    const engine = new LoopEngine({
      store, verifier: new Verifier(),
      executor: new DshHeadlessExecutor({ env: { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'mock-key' }, timeoutMs: 120_000 }),
    })
    const chief = new Chief(engine)
    const project = store.createProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    const goal = chief.createGoal(project.id, 'fix add')
    chief.addTask(project.id, goal.id, {
      title: 'fix add', instructions: 'src/calc.js add() is wrong; make test/calc.test.js pass.',
      policy: { model: { worker: { provider: 'deepseek-official', model: 'deepseek-pro' } } },
    })
    const result = await chief.runGoal(project.id, goal.id)
    const task = result.tasks[0]!
    assert.equal(task.state, 'passed', chief.statusReport(project.id))
    assert.equal(task.attempts.length, 2)
    const receipts = store.listReceipts(project.id, task.id).sort((a, b) => a.attempt - b.attempt)
    assert.deepEqual(receipts.map(r => r.verdict), ['FAIL', 'PASS'])
    assert.equal(receipts[0]!.claimOverruled, true)
    assert.deepEqual(receipts[1]!.model, { provider: 'deepseek-official', model: 'deepseek-pro' })
    // Model policy reached DSH: every tool-bearing request used the selected model.
    const modelRequests = mock.requests.filter(r => r.tools?.length)
    assert.ok(modelRequests.length >= 4)
    assert.ok(modelRequests.every(r => r.model === 'deepseek-pro'), JSON.stringify(modelRequests.map(r => r.model)))
    // retry-with-feedback resumed the same DSH Session.
    const workers = store.listWorkers(project.id).sort((a, b) => a.attempt - b.attempt)
    assert.ok(workers[0]!.sessionId)
    assert.equal(workers[1]!.sessionId, workers[0]!.sessionId)
    // Live progress reports came from DSH tool calls; result report parsed from the final message.
    const reports = store.readReports(project.id, workers[1]!.id)
    assert.ok(reports.some(r => r.kind === 'progress' && r.current_state.startsWith('write')))
    assert.equal(reports.at(-1)!.summary, 'fixed add properly')
  } finally {
    await mock.close()
  }
})
