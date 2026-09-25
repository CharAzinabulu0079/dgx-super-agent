/**
 * Full stack, keyless: `setupDshProfiles` → DSH `superagent-worker` profile (SuperAgent bundle
 * + Playwright MCP) → Worker inspects the running app in a real browser, reports through the
 * `superagent_report` tool, fixes the bug → independent Playwright E2E gate → PASS.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, DshHeadlessExecutor, LoopEngine, REPORT_FENCE } from '@superagent/chief-worker'
import { setupDshProfiles, BROWSER_PATCH } from '@superagent/server'
import { sampleWebappRepo, startMockLlm, tempDir, text, toolCall, E2E_GATE } from '@superagent/testkit'

const BUG = "count.textContent = `${left} items left`"
const FIX = "count.textContent = `${left} item${left === 1 ? '' : 's'} left`"
const CHROMIUM = process.env.SUPERAGENT_CHROMIUM ?? '/opt/pw-browsers/chromium'

test('DSH Worker with Playwright MCP + superagent_report fixes a UI bug; E2E gate verifies', { timeout: 600_000 }, async () => {
  const root = sampleWebappRepo(dir => {
    const app = join(dir, 'public/app.js')
    writeFileSync(app, readFileSync(app, 'utf8').replace(FIX, BUG))
    writeFileSync(join(dir, 'e2e/singular.spec.js'), `import { test, expect } from '@playwright/test'\ntest('singular item', async ({ page }) => {\n  await page.goto('/')\n  await page.getByLabel('new todo').fill('one')\n  await page.keyboard.press('Enter')\n  await expect(page.locator('#count')).toHaveText('1 item left', { timeout: 2000 })\n})\n`)
  })
  const home = tempDir('sa-home-')
  const setup = setupDshProfiles(join(home, 'dsh-home'), { chief: false })
  assert.ok(setup.profiles['superagent-worker'])

  // The app under inspection, as a Worker would start it.
  const app = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '4392' }, stdio: 'ignore' })
  await sleep(500)
  const appUrl = 'http://127.0.0.1:4392/'
  const seen: string[] = []
  const mock = await startMockLlm(req => {
    if (!req.tools?.length) return text('Fix counter')
    const promptIndex = req.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('SuperAgent Worker'))
    const step = req.messages.slice(promptIndex + 1).filter(m => m.role === 'assistant').length
    const history = JSON.stringify(req.messages)
    switch (step) {
      case 0: return toolCall('superagent_report', { kind: 'progress', current_state: 'reproducing in browser', progress: 10, changed_modules: [], verification_result: 'not_run' })
      case 1: return toolCall('mcp__playwright-mcp__browser_navigate', { url: appUrl })
      case 2: return toolCall('mcp__playwright-mcp__browser_snapshot', {})
      case 3:
        seen.push(history.includes('Sample Todo') ? 'saw-app' : 'no-app')
        return toolCall('read', { file_path: join(root, 'public/app.js') })
      case 4: return toolCall('write', { file_path: join(root, 'public/app.js'), content: readFileSync(join(root, 'public/app.js'), 'utf8').replace(BUG, FIX) })
      default: return text(`Fixed.\n\`\`\`${REPORT_FENCE}\n${JSON.stringify({ kind: 'result', current_state: 'done', progress: 100, changed_modules: ['sample-webapp'], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: 'fixed pluralization' })}\n\`\`\``)
    }
  })
  try {
    const store = new StateStore(home)
    const engine = new LoopEngine({
      store, verifier: new Verifier(),
      executor: new DshHeadlessExecutor({ patches: [BROWSER_PATCH], env: { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'mock-key', SUPERAGENT_CHROMIUM: CHROMIUM }, timeoutMs: 240_000 }),
    })
    const project = store.createProject({ name: 'webapp', root, defaultGates: [{ ...E2E_GATE, command: 'SAMPLE_PORT=4393 npx playwright test --reporter=json' }] })
    const chief = new Chief(engine)
    const goal = chief.createGoal(project.id, 'fix the item counter')
    chief.addTask(project.id, goal.id, { title: 'fix pluralization', instructions: 'The counter says "1 items left". Reproduce in the browser, fix, run the E2E.' })
    const result = await chief.runGoal(project.id, goal.id)
    const task = result.tasks[0]!
    assert.equal(task.state, 'passed', chief.statusReport(project.id))
    assert.deepEqual(seen, ['saw-app'])
    const worker = store.listWorkers(project.id)[0]!
    const reports = store.readReports(project.id, worker.id)
    // Report written by the DSH bundle tool from inside the Worker process.
    assert.ok(reports.some(r => r.current_state === 'reproducing in browser' && r.model.provider === 'local-default'), JSON.stringify(reports.slice(0, 3)))
    assert.ok(reports.some(r => r.current_state.startsWith('mcp__playwright-mcp__browser_navigate')))
    const receipt = store.listReceipts(project.id)[0]!
    assert.equal(receipt.verdict, 'PASS')
    assert.equal(receipt.gateResults[0]!.kind, 'e2e')
    assert.deepEqual(receipt.changedFiles, ['public/app.js'])
  } finally {
    app.kill()
    await mock.close()
  }
})
