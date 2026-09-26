import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '@superagent/testkit'
import { hiddenPaths, readIsolation, sandboxed } from '../src/index.ts'

test('read isolation: secrets, held-out tests and backups are hidden from model sessions; the project is not', t => {
  const home = tempDir('sa-home-')
  const userHome = tempDir('sa-user-')
  for (const d of ['secrets', 'heldout', 'backups', 'runtime']) mkdirSync(join(home, d))
  writeFileSync(join(home, 'secrets', 'agent-token'), 'tok')
  writeFileSync(join(home, 'heldout', 'hidden.test.js'), 'x')
  const paths = hiddenPaths(home, userHome)
  assert.deepEqual(paths, ['secrets', 'heldout', 'backups'].map(d => join(home, d)), 'only existing paths; runtime stays visible')
  assert.deepEqual(sandboxed('dsh', ['--json'], []), ['dsh', ['--json']], 'nothing to hide: no wrapper')

  if (!readIsolation().available) { t.skip('bubblewrap not usable here'); return }
  const project = tempDir('sa-proj-')
  writeFileSync(join(project, 'a.txt'), 'visible')
  const [bin, argv] = sandboxed('sh', ['-c', `cat ${join(home, 'secrets', 'agent-token')}; ls ${join(home, 'heldout')}; cat a.txt`], paths)
  const r = spawnSync(bin, argv, { cwd: project, encoding: 'utf8' })
  assert.doesNotMatch(r.stdout, /tok|hidden/)
  assert.match(r.stdout, /visible/)
})
