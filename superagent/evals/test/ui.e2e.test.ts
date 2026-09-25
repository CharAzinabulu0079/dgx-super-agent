/**
 * SuperAgent Web/PWA in a real browser against a live API server (scripted Workers).
 * Covers Freeze §15 UI gates: project list, Goal status, Worker/Loop status,
 * Architecture view with clickable nodes; plus task model selection and Human Gate approval.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { createRuntime, startServer } from '@superagent/server'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE, REPO_ROOT } from '@superagent/testkit'

const UI_DIR = join(REPO_ROOT, 'superagent/ui/dist')

test('UI: projects, goal, tasks with model selection, live loop, human gate, architecture inspector', { timeout: 180_000 }, async () => {
  if (!existsSync(join(UI_DIR, 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: join(REPO_ROOT, 'superagent/ui'), stdio: 'pipe' })
  const root = calcProject()
  const runtime = createRuntime({
    home: tempDir('sa-home-'),
    executor: new ScriptedExecutor(async input => {
      await new Promise(r => setTimeout(r, 400)) // visible "executing" state
      if (input.task.title === 'ask human') {
        if (input.attempt === 1) {
          input.report({ kind: 'blocker', current_state: 'needs decision', progress: 20, changed_modules: [], verification_result: 'not_run', blocker: 'Accept strings in add()?', next_action: null, human_required: true, summary: '' })
          return
        }
      }
      if (input.attempt >= 2 || input.task.title === 'ask human') writeFileSync(join(root, 'src/calc.js'), FIXED_CALC)
      input.report({ kind: 'result', current_state: 'done', progress: 100, changed_modules: [], verification_result: 'claimed_pass', blocker: null, next_action: null, human_required: false, summary: '' })
    }),
  })
  const server = await startServer({ runtime, port: 0, uiDir: UI_DIR })
  const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) })
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', e => consoleErrors.push(String(e)))
  try {
    await page.goto(server.url)
    // Add the project through the UI.
    await page.getByTestId('new-project-name').fill('Calc')
    await page.getByTestId('new-project-root').fill(root)
    await page.getByTestId('add-project').click()
    await page.getByTestId('project-calc').click()
    await page.getByTestId('project-title').filter({ hasText: 'Calc' }).waitFor()

    // Goal + task with an explicit Worker model.
    await page.getByTestId('new-goal').fill('make add() correct')
    await page.getByTestId('create-goal').click()
    await page.getByTestId('goal-status').filter({ hasText: 'active' }).waitFor()
    await page.getByTestId('new-task-title').fill('fix add')
    await page.getByTestId('new-task-instructions').fill('fix src/calc.js')
    await page.getByTestId('new-task-model').fill('anthropic/claude-opus-5-5')
    await page.getByTestId('add-task').click()
    const row = page.locator('[data-testid^="task-task_"]').first()
    await row.getByText('anthropic/claude-opus-5-5').waitFor()

    // Default gate for the project (API) then run the loop from the UI.
    runtime.store.updateProject('calc', { defaultGates: [NODE_TEST_GATE] })
    await page.getByTestId('run-goal').click()
    await row.getByTestId('task-state').filter({ hasText: 'passed' }).waitFor({ timeout: 60_000 })
    await row.getByTestId('task-verdict').filter({ hasText: 'PASS' }).waitFor()
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor()
    assert.match(await page.getByTestId('chief-report').textContent() ?? '', /\[passed\] fix add — attempts 2\/6, worker anthropic\/claude-opus-5-5/)

    // Workers tab shows loop history.
    await page.getByTestId('tab-workers').click()
    const workersText = await page.getByTestId('workers').textContent()
    assert.match(workersText ?? '', /claude-opus-5-5/)
    assert.match(workersText ?? '', /claim claimed_pass/)

    // Human Gate: approve from the UI, loop continues to PASS.
    await page.getByTestId('tab-overview').click()
    await page.getByTestId('new-goal').fill('decide string support')
    await page.getByTestId('create-goal').click()
    await page.getByTestId('goal-status').filter({ hasText: 'active' }).waitFor()
    await page.getByTestId('new-task-title').fill('ask human')
    await page.getByTestId('add-task').click()
    await page.locator('[data-testid^="task-task_"]').first().waitFor()
    await page.getByTestId('run-goal').click()
    const gate = page.locator('[data-testid^="gate-hg_"]').first()
    await gate.getByText('Accept strings in add()?').waitFor({ timeout: 30_000 })
    await gate.getByTestId('gate-note').fill('numbers only')
    await gate.getByTestId('approve').click()
    await page.getByTestId('run-goal').click()
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor({ timeout: 60_000 })

    // Architecture view: nodes render with status; clicking opens the inspector.
    await page.getByTestId('tab-architecture').click()
    await page.getByTestId('architecture-view').waitFor()
    const node = page.locator('[data-testid^="arch-node-"]').first()
    await node.waitFor()
    await node.click()
    const inspector = page.getByTestId('node-inspector')
    await inspector.waitFor()
    assert.match(await inspector.textContent() ?? '', /Location.*Depends on.*Used by.*Tests/s)
    assert.deepEqual(consoleErrors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})
