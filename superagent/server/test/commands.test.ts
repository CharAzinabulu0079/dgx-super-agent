import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'

async function call(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('human-run commands: human only, project cwd, scrubbed env, danger needs explicit confirmation, stop', async () => {
  const root = calcProject()
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  process.env.SUPERAGENT_AGENT_TOKEN = 'leak-me'
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    assert.equal((await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'ls' }, server.agentToken)).status, 403, 'agents cannot run commands')
    assert.equal((await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'ls' })).status, 401)

    const started = await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'pwd; echo token=${SUPERAGENT_AGENT_TOKEN:-none}; node --test 2>&1 | tail -3' }, 'h')
    assert.equal(started.status, 200)
    let got: any
    for (let i = 0; i < 100; i++) {
      got = (await call(server.url, 'GET', `/api/projects/calc/commands/${started.json.id}`, undefined, 'h')).json
      if (got.record.status !== 'running') break
      await sleep(100)
    }
    assert.equal(got.record.status, 'exited')
    assert.match(got.output, new RegExp(root.replace(/[/.]/g, '\\$&')))
    assert.match(got.output, /token=none/, 'SuperAgent credentials are scrubbed')

    const check = await call(server.url, 'POST', '/api/projects/calc/commands/check', { command: 'rm -rf src' }, 'h')
    assert.equal(check.json.allowWithoutConfirm, false)
    assert.equal((await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'rm -rf src' }, 'h')).status, 400, 'flagged commands need confirmDanger')
    assert.ok(existsSync(join(root, 'src')))
    const confirmed = await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'rm -rf src', confirmDanger: true }, 'h')
    assert.match(confirmed.json.flagged, /irreversible|recursive/)

    const slow = await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'sleep 30' }, 'h')
    assert.equal((await call(server.url, 'POST', `/api/projects/calc/commands/${slow.json.id}/stop`, {}, 'h')).status, 200)
    for (let i = 0; i < 60; i++) {
      got = (await call(server.url, 'GET', `/api/projects/calc/commands/${slow.json.id}`, undefined, 'h')).json
      if (got.record.status !== 'running') break
      await sleep(100)
    }
    assert.equal(got.record.status, 'stopped')
    const activity = (await call(server.url, 'GET', '/api/projects/calc/activity')).json.map((a: any) => a.text).join('\n')
    assert.match(activity, /You ran `rm -rf src` \(flagged: .*you confirmed\)/)
  } finally {
    delete process.env.SUPERAGENT_AGENT_TOKEN
    await server.close()
  }
})
