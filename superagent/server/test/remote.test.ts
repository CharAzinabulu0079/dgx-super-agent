import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedExecutor } from '@superagent/chief-worker'
import { tempDir } from '@superagent/testkit'
import { createRuntime, startServer } from '../src/index.ts'
import { listAddresses, setServiceHost, systemdUnit } from '../src/ops/index.ts'

test('remote access: the unit drops --host once, the env file carries SUPERAGENT_HOST; only own addresses', () => {
  const dir = tempDir('sa-remote-')
  const paths = { envFile: join(dir, 'env'), unitFile: join(dir, 'superagent.service') }
  const unit = systemdUnit({ base: '/b', host: '127.0.0.1', browser: true })
  writeFileSync(paths.unitFile, unit)
  assert.throws(() => setServiceHost('127.0.0.1', paths, false), /stable SUPERAGENT_HUMAN_TOKEN/)
  writeFileSync(paths.envFile, 'SUPERAGENT_HUMAN_TOKEN=abcdefghijklmnopqrstuvwxyz\n')
  assert.throws(() => setServiceHost('8.8.8.8', paths, false), /not an address of this machine/)
  const lan = listAddresses().find(a => a.kind === 'lan' || a.kind === 'vpn' || a.kind === 'other')?.address ?? '0.0.0.0'
  assert.equal(setServiceHost(lan, paths, false), true)
  assert.match(readFileSync(paths.envFile, 'utf8'), new RegExp(`^SUPERAGENT_HOST=${lan.replace(/\./g, '\\.')}$`, 'm'))
  assert.match(readFileSync(paths.envFile, 'utf8'), /SUPERAGENT_HUMAN_TOKEN=abc/, 'the token line is kept')
  const after = readFileSync(paths.unitFile, 'utf8')
  assert.doesNotMatch(after, /--host/)
  assert.match(after, /serve --port 7788 --browser/)
  setServiceHost('127.0.0.1', paths, false)
  assert.equal(readFileSync(paths.envFile, 'utf8').match(/SUPERAGENT_HOST=/g)!.length, 1, 'replaced, not appended')
  assert.doesNotMatch(systemdUnit({ base: '/b' }), /--host/, 'new units read the host from the env file')
})

test('remote access API: human only; links carry the token only for addresses the server listens on', async () => {
  const server = await startServer({ runtime: createRuntime({ home: tempDir('sa-home-'), executor: new ScriptedExecutor(() => {}) }), port: 0, humanToken: 'h'.repeat(24) })
  try {
    const anon = await fetch(`${server.url}/api/system/remote`)
    assert.equal(anon.status, 401)
    const r = await (await fetch(`${server.url}/api/system/remote`, { headers: { authorization: `Bearer ${'h'.repeat(24)}` } })).json()
    assert.equal(r.host, '127.0.0.1')
    const lo = r.addresses.find((a: any) => a.address === '127.0.0.1')
    assert.match(lo.link, /^http:\/\/127\.0\.0\.1:\d+\/\?token=h{24}$/)
    assert.ok(r.addresses.filter((a: any) => a.address !== '127.0.0.1').every((a: any) => !a.link), 'not listening there → no link')
  } finally {
    await server.close()
  }
})
