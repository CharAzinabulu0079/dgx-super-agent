/**
 * Project Add wizard: pick a folder on the server, scan it (no model involved), review the
 * proposed checks, create. Detection only *proposes*; the human confirms (Gate Registry).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseGateSpec, type GateSpec } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'
import { detectGates } from '../project-setup.ts'

export class ScanError extends Error {}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache', 'coverage', '.architecture', '.superagent-tmp'])
const LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C/C++', '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#',
  '.rb': 'Ruby', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.sql': 'SQL', '.sh': 'Shell',
}

export interface ProposedGate { readonly spec: GateSpec; readonly reason: string; readonly recommended: boolean }

export interface ProjectScan {
  readonly root: string
  readonly name: string
  readonly registeredAs?: string
  readonly git: { readonly isRepo: boolean; readonly branch?: string; readonly dirty?: number; readonly hasCommits?: boolean; readonly remote?: string }
  readonly languages: ReadonlyArray<{ readonly name: string; readonly files: number }>
  readonly files: number
  readonly truncated: boolean
  readonly packageManager?: string
  readonly gates: readonly ProposedGate[]
  readonly browser: { readonly needed: boolean; readonly reason?: string }
  readonly architecture: { readonly declared: boolean; readonly graph: boolean }
  readonly warnings: string[]
}

function walk(root: string, limit: number): { counts: Map<string, number>; files: number; truncated: boolean } {
  const counts = new Map<string, number>()
  let files = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (unreadable) {
      void unreadable
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(join(dir, e.name)); continue }
      if (!e.isFile()) continue
      if (++files > limit) return { counts, files: limit, truncated: true }
      const lang = LANG[extname(e.name).toLowerCase()]
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1)
    }
  }
  return { counts, files, truncated: false }
}

const gitOut = (root: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
  } catch (noGit) {
    void noGit
    return undefined
  }
}

export function scanProject(rootInput: string, store?: StateStore): ProjectScan {
  const root = resolve(rootInput)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ScanError(`${root} is not a folder`)
  const warnings: string[] = []
  const isRepo = gitOut(root, ['rev-parse', '--show-toplevel']) === root
  const insideOther = !isRepo && gitOut(root, ['rev-parse', '--is-inside-work-tree']) === 'true'
  const git = isRepo ? {
    isRepo, branch: gitOut(root, ['branch', '--show-current']) || undefined,
    dirty: (gitOut(root, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length,
    hasCommits: gitOut(root, ['rev-parse', '--verify', '-q', 'HEAD']) !== undefined,
    remote: gitOut(root, ['remote', 'get-url', 'origin']),
  } : { isRepo }
  if (!isRepo) warnings.push(insideOther ? 'this folder is inside another git repository — register the repository root instead' : 'not a git repository — verification needs git (use “Initialize git”)')
  if (isRepo && git.dirty) warnings.push(`${git.dirty} uncommitted change(s) — Workers start from the current tree; consider committing first`)
  const { counts, files, truncated } = walk(root, 20_000)
  if (truncated) warnings.push('large repository: scan stopped at 20,000 files')
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, files: n }))
  const has = (f: string) => existsSync(join(root, f))
  const packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : has('package-lock.json') ? 'npm'
    : has('uv.lock') ? 'uv' : has('poetry.lock') ? 'poetry' : has('requirements.txt') ? 'pip' : has('Cargo.lock') || has('Cargo.toml') ? 'cargo' : has('go.mod') ? 'go' : has('package.json') ? 'npm' : undefined

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
  try { if (has('package.json')) pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch (bad) { void bad; warnings.push('package.json is not valid JSON') }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const run = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : packageManager === 'bun' ? 'bun run' : 'npm run'

  const gates: ProposedGate[] = detectGates(root).map(spec => ({
    spec, recommended: true,
    reason: spec.kind === 'architecture-drift' ? 'architecture drift (layers, cycles) — always available'
      : spec.kind === 'e2e' ? 'Playwright config found' : `test command detected (${spec.command})`,
  }))
  if (pkg.scripts?.build) gates.push({ spec: parseGateSpec({ id: 'build', kind: 'command', command: `${run} build`, timeoutMs: 900_000 }), reason: 'package.json has a build script', recommended: false })
  if (pkg.scripts?.lint) gates.push({ spec: parseGateSpec({ id: 'lint', kind: 'command', command: `${run} lint`, timeoutMs: 600_000 }), reason: 'package.json has a lint script', recommended: false })
  if (pkg.scripts?.typecheck) gates.push({ spec: parseGateSpec({ id: 'typecheck', kind: 'command', command: `${run} typecheck`, timeoutMs: 600_000 }), reason: 'package.json has a typecheck script', recommended: false })
  if (!gates.some(g => g.spec.kind === 'command' || g.spec.kind === 'e2e')) warnings.push('no test command found — add one, or tasks are only checked for architecture drift')

  const playwright = readdirSync(root).some(n => /^playwright\.config\./.test(n)) || !!deps['@playwright/test'] || !!deps.playwright
  const cypress = readdirSync(root).some(n => /^cypress\.config\./.test(n)) || !!deps.cypress
  const web = !!(deps.react || deps.vue || deps.svelte || deps.next || deps.vite)
  const browser = playwright ? { needed: true, reason: 'Playwright tests' } : cypress ? { needed: true, reason: 'Cypress tests' } : web ? { needed: false, reason: 'web front end — browser Workers can help with UI tasks' } : { needed: false }

  const registeredAs = store?.listProjects().find(p => resolve(p.root) === root)?.id
  if (registeredAs) warnings.push(`already registered as “${registeredAs}”`)
  return {
    root, name: basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project', registeredAs,
    git, languages, files, truncated, packageManager, gates, browser,
    architecture: { declared: has('.architecture/declared.json'), graph: has('.architecture/graph.json') },
    warnings,
  }
}

/** Folders under `path` for the server-side picker (no files; hidden folders only on request). */
export function listDirs(path: string | undefined, showHidden = false): { path: string; parent?: string; home: string; entries: Array<{ name: string; path: string; git: boolean }> } {
  const dir = resolve(path || homedir())
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ScanError(`${dir} is not a folder`)
  let names: string[] = []
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && (showHidden || !e.name.startsWith('.')) && e.name !== 'node_modules').map(e => e.name).sort((a, b) => a.localeCompare(b))
  } catch (unreadable) {
    throw new ScanError(`cannot read ${dir}: ${(unreadable as Error).message}`)
  }
  return {
    path: dir, parent: dir === '/' ? undefined : dirname(dir), home: homedir(),
    entries: names.slice(0, 500).map(n => ({ name: n, path: join(dir, n), git: existsSync(join(dir, n, '.git')) })),
  }
}

/** `git init` + first commit (human action from the wizard). */
export function initGit(rootInput: string): void {
  const root = resolve(rootInput)
  if (!existsSync(root)) throw new ScanError(`${root} does not exist`)
  if (existsSync(join(root, '.git'))) throw new ScanError('already a git repository')
  const env = { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'SuperAgent', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'superagent@localhost', GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'SuperAgent', GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'superagent@localhost' }
  execFileSync('git', ['init', '-q'], { cwd: root, env })
  execFileSync('git', ['add', '-A'], { cwd: root, env })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Initial commit (SuperAgent)'], { cwd: root, env })
}
