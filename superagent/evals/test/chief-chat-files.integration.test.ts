/**
 * Talk to the Chief from the SuperAgent UI API, and receive files from agents:
 * - human chat → persistent Chief DSH session (tool calls + reply land in the transcript);
 * - the Chief and a DSH Worker hand files to the human with superagent_share_file;
 * - the Worker's full DSH trajectory is readable as a transcript;
 * - shared files open through short-lived signed links.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DshHeadlessExecutor } from '@superagent/chief-worker'
import { createRuntime, setupDshProfiles, startServer } from '@superagent/server'
import { calcProject, startMockLlm, tempDir, text, toolCall, NODE_TEST_GATE } from '@superagent/testkit'

async function api(base: string, method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status })
  return json
}

test('Chief chat, agent file sharing and Worker transcripts through real DSH sessions', { timeout: 400_000 }, async () => {
  const root = calcProject()
  writeFileSync(join(root, 'NOTES.md'), '# release notes\n- add() fixed\n')
  const home = tempDir('sa-home-')
  setupDshProfiles(join(home, 'dsh-home'))
  const mock = await startMockLlm(req => {
    const all = JSON.stringify(req.messages)
    const last = JSON.stringify(req.messages.at(-1)?.content ?? '')
    if (all.includes('Message from the human in the SuperAgent UI')) {
      if (!last.includes('tool_result')) return toolCall('superagent_share_file', { project: 'calc', path: 'NOTES.md', note: 'release notes you asked for' })
      return text('I shared NOTES.md with you — open it under Files.')
    }
    if (all.includes('You are a SuperAgent Worker')) {
      if (!last.includes('tool_result')) return toolCall('superagent_share_file', { path: 'src/calc.js', note: 'current implementation' })
      return text('Shared the file.\n```superagent-report\n{"kind":"result","current_state":"done","progress":100,"verification_result":"claimed_fail","human_required":false,"summary":"shared calc.js"}\n```')
    }
    return text('ok')
  })
  const env = { DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_API_KEY: 'k' }
  const runtime = createRuntime({ home, executor: new DshHeadlessExecutor({ env, timeoutMs: 120_000 }) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h', chiefChat: true, chiefEnv: env })
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    await assert.rejects(api(server.url, 'POST', '/api/projects/calc/chief/messages', { text: 'hi' }, server.agentToken), /credential/, 'only the human chats')
    await api(server.url, 'POST', '/api/projects/calc/chief/messages', { text: 'Please send me the release notes' }, 'h')
    let chat: any
    for (let i = 0; i < 600; i++) {
      chat = await api(server.url, 'GET', '/api/projects/calc/chief/messages')
      if (!chat.busy && chat.messages.some((m: any) => m.role === 'chief')) break
      await sleep(200)
    }
    assert.deepEqual(chat.messages.map((m: any) => m.role), ['human', 'tool', 'chief'])
    assert.match(chat.messages[1].text, /superagent_share_file NOTES.md/)
    assert.match(chat.messages[2].text, /open it under Files/)

    const goal = runtime.chief.createGoal('calc', 'x')
    runtime.chief.addTask('calc', goal.id, { title: 'share', instructions: 'share src/calc.js', policy: { maxAttempts: 1 } })
    await runtime.chief.runGoal('calc', goal.id)
    const files = await api(server.url, 'GET', '/api/projects/calc/files')
    assert.deepEqual(files.map((f: any) => `${f.from.role}:${f.name}`).sort(), ['chief:NOTES.md', 'worker:calc.js'])
    const workerFile = files.find((f: any) => f.from.role === 'worker')
    assert.ok(workerFile.from.taskId && workerFile.from.workerId)

    const link = await api(server.url, 'POST', '/api/links', { project: 'calc', file: files.find((f: any) => f.name === 'NOTES.md').id })
    assert.match(await (await fetch(`${server.url}${link.url}`)).text(), /release notes/)

    const t = await api(server.url, 'GET', `/api/projects/calc/workers/${workerFile.from.workerId}/transcript`)
    assert.match(t.prompt, /You are a SuperAgent Worker/)
    assert.deepEqual(t.steps.map((s: any) => s.type).slice(0, 3), ['tool_call', 'tool_result', 'text'])
    assert.equal(t.steps[0].tool, 'superagent_share_file')
    const activity = (await api(server.url, 'GET', '/api/projects/calc/activity')).map((a: any) => a.text).join('\n')
    assert.match(activity, /the Worker shared a file: calc.js — current implementation/)
    assert.match(activity, /The Chief shared a file: NOTES.md/)
  } finally {
    await server.close()
    await mock.close()
  }
})
