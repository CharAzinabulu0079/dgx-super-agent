import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'

async function call(base: string, method: string, path: string, body?: unknown, token?: string, type = 'application/json'): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('backup → damage → restore: state comes back, secrets excluded by default and kept on restore', async () => {
  const home = tempDir('sa-home-')
  const runtime = createRuntime({ home, executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    const goal = runtime.chief.createGoal('calc', 'keep me')
    runtime.chief.addTask('calc', goal.id, { title: 'task A', instructions: 'i' })
    await call(server.url, 'POST', '/api/ui/appearance', { style: 'glass', theme: 'dark' }, 'h')
    mkdirSync(join(home, 'secrets'), { recursive: true })
    writeFileSync(join(home, 'secrets', 'agent-token'), 'secret-agent-token')
    writeFileSync(join(home, 'model-routes.json'), JSON.stringify({ piAiProviders: { dgx: { api: 'openai-completions', baseURL: 'http://x/v1', apiKeyEnv: 'SA_KEY_DGX', models: [{ id: 'm' }] } }, env: { SA_KEY_DGX: 'sk-live' } }))

    assert.equal((await call(server.url, 'POST', '/api/system/backups', { label: 'before' }, server.agentToken)).status, 403, 'human only')
    const made = await call(server.url, 'POST', '/api/system/backups', { label: 'before' }, 'h')
    const b = made.json.backups[0]
    assert.deepEqual(b.manifest.includes, { secrets: false, sessions: false })
    const members = execFileSync('tar', ['-tzf', join(home, 'backups', `${b.id}.tar.gz`)]).toString()
    assert.doesNotMatch(members, /secrets\//, 'no secrets in a default backup')
    const routesInArchive = JSON.parse(execFileSync('tar', ['-xzOf', join(home, 'backups', `${b.id}.tar.gz`), './model-routes.json']).toString())
    assert.equal(routesInArchive.env.SA_KEY_DGX, '', 'provider layout kept, key value removed')
    assert.equal(routesInArchive.piAiProviders.dgx.baseURL, 'http://x/v1')

    // Damage: goal gone, a new project, appearance changed.
    runtime.store.updateGoal('calc', goal.id, { objective: 'CORRUPTED' })
    await runtime.addProject({ name: 'later', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    await call(server.url, 'POST', '/api/ui/appearance', { style: 'solid' }, 'h')

    // Not while a command runs.
    const cmd = await call(server.url, 'POST', '/api/projects/calc/commands', { command: 'sleep 3' }, 'h')
    const refused = await call(server.url, 'POST', `/api/system/backups/${b.id}/restore`, {}, 'h')
    assert.equal(refused.status, 400)
    assert.match(refused.json.error, /command is running/)
    await call(server.url, 'POST', `/api/projects/calc/commands/${cmd.json.id}/stop`, {}, 'h')
    for (let i = 0; i < 50 && (await call(server.url, 'GET', `/api/projects/calc/commands/${cmd.json.id}`, undefined, 'h')).json.record.status === 'running'; i++) await new Promise(r => setTimeout(r, 100))

    const restored = await call(server.url, 'POST', `/api/system/backups/${b.id}/restore`, {}, 'h')
    assert.equal(restored.status, 200, restored.json.error)
    assert.equal(runtime.store.getGoal('calc', goal.id)!.objective, 'keep me')
    assert.equal(runtime.store.getProject('later'), undefined, 'a project added later is moved aside')
    assert.ok(existsSync(join(restored.json.keptOldAt, 'projects', 'later')), 'replaced state is kept, not deleted')
    assert.equal((await call(server.url, 'GET', '/api/ui/appearance')).json.appearance.style, 'glass')
    assert.equal(readFileSync(join(home, 'secrets', 'agent-token'), 'utf8'), 'secret-agent-token', 'secrets untouched')
    assert.equal(JSON.parse(readFileSync(join(home, 'model-routes.json'), 'utf8')).env.SA_KEY_DGX, 'sk-live', 'current keys kept')
    assert.ok(restored.json.backups.some((x: any) => x.id === restored.json.preRestore && x.manifest.label === 'pre-restore'), 'automatic pre-restore backup')

    // Download through a signed link, upload it back as an import.
    const link = restored.json.backups.find((x: any) => x.id === b.id).url
    const dl = await fetch(`${server.url}${link}`)
    assert.match(dl.headers.get('content-disposition')!, new RegExp(`^attachment; filename="${b.id}\\.tar\\.gz"`))
    const bytes = Buffer.from(await dl.arrayBuffer())
    const up = await call(server.url, 'POST', '/api/system/backups/upload', bytes, 'h', 'application/gzip')
    assert.equal(up.status, 200)
    assert.ok(up.json.backups.some((x: any) => x.id.endsWith('-imported')))
    assert.equal((await call(server.url, 'POST', '/api/system/backups/upload', Buffer.from('not a tar'), 'h', 'application/gzip')).status, 400)

    // A backup from a newer state format is refused.
    const stage = tempDir('sa-stage-')
    mkdirSync(join(stage, 'projects'))
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ format: 'superagent-backup', formatVersion: 1, schema: 99, createdAt: new Date().toISOString(), label: 'future', includes: { secrets: false, sessions: false }, projects: [] }))
    execFileSync('tar', ['-czf', join(home, 'backups', 'future.tar.gz'), '-C', stage, './manifest.json', './projects'])
    const future = await call(server.url, 'POST', '/api/system/backups/future/restore', {}, 'h')
    assert.match(future.json.error, /state format 99/)
  } finally {
    await server.close()
  }
})
