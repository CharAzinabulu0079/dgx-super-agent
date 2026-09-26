import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { StateStore, processAlive } from '@superagent/project-state'
import { createRuntime, startServer } from '../src/index.ts'
import { CommandRunner, type CommandRecord } from '../src/commands.ts'

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

test('commands left running by a dead server are closed as interrupted and their orphaned group is killed (regression: stuck "running")', async () => {
  const home = tempDir('sa-home-')
  const store = new StateStore(home)
  const p = store.createProject({ name: 'calc', root: calcProject() })
  const deadServer = spawnSync('true').pid! // a pid that has exited
  const orphan = spawn('sh', ['-c', 'sleep 60 & sleep 60'], { detached: true, stdio: 'ignore', env: { ...process.env, SUPERAGENT_COMMAND_ID: 'cmd_orphan' } })
  const stranger = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' }) // pid reused by an unrelated process
  const liveOwner = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' }) // another live server
  const rec = (id: string, pid: number | undefined, ownerPid: number | undefined): CommandRecord => ({ id, projectId: p.id, command: 'npm run dev', cwd: p.root, status: 'running', exitCode: null, startedAt: new Date().toISOString(), pid, ownerPid })
  store.putRecord('commands', rec('cmd_orphan', orphan.pid, deadServer))
  store.putRecord('commands', rec('cmd_reused', stranger.pid, deadServer))
  store.putRecord('commands', rec('cmd_legacy', undefined, undefined))
  store.putRecord('commands', rec('cmd_elsewhere', liveOwner.pid, liveOwner.pid))
  try {
    assert.ok(processAlive(orphan.pid!))
    const runner = new CommandRunner(store)
    await sleep(200)
    assert.equal(processAlive(orphan.pid!), false, 'the orphaned command group is killed')
    assert.equal(processAlive(stranger.pid!), true, 'a process without the command marker is never killed')
    const status = (id: string) => runner.get(p.id, id).record.status
    assert.equal(status('cmd_orphan'), 'interrupted')
    assert.equal(status('cmd_reused'), 'interrupted')
    assert.equal(status('cmd_legacy'), 'interrupted')
    assert.equal(status('cmd_elsewhere'), 'running', 'a command owned by another live server is left alone')
    assert.ok(store.readEvents(p.id, 0, 100).some(e => e.type === 'command/updated' && e.data.status === 'interrupted'))
    // A command started now records its pid and owner, so the next restart can recover it.
    const fresh = runner.start(p.id, 'sleep 30', false)
    assert.equal(fresh.ownerPid, process.pid)
    assert.ok(fresh.pid && processAlive(fresh.pid))
    assert.match(readFileSync(`/proc/${fresh.pid}/environ`, 'latin1'), new RegExp(`SUPERAGENT_COMMAND_ID=${fresh.id}`))
    runner.stopAll()
  } finally {
    for (const c of [orphan, stranger, liveOwner]) { try { process.kill(-c.pid!, 'SIGKILL') } catch (gone) { void gone } }
  }
})
