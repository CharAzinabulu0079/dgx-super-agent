import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, git, gitRepo, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { UpdateManager, createRuntime, managedBase, startServer, systemdUnit } from '../src/index.ts'

/** A tiny "SuperAgent" upstream with tagged versions (schema line where the real one lives). */
function upstream(): string {
  const schemaFile = 'superagent/plugins/project-state/src/store.ts'
  const repo = gitRepo({ 'package.json': JSON.stringify({ version: '1.0.0' }), [schemaFile]: 'export const STATE_SCHEMA_VERSION = 1\n' })
  git(repo, 'tag', 'v1.0.0')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  git(repo, 'commit', '-qam', '1.1.0')
  git(repo, 'tag', 'v1.1.0')
  return repo
}

async function call(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

const OK_STEPS = [['node', '-e', 'process.exit(0)']] as const

test('update: build beside the running release, back up, switch, restart; failed start-up check rolls back', async () => {
  const src = upstream()
  const base = join(tempDir('sa-install-'), 'superagent')
  const m0 = UpdateManager.install(base, src, 'v1.0.0', OK_STEPS)
  assert.equal(m0.state().current, '1.0.0-' + git(src, 'rev-parse', 'v1.0.0^{commit}').trim().slice(0, 7))
  assert.equal(readlinkSync(join(base, 'current')), join('releases', m0.state().current!))
  assert.equal(managedBase(join(base, 'current')), base, 'a release knows it is managed')
  assert.match(systemdUnit({ base }), new RegExp(`ExecStart=.* ${join(base, 'current', 'superagent/cli/src/main.ts').replace(/[/.]/g, '\\$&')} serve`))
  assert.match(systemdUnit({ base }), /^EnvironmentFile=-%h\/\.config\/superagent\/env$/m)

  const home = tempDir('sa-home-')
  let restarts = 0
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h', update: { base, steps: OK_STEPS, restart: () => { restarts++; return true } } })
  try {
    await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    assert.equal((await call(server.url, 'POST', '/api/system/update/check', {}, server.agentToken)).status, 403, 'human only')
    const check = (await call(server.url, 'POST', '/api/system/update/check', {}, 'h')).json
    assert.deepEqual(check.available.map((a: any) => `${a.ref}:${a.newer}`), ['v1.1.0:true', 'v1.0.0:false'])

    // Not while work runs.
    const cmd = await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'sleep 2' }, 'h')
    assert.match((await call(server.url, 'POST', '/api/system/update', { ref: 'v1.1.0' }, 'h')).json.error, /command is running/)
    await call(server.url, 'POST', `/api/projects/calc/commands/${cmd.json.id}/stop`, {}, 'h')
    for (let i = 0; i < 50 && (await call(server.url, 'GET', `/api/projects/calc/commands/${cmd.json.id}`, undefined, 'h')).json.record.status === 'running'; i++) await new Promise(r => setTimeout(r, 100))

    const started = await call(server.url, 'POST', '/api/system/update', { ref: 'v1.1.0' }, 'h')
    assert.equal(started.status, 200, started.json.error)
    let st: any
    for (let i = 0; i < 100; i++) {
      st = (await call(server.url, 'GET', '/api/system/update', undefined, 'h')).json
      if (st.job?.status !== 'running') break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(st.job.status, 'switched', st.job.error)
    const v11 = st.state.current
    assert.match(v11, /^1\.1\.0-/)
    assert.equal(readlinkSync(join(base, 'current')), join('releases', v11))
    assert.equal(restarts, 1, 'supervised restart requested')
    assert.equal(st.state.pendingVerify.id, v11)
    assert.ok(existsSync(join(home, 'backups', `${st.state.pendingVerify.backup}.tar.gz`)), 'automatic pre-update backup')

    // The new release fails its start-up check → back to 1.0.0 automatically.
    const m = new UpdateManager({ base, home })
    assert.equal(m.verifyAfterStart(v11, false, 'DSH runtime missing'), 'rolled-back')
    assert.match(m.state().current!, /^1\.0\.0-/)
    assert.equal(m.state().history.at(-1)!.action, 'auto-rollback')
    assert.match(m.state().history.at(-1)!.note!, /DSH runtime missing/)

    // Again, this time healthy → verified and kept; manual rollback also works.
    await call(server.url, 'POST', '/api/system/update', { ref: 'v1.1.0' }, 'h')
    for (let i = 0; i < 100 && (await call(server.url, 'GET', '/api/system/update', undefined, 'h')).json.job?.status === 'running'; i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(new UpdateManager({ base, home }).verifyAfterStart(v11, true), 'verified')
    const rb = await call(server.url, 'POST', '/api/system/update/rollback', {}, 'h')
    assert.match(rb.json.to, /^1\.0\.0-/)
    assert.equal((await call(server.url, 'POST', '/api/system/restart', {}, 'h')).json.restarting, true)
  } finally {
    await server.close()
  }
})

test('update refuses what would break: failing build, state from a newer format, not a managed install', async () => {
  const src = upstream()
  const base = join(tempDir('sa-install-'), 'superagent')
  UpdateManager.install(base, src, 'v1.0.0', OK_STEPS)
  const home = tempDir('sa-home-')
  const broken = new UpdateManager({ base, home, steps: [['node', '-e', 'console.error("tsc: 3 errors"); process.exit(2)']] })
  const job = broken.startUpdate('v1.1.0')
  await broken.done
  assert.equal(job.status, 'failed')
  assert.match(job.error!, /exit 2.*tsc: 3 errors/)
  assert.match(broken.state().current!, /^1\.0\.0-/, 'the running release is untouched')
  assert.equal(Object.keys(broken.state().releases).length, 1, 'the half-built release is removed')

  writeFileSync(join(home, 'state-version.json'), JSON.stringify({ schema: 2 }))
  const newer = new UpdateManager({ base, home, steps: OK_STEPS })
  const j2 = newer.startUpdate('v1.1.0')
  await newer.done
  assert.match(j2.error!, /state format 1, your state is format 2/)

  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const st = (await call(server.url, 'GET', '/api/system/update', undefined, 'h')).json
    assert.equal(st.managed, false)
    assert.match(st.hint, /sa install/)
    assert.equal((await call(server.url, 'POST', '/api/system/restart', {}, 'h')).status, 409, 'unsupervised: no silent exit')
  } finally {
    await server.close()
  }
})
