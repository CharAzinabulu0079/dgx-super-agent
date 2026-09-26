/**
 * The SuperAgent UI on a phone-sized touch browser, against a server listening beyond
 * localhost (as over WireGuard): token link login, Chief chat, files an agent sent
 * (preview + download), project file preview, Worker transcript; no horizontal scroll.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { ScriptedExecutor, appendChiefMessage, type ChiefChannel } from '@superagent/chief-worker'
import { shareFile } from '@superagent/project-state'
import { createRuntime, startServer } from '@superagent/server'
import { calcProject, tempDir, FIXED_CALC, NODE_TEST_GATE, REPO_ROOT } from '@superagent/testkit'

const UI_DIR = join(REPO_ROOT, 'superagent/ui/dist')
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('UI on a phone over a remote bind: chat, files (preview/download), transcript', { timeout: 180_000 }, async () => {
  if (!existsSync(join(UI_DIR, 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: join(REPO_ROOT, 'superagent/ui'), stdio: 'pipe' })
  const root = calcProject()
  writeFileSync(join(root, 'screenshot.png'), PNG)
  const runtime = createRuntime({
    home: tempDir('sa-home-'),
    executor: new ScriptedExecutor(i => {
      writeFileSync(join(i.project.root, 'src/calc.js'), FIXED_CALC)
      writeFileSync(join(i.project.root, 'REPORT.md'), '# Fix report\nadd() now returns a + b.\n')
      shareFile(runtime.store, i.project.id, 'REPORT.md', { role: 'worker', workerId: i.worker.id, taskId: i.task.id }, 'what I changed')
      // What the DSH executor records for a real Worker.
      const dir = join(i.stateHome, 'runtime', 'workers', i.worker.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'prompt.md'), 'You are a SuperAgent Worker.')
      writeFileSync(join(dir, 'events.jsonl'), [
        { type: 'tool_call', callId: 'c1', tool: 'edit', input: { file_path: 'src/calc.js' } },
        { type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' },
        { type: 'text', text: 'Fixed add() to return the sum.' },
      ].map(e => JSON.stringify(e)).join('\n') + '\n')
    }),
  })
  const chat: ChiefChannel = {
    name: 'scripted-chief',
    deliver: async () => ({}),
    chat: async (projectId, text) => {
      appendChiefMessage(runtime.store, projectId, 'human', text)
      appendChiefMessage(runtime.store, projectId, 'tool', 'superagent_status calc', 'superagent_status')
      appendChiefMessage(runtime.store, projectId, 'chief', 'All tasks passed. I sent you the fix report under Files.')
      return {}
    },
  }
  const token = 't'.repeat(24)
  const server = await startServer({ runtime, port: 0, host: '0.0.0.0', humanToken: token, uiDir: UI_DIR, chiefChat: chat })
  const base = server.url.replace('0.0.0.0', '127.0.0.1')
  await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
  const goal = runtime.chief.createGoal('calc', 'fix add')
  runtime.chief.addTask('calc', goal.id, { title: 'fix add', instructions: 'fix it' })
  await runtime.chief.runGoal('calc', goal.id)

  const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  try {
    const anon = await page.request.get(`${base}/api/projects`)
    assert.equal(anon.status(), 401, 'no anonymous reads beyond localhost')
    await page.goto(`${base}/?token=${token}`)
    await page.getByTestId('project-calc').tap()
    await page.getByTestId('goal-status').filter({ hasText: 'complete' }).waitFor()
    const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    assert.ok(await noHScroll(), 'overview fits the phone width')

    // Chief chat.
    await page.getByTestId('tab-chat').tap()
    await page.getByTestId('chat-input').fill('How is it going?')
    await page.getByTestId('chat-send').tap()
    await page.getByTestId('chat-chief').filter({ hasText: 'I sent you the fix report' }).waitFor()
    await page.getByTestId('chat-tool').filter({ hasText: 'superagent_status' }).waitFor()
    assert.ok(await noHScroll(), 'chat fits')

    // A file the Worker sent: preview then download.
    await page.getByTestId('tab-files').tap()
    const item = page.getByTestId('shared-REPORT.md')
    await item.getByText('what I changed').waitFor()
    await item.getByTestId('preview').tap()
    await page.getByTestId('preview-text').filter({ hasText: 'add() now returns a + b.' }).waitFor()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('preview-modal').getByRole('button', { name: 'Download' }).tap()])
    assert.equal(download.suggestedFilename(), 'REPORT.md')
    await page.getByTestId('close-preview').tap()
    // A project image through the browser.
    await page.getByTestId('file-screenshot.png').tap()
    const img = page.getByTestId('preview-image')
    await img.waitFor()
    assert.ok(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 1), 'image preview loads')
    const src = await img.getAttribute('src')
    assert.ok(src!.startsWith('/dl/') && !src!.includes(token), 'signed link, no token in the URL')
    await page.getByTestId('close-preview').tap()

    // Worker transcript.
    await page.getByTestId('tab-workers').tap()
    await page.locator('[data-testid^="worker-wkr_"]').first().tap()
    await page.getByTestId('step-tool').filter({ hasText: 'src/calc.js' }).waitFor()
    await page.getByTestId('step-text').filter({ hasText: 'Fixed add() to return the sum.' }).waitFor()
    await page.getByTestId('close-transcript').tap()

    // The activity feed tells the story in plain words.
    await page.getByTestId('tab-overview').tap()
    await page.getByTestId('activity').getByText('the Worker shared a file: REPORT.md — what I changed').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})
