/**
 * The System page, clicked through in a real browser (no model tokens): model server wizard,
 * presets, backup/restore, update from a managed install, cleanup, health; per-request preset
 * and the "not ready → run anyway" path in the ask box; the page on a phone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium } from '@playwright/test'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { UpdateManager, createRuntime, startServer } from '@superagent/server'
import { calcProject, git, gitRepo, tempDir, FIXED_CALC, NODE_TEST_GATE, REPO_ROOT } from '@superagent/testkit'

const UI_DIR = join(REPO_ROOT, 'superagent/ui/dist')
const OK_STEPS = [['node', '-e', 'process.exit(0)']] as const

test('System page: models, presets, backup/restore, update, cleanup, health; ask with preset; phone', { timeout: 240_000 }, async () => {
  if (!existsSync(join(UI_DIR, 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: join(REPO_ROOT, 'superagent/ui'), stdio: 'pipe' })
  // OpenAI-compatible model server.
  const prov = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer sk-dgx') { res.writeHead(401).end('{}'); return }
    if (req.url === '/v1/models') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen-coder' }, { id: 'qwen-max' }] }))
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'p' } }] }))
  })
  await new Promise<void>(r => prov.listen(0, '127.0.0.1', r))
  const provUrl = `http://127.0.0.1:${(prov.address() as AddressInfo).port}/v1`
  // Managed install with a newer tagged version upstream.
  const upstream = gitRepo({ 'package.json': JSON.stringify({ version: '1.0.0' }), 'superagent/plugins/project-state/src/store.ts': 'export const STATE_SCHEMA_VERSION = 1\n' })
  git(upstream, 'tag', 'v1.0.0')
  writeFileSync(join(upstream, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  git(upstream, 'commit', '-qam', '1.1.0')
  git(upstream, 'tag', 'v1.1.0')
  const base = join(tempDir('sa-install-'), 'superagent')
  UpdateManager.install(base, upstream, 'v1.0.0', OK_STEPS)
  let restarts = 0

  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(i => { writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC) }) })
  const server = await startServer({ runtime, port: 0, uiDir: UI_DIR, humanToken: 'h'.repeat(24), update: { base, steps: OK_STEPS, restart: () => { restarts++; return true } } })
  await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
  await runtime.addProject({ name: 'plain', root: tempDir('sa-plain-'), defaultGates: [NODE_TEST_GATE] })
  const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) })
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
  page.on('dialog', d => void d.accept())
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  try {
    await page.goto(`${server.url}/?token=${'h'.repeat(24)}`)
    await page.getByTestId('project-calc').click()
    // A non-git project is red → the health dot says so.
    await page.locator('[data-testid="health-dot"].red').waitFor()
    await page.getByTestId('open-system').click()
    await page.getByTestId('health-overall').filter({ hasText: 'Not ready' }).waitFor()
    await page.getByTestId('check-project.plain.git').waitFor()

    // Models: add the DGX server through the wizard (wrong key first).
    await page.getByTestId('sys-models').click()
    await page.getByTestId('add-provider').click()
    await page.getByTestId('prov-name').fill('dgx')
    await page.getByTestId('prov-url').fill(provUrl)
    await page.getByTestId('prov-key').fill('sk-wrong')
    await page.getByTestId('prov-probe').click()
    await page.getByTestId('prov-result').filter({ hasText: 'rejected the key' }).waitFor()
    await page.getByTestId('prov-key').fill('sk-dgx')
    await page.getByTestId('prov-probe').click()
    await page.getByTestId('prov-result').filter({ hasText: '2 model(s) available' }).waitFor()
    await page.getByTestId('prov-model-qwen-max').check()
    await page.getByTestId('prov-save').click()
    await page.getByTestId('provider-dgx').getByText('local default').waitFor()
    // Presets: fill Budget, apply it.
    await page.getByTestId('edit-presets').click()
    for (const role of ['chief', 'planner', 'reviewer', 'escalation']) await page.getByTestId(`pe-budget-${role}`).selectOption('dgx/qwen-max')
    await page.getByTestId('pe-budget-worker').selectOption('dgx/qwen-coder')
    await page.getByTestId('presets-save').click()
    await page.getByTestId('apply-budget').click()
    await page.getByTestId('preset-budget').getByText('active').waitFor()
    const pol = await (await fetch(`${server.url}/api/policy`)).json()
    assert.deepEqual(pol.global.models.worker, { provider: 'dgx', model: 'qwen-coder' })

    // Backup, then restore it.
    await page.getByTestId('sys-backup').click()
    await page.getByTestId('backup-create').click()
    await page.getByTestId('backup-manual').waitFor()
    await page.getByTestId('backup-manual').getByTestId('backup-restore').click()
    await page.getByText(/Restored\. The previous state was saved as/).waitFor()

    // Update: check → update → switched, restart requested.
    await page.getByTestId('sys-update').click()
    await page.getByTestId('update-check').click()
    const v11 = page.getByTestId('update').locator('li', { hasText: 'v1.1.0' })
    await v11.waitFor()
    await v11.getByRole('button', { name: 'Update' }).click()
    await page.getByTestId('update-job').filter({ hasText: /installed/ }).waitFor({ timeout: 30_000 })
    assert.equal(restarts, 1)
    await page.getByTestId('update-rollback').waitFor()

    // Cleanup preview + apply.
    await page.getByTestId('sys-cleanup').click()
    await page.getByTestId('clean-temp').waitFor()
    await page.getByTestId('close-system').click()

    // Ask box: blocked for a non-git project, run anyway; per-request preset on the calc project.
    await page.getByTestId('project-plain').click()
    await page.getByTestId('ask-input').fill('add a readme')
    await page.getByTestId('ask-submit').click()
    await page.getByTestId('ask-blocked').filter({ hasText: 'not a git repository' }).waitFor()
    await page.getByTestId('project-calc').click()
    await page.getByTestId('ask-preset').selectOption('local')
    await page.getByTestId('ask-input').fill('fix add')
    await page.getByTestId('ask-submit').click()
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor({ timeout: 60_000 })
    const tasks = runtime.store.listTasks('calc')
    assert.deepEqual(tasks.at(-1)!.pinnedModels?.worker, { provider: 'local-default', model: 'default' }, 'this request ran on the chosen preset')

    // Phone: System reachable from More, fits the screen.
    const phone = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await phone.goto(`${server.url}/?token=${'h'.repeat(24)}`)
    await phone.getByTestId('project-calc').tap()
    await phone.getByTestId('nav-more').tap()
    await phone.getByTestId('more-system').tap()
    await phone.getByTestId('health-overall').waitFor()
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'system page fits the phone')

    // A Chinese browser gets the Chinese UI; the 中/EN toggle switches and remembers it.
    const zh = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
    await zh.goto(`${server.url}/?token=${'h'.repeat(24)}`)
    await zh.getByTestId('project-calc').click()
    await zh.getByText('你想做什么？').waitFor()
    await zh.getByTestId('open-system').click()
    await zh.getByTestId('sys-health').filter({ hasText: '健康' }).waitFor()
    await zh.getByTestId('close-system').click()
    await zh.getByTestId('toggle-lang').click()
    await zh.getByText('What do you want?').waitFor()
    await zh.close()
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
    prov.close()
  }
})
