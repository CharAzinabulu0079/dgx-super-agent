import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { calcProject, gitRepo, tempDir, writeFiles } from '@superagent/testkit'
import { createRuntime, detectGates, registerHeldOut } from '../src/index.ts'

test('detectGates proposes unit / e2e / architecture gates from the repository', () => {
  const ids = (root: string) => detectGates(root).map(g => `${g.id}:${g.kind}:${g.command ?? ''}:${g.parser ?? ''}`)
  assert.deepEqual(ids(calcProject()), ['unit:command:node --test:node-test', 'architecture:architecture-drift::'])
  const npm = gitRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }), 'playwright.config.ts': 'export default {}' })
  assert.deepEqual(ids(npm), ['unit:command:npm test --silent:node-test', 'e2e:e2e:npx playwright test --reporter=json:playwright-json', 'architecture:architecture-drift::'])
  const placeholder = gitRepo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
  assert.deepEqual(ids(placeholder), ['architecture:architecture-drift::'])
  assert.deepEqual(ids(gitRepo({ 'pyproject.toml': '[project]\nname="x"\n' })), ['unit:command:python3 -m pytest -q:', 'architecture:architecture-drift::'])
})

test('runtime.addProject uses detected gates only when none are given', async () => {
  const rt = createRuntime({ home: tempDir('sa-home-') })
  const auto = await rt.addProject({ name: 'a', root: calcProject() })
  assert.deepEqual(auto.defaultGates.map(g => g.id), ['unit', 'architecture'])
  const manual = await rt.addProject({ name: 'b', root: calcProject(), defaultGates: [{ id: 'x', kind: 'command', command: 'true', required: true }] })
  assert.deepEqual(manual.defaultGates.map(g => g.id), ['x'])
})

test('registerHeldOut copies tests into the store and refuses sources inside the project', () => {
  const store = new StateStore(tempDir('sa-home-'))
  const root = calcProject()
  const p = store.createProject({ name: 'calc', root })
  const suite = tempDir('sa-suite-')
  writeFiles(suite, { 'add.test.js': 'test' })
  const after = registerHeldOut(store, p.id, { gateId: 'acceptance', from: suite, mountAt: 'acceptance', command: 'node --test acceptance/*.test.js' })
  const gate = after.defaultGates.find(g => g.id === 'acceptance')!
  assert.deepEqual(gate.heldOut, { source: join(p.id, 'acceptance'), mountAt: 'acceptance' })
  assert.equal(gate.parser, 'node-test')
  assert.ok(existsSync(join(store.home, 'heldout', p.id, 'acceptance', 'add.test.js')))
  writeFileSync(join(root, 'hidden.test.js'), 'x')
  assert.throws(() => registerHeldOut(store, p.id, { gateId: 'bad', from: join(root, 'hidden.test.js'), mountAt: 'acc', command: 'true' }), /must not live inside the project/)
})
