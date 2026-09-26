import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { StateStore, shareFile, ShareError } from '@superagent/project-state'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { LinkSigner, createRuntime, startServer } from '../src/index.ts'

async function api(base: string, method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status })
  return json
}

test('shareFile: only regular files inside the project; never state, .git or escaping links', () => {
  const home = tempDir('sa-home-')
  const store = new StateStore(home)
  const root = calcProject()
  const p = store.createProject({ name: 'calc', root })
  writeFileSync(join(root, 'report.md'), '# done\n')
  const f = shareFile(store, p.id, 'report.md', { role: 'worker', workerId: 'w1', taskId: 't1' }, 'final report')
  assert.equal(f.mime, 'text/markdown')
  assert.equal(f.source, 'report.md')
  rmSync(join(root, 'report.md'))
  assert.ok(store.listRecords(p.id, 'files').length === 1, 'the stored copy survives worktree changes')
  const outside = tempDir('sa-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
  for (const bad of ['link.txt', join(outside, 'secret.txt'), '../etc/passwd', '.git/config', 'src', join(home, 'projects', p.id, 'project.json')]) {
    assert.throws(() => shareFile(store, p.id, bad, { role: 'chief' }), ShareError, bad)
  }
  // State home inside the project tree is still refused.
  const nested = new StateStore(join(root, '.sa-home'))
  const q = nested.createProject({ name: 'calc2', root })
  assert.throws(() => shareFile(nested, q.id, join('.sa-home', 'projects', q.id, 'project.json'), { role: 'chief' }), /state is not shareable/)
})

test('links: signed, expiring, tamper-proof', () => {
  const s = new LinkSigner()
  const { token } = s.sign({ p: 'calc', f: 'file_1', d: 0 })
  assert.equal(s.verify(token)?.f, 'file_1')
  const [body, mac] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ p: 'calc', path: '../../etc/passwd', d: 0, e: Date.now() + 1e6 })).toString('base64url')
  assert.equal(s.verify(`${forged}.${mac}`), undefined)
  assert.equal(s.verify(`${body}.x${mac!.slice(1)}`), undefined)
  assert.equal(s.verify(s.sign({ p: 'calc', d: 0 }, -1).token), undefined, 'expired')
  assert.equal(new LinkSigner().verify(token), undefined, 'a restarted server invalidates old links')
})

test('API: share, list, browse, preview and download with safe headers and ranges', async () => {
  const root = calcProject()
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'out', 'page.html'), '<script>fetch("/api/projects")</script>hi')
  writeFileSync(join(root, 'out', 'data.bin'), Buffer.alloc(1000, 7))
  const outside = tempDir('sa-outside-')
  symlinkSync(outside, join(root, 'escape'))
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    await assert.rejects(api(server.url, 'POST', '/api/projects/calc/files', { path: 'out/page.html' }), /credential/)
    const shared = await api(server.url, 'POST', '/api/projects/calc/files', { path: 'out/page.html', note: 'preview' }, server.agentToken)
    assert.equal(shared.from.role, 'chief')
    await assert.rejects(api(server.url, 'POST', '/api/projects/calc/files', { path: 'escape' }, 'h'), /outside the project/)
    assert.equal((await api(server.url, 'GET', '/api/projects/calc/files')).length, 1)

    const tree = await api(server.url, 'GET', '/api/projects/calc/tree')
    const names = tree.entries.map((e: any) => e.name)
    assert.ok(names.includes('out') && names.includes('src'))
    assert.ok(!names.includes('.git') && !names.includes('escape'), 'no .git, no escaping links')
    await assert.rejects(api(server.url, 'GET', '/api/projects/calc/tree?path=..'), /outside/)

    const view = await api(server.url, 'POST', '/api/links', { project: 'calc', file: shared.id })
    const res = await fetch(`${server.url}${view.url}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type')!, /^text\/html/)
    assert.match(res.headers.get('content-security-policy')!, /sandbox/, 'active content is sandboxed')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-disposition')!, /^inline/)
    await res.text()

    const dl = await api(server.url, 'POST', '/api/links', { project: 'calc', path: 'out/data.bin', download: true })
    const ranged = await fetch(`${server.url}${dl.url}`, { headers: { range: 'bytes=10-19' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/1000')
    assert.match(ranged.headers.get('content-disposition')!, /^attachment; filename="data.bin"/)
    assert.equal((await ranged.arrayBuffer()).byteLength, 10)

    // Path links are re-validated when served: swapping the file for a link fails closed.
    const later = await api(server.url, 'POST', '/api/links', { project: 'calc', path: 'out/data.bin' })
    rmSync(join(root, 'out', 'data.bin'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'out', 'data.bin'))
    const swapped = await fetch(`${server.url}${later.url}`)
    assert.notEqual(swapped.status, 200)
    assert.doesNotMatch(await swapped.text(), /secret/)
    assert.equal((await fetch(`${server.url}/dl/garbage.token`)).status, 403)
  } finally {
    await server.close()
  }
})

test('remote bind (LAN/WireGuard): no anonymous reads; signed links still open without a token', async () => {
  const root = calcProject()
  writeFileSync(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, host: '0.0.0.0', humanToken: 'h'.repeat(24) })
  const base = server.url.replace('0.0.0.0', '127.0.0.1')
  try {
    await runtime.addProject({ name: 'calc', root, defaultGates: [NODE_TEST_GATE] })
    await assert.rejects(api(base, 'GET', '/api/projects'), (e: any) => e.status === 401)
    await assert.rejects(api(base, 'GET', '/api/projects/calc/files'), (e: any) => e.status === 401)
    assert.equal((await api(base, 'GET', '/api/projects', undefined, 'h'.repeat(24))).length, 1)
    const link = await api(base, 'POST', '/api/links', { project: 'calc', path: 'shot.png' }, 'h'.repeat(24))
    const res = await fetch(`${base}${link.url}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(link.url.includes('h'.repeat(24)), false, 'the human token is not in the link')
  } finally {
    await server.close()
  }
})
