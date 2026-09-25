/**
 * Freeze §8 / §15 Browser: real-browser E2E results enter the Verifier.
 * A bugged sample app fails the Playwright gate (Worker claim overruled);
 * the Worker fixes it and the same gate passes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, LoopEngine, ScriptedExecutor } from '@superagent/chief-worker'
import { sampleWebappRepo, tempDir, E2E_GATE } from '@superagent/testkit'

const BUG = "count.textContent = `${left} items left`"
const FIX = "count.textContent = `${left} item${left === 1 ? '' : 's'} left`"

test('E2E gate: pluralization bug fails in a real browser, fix passes', { timeout: 240_000 }, async () => {
  const root = sampleWebappRepo(dir => {
    const app = join(dir, 'public/app.js')
    writeFileSync(app, readFileSync(app, 'utf8').replace(FIX, BUG))
    // Add a spec that catches the bug.
    writeFileSync(join(dir, 'e2e/singular.spec.js'), `import { test, expect } from '@playwright/test'\ntest('singular item', async ({ page }) => {\n  await page.goto('/')\n  await page.getByLabel('new todo').fill('one')\n  await page.keyboard.press('Enter')\n  await expect(page.locator('#count')).toHaveText('1 item left', { timeout: 2000 })\n})\n`)
  })
  const store = new StateStore(tempDir('sa-home-'))
  const engine = new LoopEngine({
    store, verifier: new Verifier(),
    executor: new ScriptedExecutor(input => {
      if (input.attempt === 2) {
        const failure = input.feedback[0]!.failingGates[0]!
        assert.equal(failure.gateId, 'e2e')
        assert.match(failure.summary, /E2E \d+ passed, 1 failed/)
        const app = join(root, 'public/app.js')
        writeFileSync(app, readFileSync(app, 'utf8').replace(BUG, FIX))
      }
      input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: '' })
    }),
  })
  const project = store.createProject({ name: 'webapp', root, defaultGates: [{ ...E2E_GATE, command: 'SAMPLE_PORT=4391 npx playwright test --reporter=json' }] })
  const chief = new Chief(engine)
  const goal = chief.createGoal(project.id, 'fix the item counter')
  chief.addTask(project.id, goal.id, { title: 'fix pluralization', instructions: 'The counter says "1 items left".' })
  const result = await chief.runGoal(project.id, goal.id)
  assert.equal(result.tasks[0]!.state, 'passed', chief.statusReport(project.id))
  const receipts = store.listReceipts(project.id).sort((a, b) => a.attempt - b.attempt)
  assert.deepEqual(receipts.map(r => r.verdict), ['FAIL', 'PASS'])
  assert.equal(receipts[0]!.claimOverruled, true)
  const e2eFail = receipts[0]!.gateResults[0]!
  assert.equal(e2eFail.kind, 'e2e')
  assert.deepEqual((e2eFail.details as { failures: string[] }).failures.length, 1)
  assert.match((e2eFail.details as { failures: string[] }).failures[0]!, /singular item/)
  assert.match(receipts[1]!.gateResults[0]!.summary, /E2E 3 passed, 0 failed/)
})
