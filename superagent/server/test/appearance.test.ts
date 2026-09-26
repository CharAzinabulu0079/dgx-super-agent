import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { calcProject, tempDir, NODE_TEST_GATE } from '@superagent/testkit'
import { AppearanceError, DEFAULT_APPEARANCE, createRuntime, parseAppearance, startServer } from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function call(base: string, method: string, path: string, body?: unknown, token?: string, type = 'application/json'): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('parseAppearance: validates every field; embeds only http(s) without credentials', () => {
  assert.deepEqual(parseAppearance({}), { ...DEFAULT_APPEARANCE, background: { kind: 'none', blur: 0, dim: 0 } })
  const a = parseAppearance({ style: 'solid', theme: 'dark', accent: '#FF8800', panelOpacity: 0.9, background: { kind: 'embed', url: 'http://10.8.0.1:8080/avatar', interactive: true, allowChat: true, blur: 0, dim: 0.2 } })
  assert.equal(a.accent, '#ff8800')
  assert.equal(a.background.url, 'http://10.8.0.1:8080/avatar')
  for (const bad of [
    { accent: 'red' }, { panelOpacity: 0.1 }, { theme: 'neon' },
    { background: { kind: 'embed', url: 'javascript:alert(1)' } }, { background: { kind: 'embed', url: 'http://u:p@host/' } },
    { background: { kind: 'image', assetId: '../../etc/passwd' } }, { background: { kind: 'gradient', preset: 'x' } }, { background: { kind: 'none', blur: 99 } },
  ]) assert.throws(() => parseAppearance(bad), AppearanceError, JSON.stringify(bad))
})

test('API: appearance is human-writable, uploads are checked by content, backgrounds use signed links', async () => {
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const initial = await call(server.url, 'GET', '/api/ui/appearance')
    assert.equal(initial.json.appearance.background.preset, 'aurora')
    assert.equal((await call(server.url, 'POST', '/api/ui/appearance', { theme: 'dark' }, server.agentToken)).status, 403, 'agents cannot restyle the UI')
    assert.equal((await call(server.url, 'POST', '/api/ui/backgrounds', PNG, server.agentToken, 'image/png')).status, 403)
    // Declared type is not trusted: SVG/HTML bytes labelled as PNG are refused; SVG as a type is not accepted at all.
    assert.equal((await call(server.url, 'POST', '/api/ui/backgrounds', Buffer.from('<svg onload="alert(1)"/>'), 'h', 'image/png')).status, 400)
    assert.equal((await call(server.url, 'POST', '/api/ui/backgrounds', Buffer.from('<svg/>'), 'h', 'image/svg+xml')).status, 415)
    assert.equal((await call(server.url, 'POST', '/api/ui/appearance', 'x', 'h', 'text/plain')).status, 415, 'no simple cross-origin POSTs')
    const up = await call(server.url, 'POST', '/api/ui/backgrounds', PNG, 'h', 'image/png')
    assert.equal(up.status, 200)
    assert.match(up.json.id, /^bg_[0-9a-f]{16}$/)
    const saved = await call(server.url, 'POST', '/api/ui/appearance', { style: 'glass', background: { kind: 'image', assetId: up.json.id, blur: 8, dim: 0.3 } }, 'h')
    assert.equal(saved.status, 200)
    const img = await fetch(`${server.url}${saved.json.backgroundUrl}`)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await img.arrayBuffer()).equals(PNG), true)
    assert.equal((await call(server.url, 'POST', `/api/ui/backgrounds/${up.json.id}/delete`, {}, 'h')).status, 400, 'in-use background is kept')
    assert.equal((await call(server.url, 'POST', '/api/ui/appearance', { background: { kind: 'image', assetId: 'bg_0000000000000000' } }, 'h')).status, 400, 'unknown asset')
  } finally {
    await server.close()
  }
})

test('SSE carries plain-language activity lines for voice/avatar clients', async () => {
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0 })
  try {
    await runtime.addProject({ name: 'calc', root: calcProject(), defaultGates: [NODE_TEST_GATE] })
    const ac = new AbortController()
    const res = await fetch(`${server.url}/api/events/stream?project=calc`, { signal: ac.signal })
    const reader = res.body!.getReader()
    await new Promise(r => setTimeout(r, 600)) // first pump tick pins the cursor
    runtime.chief.createGoal('calc', 'make it fast')
    let text = ''
    const end = Date.now() + 5_000
    while (!/event: activity/.test(text) && Date.now() < end) text += new TextDecoder().decode((await reader.read()).value)
    ac.abort()
    assert.match(text, /event: activity\ndata: \{"projectId":"calc".*"text":"New goal: make it fast"/)
  } finally {
    await server.close()
  }
})
