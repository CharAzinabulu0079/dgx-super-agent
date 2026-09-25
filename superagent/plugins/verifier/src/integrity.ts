/**
 * Verification integrity (Directive §4.A): make it hard for the Worker under
 * evaluation to manufacture a PASS by changing what verifies it.
 *
 * - Change detection uses git *snapshot commits* of the whole working tree
 *   (tracked + untracked-not-ignored) taken before and after the attempt via a
 *   temporary index, so Worker commits, resets or checkouts cannot hide edits and
 *   the user's HEAD/index are never touched.
 * - Verification assets (tests, runner configs, gate scripts, env files) and
 *   `package.json#scripts` may not change unless a human granted it.
 * - Ignored environment roots (node_modules, virtualenvs) may not change unless a
 *   lockfile changed too. Detection uses ctime, which `touch -d` cannot backdate.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { GateSpec, IntegrityFinding, IntegrityReport, TaskGrants, VerificationPolicy } from '@superagent/contracts'

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  protectedPaths: [
    '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/e2e/**',
    '**/playwright.config.*', '**/vitest.config.*', '**/vitest.workspace.*', '**/jest.config.*', '**/.mocharc*', '**/karma.conf.*',
    '**/conftest.py', '**/pytest.ini', '**/tox.ini', '**/setup.cfg', '**/noxfile.py',
    '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml', '**/.pnpmfile.cjs', '**/.env', '**/.env.*', '**/.node-options',
    '.superagent/**', '.architecture/declared.json', '.github/workflows/**', '.git/hooks/**',
  ],
  envRoots: ['node_modules', '.venv', 'venv', '.tox'],
  lockfiles: ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock'],
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'SuperAgent', GIT_AUTHOR_EMAIL: 'superagent@localhost',
  GIT_COMMITTER_NAME: 'SuperAgent', GIT_COMMITTER_EMAIL: 'superagent@localhost',
}

function git(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
}

export function isGitWorkTree(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch (notRepo) {
    void notRepo
    return false
  }
}

export function headOf(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || undefined
  } catch (noCommits) {
    void noCommits
    return undefined
  }
}

/**
 * Commit the full working tree state (tracked + untracked, honoring .gitignore)
 * without touching HEAD or the index, and pin it under `refs/superagent/<ref>`.
 * @returns the snapshot commit sha.
 */
export function snapshotCommit(root: string, ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-idx-'))
  const env = { ...GIT_IDENTITY, GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const head = headOf(root)
    if (head) git(root, ['read-tree', head], env)
    git(root, ['add', '-A', '--', '.'], env)
    const tree = git(root, ['write-tree'], env).trim()
    const commit = git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `superagent snapshot ${ref}`], env).trim()
    git(root, ['update-ref', `refs/superagent/${ref}`, commit])
    return commit
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function changedBetween(root: string, a: string, b: string): string[] {
  return git(root, ['diff', '--name-only', '-z', '--no-renames', a, b]).split('\0').filter(Boolean).sort()
}

function fileAt(root: string, commit: string, path: string): string | undefined {
  try {
    return git(root, ['show', `${commit}:${path}`])
  } catch (absent) {
    void absent
    return undefined
  }
}

function scriptsOf(json: string | undefined): string {
  if (json === undefined) return '{}'
  try {
    return JSON.stringify((JSON.parse(json) as { scripts?: unknown }).scripts ?? {})
  } catch (invalid) {
    void invalid
    return '<unparseable>'
  }
}

/**
 * Start-of-attempt marker; its mtime is compared against files' ctime. File
 * timestamps come from a coarse kernel clock (a few ms per tick), so we wait for
 * the clock to move past the marker: a write in the same tick would otherwise
 * carry an equal, not newer, ctime and go unnoticed.
 */
export function createMarker(dir: string): string {
  const marker = join(dir, `attempt-marker-${process.pid}-${Date.now()}`)
  writeFileSync(marker, '')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  return marker
}

/** Tool caches legitimately rewritten by ordinary test/build runs inside env roots. */
const ENV_CACHE = /(^|\/)(\.cache|\.vite|\.vitest|\.tmp|__pycache__|\.pytest_cache)(\/|$)|\.pyc$/

/** Files under ignored environment roots whose inode changed after the marker. */
export function environmentChanges(root: string, envRoots: readonly string[], marker: string): string[] {
  const out: string[] = []
  for (const r of envRoots) {
    const abs = join(root, r)
    if (!existsSync(abs)) continue
    let listing = ''
    try {
      listing = execFileSync('find', [abs, '-cnewer', marker, '-not', '-type', 'd', '-print'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
    } catch (partial) {
      // find exits non-zero on unreadable entries but still prints what it saw.
      listing = String((partial as { stdout?: Buffer }).stdout ?? '')
    }
    for (const f of listing.split('\n')) if (f && !ENV_CACHE.test(f)) out.push(f.slice(root.length + 1))
  }
  return out.sort()
}

export interface IntegrityInput {
  readonly root: string
  readonly baseSnapshot?: string
  readonly afterSnapshot?: string
  readonly headBefore?: string
  readonly marker?: string
  readonly gates: readonly GateSpec[]
  readonly policy?: VerificationPolicy
  readonly grants?: TaskGrants
}

/** Compute integrity findings for one attempt (pure w.r.t. the repository). */
export function checkIntegrity(input: IntegrityInput): IntegrityReport {
  const policy = input.policy ?? DEFAULT_VERIFICATION_POLICY
  const findings: IntegrityFinding[] = []
  if (!input.baseSnapshot || !input.afterSnapshot) {
    return { findings: [{ kind: 'not-a-git-repository', severity: 'block', paths: [], detail: 'no git snapshots: verification integrity cannot be established (fail closed)' }] }
  }
  const changed = changedBetween(input.root, input.baseSnapshot, input.afterSnapshot)
  const assetGlobs = [...policy.protectedPaths, ...input.gates.flatMap(g => g.assets ?? [])]
  const isAsset = picomatch(assetGlobs, { dot: true })
  const severity = input.grants?.mayModifyVerification ? 'review' as const : 'block' as const
  const assets = changed.filter(f => isAsset(f))
  if (assets.length) {
    findings.push({ kind: 'verification-asset-modified', severity, paths: assets, detail: `Worker changed verification assets: ${assets.join(', ')}` })
  }
  const scripts = changed.filter(f => f === 'package.json' || f.endsWith('/package.json'))
    .filter(f => scriptsOf(fileAt(input.root, input.baseSnapshot!, f)) !== scriptsOf(fileAt(input.root, input.afterSnapshot!, f)))
  if (scripts.length) {
    findings.push({ kind: 'package-scripts-modified', severity, paths: scripts, detail: `Worker changed package.json "scripts" in ${scripts.join(', ')}` })
  }
  if (input.marker) {
    const env = environmentChanges(input.root, policy.envRoots, input.marker)
    if (env.length) {
      const isLock = picomatch(policy.lockfiles.flatMap(l => [l, `**/${l}`]), { dot: true })
      const lockChanged = changed.filter(f => isLock(f))
      const sample = env.slice(0, 20)
      if (lockChanged.length) {
        findings.push({ kind: 'dependencies-changed', severity: 'info', paths: [...lockChanged, ...sample], detail: `dependencies changed with lockfile(s) ${lockChanged.join(', ')} (${env.length} environment files)` })
      } else {
        findings.push({ kind: 'environment-modified', severity: 'block', paths: sample, detail: `${env.length} file(s) in ignored environment roots changed without a lockfile change` })
      }
    }
  }
  const headAfter = headOf(input.root)
  if (input.headBefore !== headAfter) {
    findings.push({ kind: 'head-moved', severity: 'info', paths: [], detail: `HEAD moved during the attempt (${input.headBefore ?? 'none'} → ${headAfter ?? 'none'}); verification used the full-tree snapshot` })
  }
  return { baseSnapshot: input.baseSnapshot, afterSnapshot: input.afterSnapshot, findings }
}

/** Exported for tests / tools: whether a path is a protected verification asset. */
export function isVerificationAsset(path: string, gates: readonly GateSpec[] = [], policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY): boolean {
  return picomatch([...policy.protectedPaths, ...gates.flatMap(g => g.assets ?? [])], { dot: true })(path)
}
