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
import { ScriptedExecutor, ScriptedReviewer, parsePlan } from '@superagent/chief-worker'
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
          // What the DSH guard records when it blocks a call before execution.
          runtime.store.appendBlockedAction(input.project.id, input.worker.id, { fingerprint: 'fp-1', tool: 'bash', summary: 'bash: rm -rf data', category: 'irreversible-data', rule: 'recursive delete', at: new Date().toISOString() })
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
    await page.goto(`${server.url}/?token=${server.humanToken}`)
    // Add the project through the UI.
    // Project wizard (opens by itself when there is no project): folder → scan → create.
    await page.getByTestId('new-project-root').fill(root)
    await page.getByTestId('scan-project').click()
    await page.getByTestId('proposed-gates').waitFor()
    await page.getByTestId('new-project-name').fill('calc')
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
    await gate.getByTestId('gate-actions').getByText('bash: rm -rf data').waitFor({ timeout: 30_000 })
    await gate.getByTestId('gate-note').fill('numbers only')
    await gate.getByTestId('approve').click()
    await page.getByTestId('run-goal').click()
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor({ timeout: 60_000 })

    // Health panel is visible on the overview.
    assert.match(await page.getByTestId('health-chief').textContent() ?? '', /Chief wake: off/)
    assert.match(await page.getByTestId('health-arch').textContent() ?? '', /architecture: \d+ modules/)

    // Model policy: switch every Worker to a cheap model from the UI, no model call.
    await page.getByTestId('tab-policy').click()
    await page.getByTestId('policy-worker').fill('openai-compat/qwen-cheap')
    await page.getByTestId('policy-save').click()
    await page.getByTestId('effective-worker').filter({ hasText: 'openai-compat/qwen-cheap' }).waitFor()
    assert.deepEqual((await (await fetch(`${server.url}/api/policy`)).json()).global.models.worker, { provider: 'openai-compat', model: 'qwen-cheap' })

    // Learning: candidates from the task that passed after failing; memory needs a human.
    await page.getByTestId('tab-learning').click()
    const memory = page.locator('[data-testid^="candidate-lesson-"]').first()
    await memory.waitFor()
    await memory.getByTestId('candidate-approve').click()
    await memory.getByTestId('candidate-status').filter({ hasText: 'promoted' }).waitFor()

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

test('UI one-box: describe a change → planned, built, checked, narrated', { timeout: 180_000 }, async () => {
  if (!existsSync(join(UI_DIR, 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: join(REPO_ROOT, 'superagent/ui'), stdio: 'pipe' })
  const root = calcProject()
  const runtime = createRuntime({
    home: tempDir('sa-home-'),
    planner: { name: 'fake', plan: async i => parsePlan({ objective: 'Correct addition', tasks: [{ title: 'fix add()', instructions: i.request, review: true }] }, i.gates, 'fake') },
    reviewer: new ScriptedReviewer(() => ({ approve: true, comments: 'looks right' })),
    executor: new ScriptedExecutor(async input => {
      await new Promise(r => setTimeout(r, 300))
      writeFileSync(join(input.project.root, 'src/calc.js'), FIXED_CALC)
    }),
  })
  const server = await startServer({ runtime, port: 0, uiDir: UI_DIR })
  const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) })
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', e => consoleErrors.push(String(e)))
  try {
    await page.goto(`${server.url}/?token=${server.humanToken}`)
    // Project wizard (opens by itself when there is no project): folder → scan → create.
    await page.getByTestId('new-project-root').fill(root)
    await page.getByTestId('scan-project').click()
    await page.getByTestId('proposed-gates').waitFor()
    await page.getByTestId('new-project-name').fill('calc')
    await page.getByTestId('add-project').click()
    await page.getByTestId('project-calc').click()
    await page.getByTestId('ask').getByText('checks: unit, architecture').waitFor()
    await page.getByTestId('ask-input').fill('adding two numbers gives the wrong answer — fix it')
    await page.getByTestId('ask-review').check()
    await page.getByTestId('ask-submit').click()
    const activity = page.getByTestId('activity')
    await activity.getByText('Planned your request into 1 task: fix add()').waitFor({ timeout: 30_000 })
    await activity.getByText('the reviewer approved').waitFor({ timeout: 60_000 })
    await activity.getByText('Goal complete — every task passed its checks').waitFor({ timeout: 60_000 })
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor()
    assert.deepEqual(consoleErrors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})
