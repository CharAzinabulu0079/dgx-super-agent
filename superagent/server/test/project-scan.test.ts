import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { gitRepo, tempDir, writeFiles } from '@superagent/testkit'
import { createRuntime, scanProject, startServer } from '../src/index.ts'

async function call(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('scan: languages, package manager, git, proposed checks, browser need, warnings', () => {
  const web = gitRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test', build: 'vite build', lint: 'eslint .' }, devDependencies: { '@playwright/test': '1', vite: '5', react: '19' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9', 'playwright.config.ts': 'export default {}',
    'src/app.tsx': '', 'src/util.ts': '', 'test/a.test.js': '', '.architecture/declared.json': '{}',
  })
  writeFileSync(join(web, 'dirty.txt'), 'x')
  const s = scanProject(web)
  assert.equal(s.packageManager, 'pnpm')
  assert.deepEqual(s.languages.map(l => l.name), ['TypeScript', 'JavaScript'])
  assert.deepEqual(s.gates.map(g => `${g.spec.id}:${g.recommended}:${g.spec.command ?? ''}`), [
    'unit:true:npm test --silent', 'e2e:true:npx playwright test --reporter=json', 'architecture:true:', 'build:false:pnpm build', 'lint:false:pnpm lint',
  ])
  assert.deepEqual(s.browser, { needed: true, reason: 'Playwright tests' })
  assert.equal(s.architecture.declared, true)
  assert.equal(s.git.isRepo, true)
  assert.match(s.warnings.join('|'), /1 uncommitted change/)

  const goRepo = gitRepo({ 'go.mod': 'module x', 'main.go': 'package main' })
  assert.equal(scanProject(goRepo).gates[0]!.spec.command, 'go test ./...')
  const rust = gitRepo({ 'Cargo.toml': '[package]', 'src/main.rs': '' })
  assert.equal(scanProject(rust).gates[0]!.spec.command, 'cargo test --quiet')

  const plain = tempDir('sa-plain-')
  writeFiles(plain, { 'notes.md': '#' })
  const p = scanProject(plain)
  assert.equal(p.git.isRepo, false)
  assert.match(p.warnings.join('|'), /not a git repository.*\|no test command found/)
  const nested = join(web, 'src')
  assert.match(scanProject(nested).warnings.join('|'), /inside another git repository/)
})

test('wizard API: human only; browse folders, scan, git init, create with chosen checks', async () => {
  const runtime = createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) })
  const server = await startServer({ runtime, port: 0, humanToken: 'h' })
  try {
    const parent = tempDir('sa-parent-')
    mkdirSync(join(parent, 'app'))
    writeFiles(join(parent, 'app'), { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'test/x.test.js': 'import test from "node:test"; test("x", () => {})' })
    mkdirSync(join(parent, '.hidden'))
    assert.equal((await call(server.url, 'GET', `/api/system/dirs?path=${encodeURIComponent(parent)}`, undefined, server.agentToken)).status, 403)
    const dirs = (await call(server.url, 'GET', `/api/system/dirs?path=${encodeURIComponent(parent)}`, undefined, 'h')).json
    assert.deepEqual(dirs.entries.map((e: any) => e.name), ['app'])
    const scan = (await call(server.url, 'POST', '/api/system/scan', { root: join(parent, 'app') }, 'h')).json
    assert.equal(scan.git.isRepo, false)
    const inited = (await call(server.url, 'POST', '/api/system/scan/git-init', { root: join(parent, 'app') }, 'h')).json
    assert.equal(inited.git.isRepo, true)
    assert.equal(inited.git.hasCommits, true)
    assert.equal(inited.git.dirty, 0)
    const created = await call(server.url, 'POST', '/api/projects', { name: inited.name, root: inited.root, defaultGates: inited.gates.filter((g: any) => g.recommended).map((g: any) => g.spec) }, 'h')
    assert.equal(created.status, 200)
    assert.deepEqual(created.json.defaultGates.map((g: any) => g.id), ['unit', 'architecture'])
    assert.match((await call(server.url, 'POST', '/api/system/scan', { root: inited.root }, 'h')).json.warnings.join(), /already registered as “app”/)
    assert.ok(existsSync(join(parent, 'app', '.git')))
  } finally {
    await server.close()
  }
})
