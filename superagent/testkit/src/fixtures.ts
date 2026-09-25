/** Temporary git project fixtures for loop/verifier/observatory tests. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function tempDir(prefix = 'sa-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString('utf8')
}

/** Create a committed git repo containing `files`. */
export function gitRepo(files: Record<string, string>, prefix = 'sa-repo-'): string {
  const root = tempDir(prefix)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@superagent.local')
  git(root, 'config', 'user.name', 'SuperAgent Test')
  writeFiles(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'fixture')
  return root
}

export const BUGGY_CALC = `export function add(a, b) { return a - b }\n`
export const FIXED_CALC = `export function add(a, b) { return a + b }\n`

/** A tiny project whose `node --test` gate fails until `src/calc.js` is fixed. */
export function calcProject(): string {
  return gitRepo({
    'package.json': JSON.stringify({ name: 'calc', type: 'module', private: true }, null, 2),
    'src/calc.js': BUGGY_CALC,
    'test/calc.test.js': `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.js'\ntest('add', () => { assert.equal(add(2, 3), 5) })\n`,
  })
}

export const NODE_TEST_GATE = { id: 'unit', kind: 'command', command: 'node --test', required: true, parser: 'node-test', timeoutMs: 60_000 } as const
