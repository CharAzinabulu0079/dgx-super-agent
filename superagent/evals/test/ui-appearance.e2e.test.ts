/**
 * Appearance on desktop: uploaded image background shared across devices, and a
 * cross-origin "Digital Human" page as the background that receives live activity through
 * the postMessage bridge and (when allowed) talks to the Chief as the human.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium } from '@playwright/test'
import { ScriptedExecutor, appendChiefMessage, type ChiefChannel } from '@superagent/chief-worker'
import { createRuntime, startServer } from '@superagent/server'
import { calcProject, tempDir, NODE_TEST_GATE, REPO_ROOT } from '@superagent/testkit'

const UI_DIR = join(REPO_ROOT, 'superagent/ui/dist')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const AVATAR = `<!doctype html><body style="background:#123">avatar<script>
let said = false
addEventListener('message', e => {
  const m = e.data
  if (m?.source !== 'superagent') return
  if (m.type === 'hello') parent.postMessage({ source: 'superagent-background', type: 'chat', text: 'hello from avatar, project ' + (m.data.project && m.data.project.id) }, '*')
  if (m.type === 'activity' && !said) { said = true; parent.postMessage({ source: 'superagent-background', type: 'chat', text: 'avatar saw: ' + m.data.text }, '*') }
})
parent.postMessage({ source: 'superagent-background', type: 'ready' }, '*')
</script>`

test('UI appearance: image background for all devices; Digital Human embed bridge', { timeout: 180_000 }, async () => {
  if (!existsSync(join(UI_DIR, 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: join(REPO_ROOT, 'superagent/ui'), stdio: 'pipe' })
  const avatar = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(AVATAR) })
  await new Promise<void>(r => avatar.listen(0, '127.0.0.1', r))
  const avatarUrl = `http://localhost:${(avatar.address() as AddressInfo).port}/avatar` // other origin than the UI
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const heard: string[] = []
  const chat: ChiefChannel = { name: 'scripted', deliver: async () => ({}), chat: async (pid, text) => { heard.push(text); appendChiefMessage(runtime.store, pid, 'human', text); return {} } }
  const server = await startServer({ runtime, port: 0, uiDir: UI_DIR, chiefChat: chat })
  await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
  const browser = await chromium.launch({ executablePath: process.env.SUPERAGENT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  try {
    await page.goto(`${server.url}/?token=${server.humanToken}`)
    await page.getByTestId('project-calc').click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.style), 'solid', 'clean style by default')

    // Upload an image background for all devices.
    await page.getByTestId('open-appearance').click()
    await page.getByTestId('bg-kind-image').click()
    await page.getByTestId('bg-upload').setInputFiles({ name: 'wall.png', mimeType: 'image/png', buffer: PNG })
    await page.locator('[data-testid^="asset-bg_"]').first().click()
    await page.getByTestId('theme-dark').click()
    await page.getByTestId('appearance-save').click()
    await page.locator('[data-testid="bg-layer"][data-kind="image"]').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    const other = await browser.newPage()
    await other.goto(`${server.url}/?token=${server.humanToken}`)
    await other.locator('[data-testid="bg-layer"][data-kind="image"]').waitFor()
    await other.close()

    // Digital Human page as the background, chat allowed.
    await page.getByTestId('open-appearance').click()
    await page.getByTestId('bg-kind-embed').click()
    await page.getByTestId('embed-url').fill(avatarUrl)
    await page.getByTestId('embed-chat').check()
    await page.getByTestId('appearance-save').click()
    const frame = page.getByTestId('bg-embed')
    await frame.waitFor()
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-same-origin', 'cross-origin page keeps its own origin')
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await page.waitForTimeout(100); assert.ok(pred(), heard.join(' | ')) }
    await until(() => heard.some(h => h === 'hello from avatar, project calc'))
    // Something happens in the project → activity reaches the avatar → it reacts.
    runtime.chief.createGoal('calc', 'make it faster')
    await until(() => heard.some(h => h === 'avatar saw: New goal: make it faster'))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
    avatar.close()
  }
})
