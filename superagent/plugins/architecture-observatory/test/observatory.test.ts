import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitRepo, git, tempDir, writeFiles } from '@superagent/testkit'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, LoopEngine, ScriptedExecutor } from '@superagent/chief-worker'
import { Observatory, driftGateRunner, observatoryHooks, reverseClosure, moduleCycles, changedFiles } from '../src/index.ts'

const pkg = (name: string, deps: string[] = []): string => JSON.stringify({ name, type: 'module', exports: { '.': './src/index.ts' }, dependencies: Object.fromEntries(deps.map(d => [d, 'workspace:*'])) })

/** app → domain → core; declared layers core < domain < app. */
function monorepo(): string {
  return gitRepo({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/core/package.json': pkg('@acme/core'),
    'packages/core/src/index.ts': `export const VERSION = 1\nexport function util(): number { return VERSION }\n`,
    'packages/domain/package.json': pkg('@acme/domain', ['@acme/core']),
    'packages/domain/src/index.ts': `import { util } from '@acme/core'\nexport * from './model.ts'\nexport const run = () => util()\n`,
    'packages/domain/src/model.ts': `export interface Order { id: string }\nexport class OrderService {}\n`,
    'packages/app/package.json': JSON.stringify({ name: '@acme/app', type: 'module', bin: { acme: './src/main.ts' }, scripts: { start: 'node src/main.ts' } }),
    'packages/app/src/main.ts': `import { run } from '@acme/domain'\nimport { createServer } from 'node:http'\ncreateServer(() => {}).listen(0)\nrun()\n`,
    'packages/app/test/main.test.ts': `import '@acme/core'\n`,
    '.architecture/declared.json': JSON.stringify({
      layers: ['core', 'domain', 'app'],
      modules: [
        { id: 'core', paths: ['packages/core/**'], layer: 'core', protected: true, gates: ['unit-core'], adrs: ['ADR-0001'] },
        { id: 'domain', paths: ['packages/domain/**'], layer: 'domain', dependsOn: ['core'], gates: ['unit-domain'] },
        { id: 'app', paths: ['packages/app/**'], layer: 'app', gates: ['e2e'] },
      ],
    }),
  })
}

test('scan: modules, module edges from workspace imports, interfaces, services, persisted files', async () => {
  const root = monorepo()
  const g = await new Observatory().scan(root)
  assert.deepEqual(g.nodes.map(n => n.id).sort(), ['app', 'core', 'domain'])
  const e = (from: string, to: string) => g.edges.find(x => x.from === from && x.to === to)
  assert.ok(e('domain', 'core') && !e('domain', 'core')!.testOnly)
  assert.ok(e('app', 'domain'))
  assert.equal(e('app', 'core')?.testOnly, true)
  assert.deepEqual(g.drift, [])
  const domain = g.nodes.find(n => n.id === 'domain')!
  assert.deepEqual(domain.usedBy, ['app'])
  assert.equal(domain.entry, 'packages/domain/src/index.ts')
  const core = g.nodes.find(n => n.id === 'core')!
  assert.ok(core.status.includes('protected'))
  assert.deepEqual(core.adrs, ['ADR-0001'])
  const interfaces = JSON.parse(readFileSync(join(root, '.architecture/interfaces.json'), 'utf8'))
  assert.deepEqual(interfaces.find((i: { module: string }) => i.module === 'domain').exports, ['Order', 'OrderService', 'run'])
  assert.deepEqual(g.services.map(s => s.kind).sort(), ['bin', 'http-server', 'script'])
  for (const f of ['modules', 'dependencies', 'services', 'interfaces', 'dataflows', 'runtime', 'skills', 'changes', 'drift', 'graph']) {
    assert.ok(existsSync(join(root, '.architecture', `${f}.json`)), f)
  }
  assert.match(readFileSync(join(root, '.architecture/graph.mmd'), 'utf8'), /domain --> core/)
})

test('change impact: editing core impacts domain and app, plus their gates; graph auto-updates on code change', async () => {
  const root = monorepo()
  const obs = new Observatory()
  await obs.scan(root)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'arch')
  writeFileSync(join(root, 'packages/core/src/index.ts'), `export const VERSION = 2\nexport function util(): number { return VERSION }\n`)
  const g = await obs.scan(root)
  assert.deepEqual(g.changes.modules, ['core'])
  assert.deepEqual(g.changes.impacted, ['app', 'domain'])
  assert.deepEqual(g.changes.gates, ['e2e', 'unit-core', 'unit-domain'])
  assert.ok(g.nodes.find(n => n.id === 'core')!.status.includes('changing'))
  // A new import appears in the graph on the next scan.
  writeFiles(root, { 'packages/app/src/extra.ts': `import { VERSION } from '@acme/core'\nexport const v = VERSION\n` })
  const g2 = await obs.scan(root)
  assert.equal(g2.edges.find(x => x.from === 'app' && x.to === 'core')?.testOnly, false)
})

test('drift: cycle + layer violation fail the architecture gate; unregistered module warns; accepted drift downgrades', async () => {
  const root = monorepo()
  writeFiles(root, {
    'packages/core/src/bad.ts': `import { run } from '@acme/domain'\nexport const x = run\n`,
    'packages/extra/package.json': pkg('@acme/extra'),
    'packages/extra/src/index.ts': 'export const e = 1\n',
  })
  const obs = new Observatory()
  const g = await obs.scan(root)
  const kinds = g.drift.map(d => `${d.severity}:${d.kind}`).sort()
  assert.deepEqual(kinds, ['error:cycle', 'error:layer-violation', 'warn:unregistered-module'])
  const gate = await driftGateRunner(obs)({ id: 'arch', kind: 'architecture-drift', required: true }, { projectRoot: root })
  assert.equal(gate.status, 'fail')
  assert.match(gate.outputTail, /core \(core\) depends on higher layer domain/)
  // Human acknowledgement via declared.json → warn → gate passes.
  const declared = JSON.parse(readFileSync(join(root, '.architecture/declared.json'), 'utf8'))
  declared.acceptedDrift = ['cycle:core,domain', 'layer-violation:core,domain']
  writeFileSync(join(root, '.architecture/declared.json'), JSON.stringify(declared))
  const gate2 = await driftGateRunner(obs)({ id: 'arch', kind: 'architecture-drift', required: true }, { projectRoot: root })
  assert.equal(gate2.status, 'pass', gate2.outputTail)
})

test('directory fallback for projects without manifests', async () => {
  const root = gitRepo({
    'src/api/server.js': `import { q } from '../db/query.js'\nexport const s = q\n`,
    'src/db/query.js': `export const q = 1\n`,
    'src/main.js': `import { s } from './api/server.js'\nconsole.log(s)\n`,
  })
  const g = await new Observatory().scan(root, { write: false })
  assert.deepEqual(g.nodes.map(n => n.id).sort(), ['api', 'db', 'src'])
  assert.deepEqual(g.edges.map(e => `${e.from}->${e.to}`).sort(), ['api->db', 'src->api'])
})

test('graph algorithms', () => {
  const E = (from: string, to: string) => ({ from, to, weight: 1, typeOnly: false, testOnly: false, evidence: [] })
  assert.deepEqual(moduleCycles(['a', 'b', 'c'], [E('a', 'b'), E('b', 'a'), E('b', 'c')]), [['a', 'b']])
  assert.deepEqual(reverseClosure(['c'], [E('a', 'b'), E('b', 'c')]), ['a', 'b'])
  assert.deepEqual(changedFiles(tempDir()), [])
})

test('loop integration: receipts carry changed + impacted modules; worker activity shows on the map', async () => {
  const root = monorepo()
  writeFiles(root, { 'packages/core/test/core.test.js': `import test from 'node:test'\ntest('ok', () => {})\n` })
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'tests')
  const obs = new Observatory()
  await obs.scan(root)
  const store = new StateStore(tempDir('sa-home-'))
  let sawActive = false
  const engine = new LoopEngine({
    store, verifier: new Verifier(),
    architecture: observatoryHooks(obs),
    executor: new ScriptedExecutor(input => {
      writeFileSync(join(root, 'packages/domain/src/model.ts'), `export interface Order { id: string; total: number }\nexport class OrderService {}\n`)
      input.report({ kind: 'progress', current_state: 'editing', progress: 50, changed_modules: ['domain'], verification_result: 'not_run', blocker: null, next_action: null, human_required: false, summary: '' })
      const live = obs.withRuntime(root, {
        workers: store.listWorkers(input.project.id), receipts: [], latestReceiptIds: new Set(), taskStates: new Map([[input.task.id, 'executing']]),
      })!
      sawActive = live.nodes.find(n => n.id === 'domain')!.status.includes('worker-active')
    }),
  })
  const project = store.createProject({ name: 'mono', root, defaultGates: [{ id: 'unit', kind: 'command', command: 'node --test packages/core/test/*.test.js', required: true }] })
  const chief = new Chief(engine)
  const goal = chief.createGoal(project.id, 'add total')
  chief.addTask(project.id, goal.id, { title: 'add total to Order', instructions: '...' })
  const res = await chief.runGoal(project.id, goal.id)
  assert.equal(res.tasks[0]!.state, 'passed')
  const receipt = store.listReceipts(project.id)[0]!
  assert.deepEqual(receipt.changedModules, ['domain'])
  assert.deepEqual(receipt.impactedModules, ['app'])
  assert.ok(sawActive, 'domain should be worker-active during the attempt')
})

test('language adapter seam: Python imports become module edges (absolute, relative, src layout, stdlib ignored)', async () => {
  const root = gitRepo({
    'src/app/__init__.py': '',
    'src/app/main.py': 'import os\nfrom app.services import billing\nfrom .util import helper\n',
    'src/app/util.py': 'def helper():\n    return 1\n',
    'src/app/services/__init__.py': '',
    'src/app/services/billing.py': 'import json\nimport requests\nfrom app import util\n',
    'tests/test_billing.py': 'from app.services import billing\n',
    '.architecture/declared.json': JSON.stringify({ modules: [
      { id: 'app-core', paths: ['src/app/*.py'] }, { id: 'services', paths: ['src/app/services/**'] }, { id: 'tests', paths: ['tests/**'] },
    ] }),
  })
  const g = await new Observatory().scan(root, { write: false })
  const edges = g.edges.map(e => `${e.from}->${e.to}${e.testOnly ? ' (test)' : ''}`).sort()
  assert.deepEqual(edges, ['app-core->services', 'services->app-core', 'tests->services (test)'])
  assert.deepEqual(g.drift.map(d => d.kind), ['cycle'])
  const modules = JSON.parse(JSON.stringify(g.nodes.find(n => n.id === 'services')))
  assert.deepEqual(modules.usedBy.sort(), ['app-core', 'tests'])
})

test('stale graph is detected on live reads; the engine rescans before attributing a new module', async () => {
  const root = monorepo()
  const obs = new Observatory()
  await obs.scan(root)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'arch')
  await obs.scan(root)
  assert.equal(obs.withRuntime(root, undefined)!.freshness!.stale, false)
  writeFiles(root, { 'packages/billing/package.json': pkg('@acme/billing', ['@acme/core']), 'packages/billing/src/index.ts': `import { util } from '@acme/core'\nexport const b = util\n` })
  const live = obs.withRuntime(root, undefined)!
  assert.equal(live.freshness!.stale, true)
  assert.match(live.freshness!.reason, /changed|unmapped/)
  // Loop integration: a Worker that creates a new package gets it attributed correctly.
  const store = new StateStore(tempDir('sa-home-'))
  writeFiles(root, { 'packages/core/test/core.test.js': `import test from 'node:test'\ntest('ok', () => {})\n` })
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'billing')
  await obs.scan(root)
  const engine = new LoopEngine({ store, verifier: new Verifier(), architecture: observatoryHooks(obs), executor: new ScriptedExecutor(() => {
    writeFiles(root, { 'packages/audit/package.json': pkg('@acme/audit', ['@acme/core']), 'packages/audit/src/index.ts': `import { util } from '@acme/core'\nexport const a = util\n` })
  }) })
  const p = store.createProject({ name: 'mono', root, defaultGates: [{ id: 'unit', kind: 'command', command: 'node --test packages/core/test/*.test.js', required: true }] })
  const chief = new Chief(engine)
  const goal = chief.createGoal(p.id, 'audit')
  chief.addTask(p.id, goal.id, { title: 'add audit package', instructions: '...' })
  await chief.runGoal(p.id, goal.id)
  assert.deepEqual(store.listReceipts(p.id)[0]!.changedModules, ['audit'])
})
