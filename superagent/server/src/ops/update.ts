/**
 * Update / Rollback for a managed install:
 *
 *   <base>/source/            git clone of the SuperAgent repository
 *   <base>/releases/<id>/     one git worktree per installed version (built in place)
 *   <base>/current -> releases/<id>   what the service runs (systemd ExecStart)
 *   <base>/releases.json      current / previous / pending verification / history
 *
 * Update = fetch → new worktree next to the running one → install + build + verify there
 * → automatic state backup → atomic `current` switch → supervised restart. The new
 * version verifies itself on start (`verifyAfterStart`); if it is red it switches back to
 * the previous release and restarts again. Rollback is the same switch, on demand.
 * The running release is never modified in place.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { STATE_SCHEMA_VERSION } from '@superagent/project-state'

export class UpdateError extends Error {}

export interface ReleaseInfo { readonly id: string; readonly version?: string; readonly commit: string; readonly ref?: string; readonly installedAt: string; readonly schema: number }
export interface ReleasesState {
  current?: string
  previous?: string
  /** Set by an update; cleared by the new release once it verified itself. */
  pendingVerify?: { id: string; previous?: string; since: string; backup?: string }
  releases: Record<string, ReleaseInfo>
  history: Array<{ at: string; action: 'install' | 'update' | 'rollback' | 'auto-rollback' | 'verified'; from?: string; to?: string; note?: string }>
}

export interface UpdateJob {
  readonly id: string
  status: 'running' | 'switched' | 'failed'
  step: string
  readonly target: string
  readonly log: string
  error?: string
  release?: string
}

export interface UpdateOptions {
  /** Install base (the directory holding source/, releases/, current). */
  readonly base: string
  /** Build + verify commands run inside the new release (default: install, build, typecheck). */
  readonly steps?: ReadonlyArray<readonly string[]>
  /** State home, for the pre-update backup. */
  readonly home: string
  readonly backup?: (label: string) => string
  /** Called after a switch; supervised servers exit so systemd starts the new release. */
  readonly restart?: () => void
}

export const DEFAULT_STEPS: ReadonlyArray<readonly string[]> = [
  ['pnpm', 'install', '--frozen-lockfile'],
  ['pnpm', 'build'],
  ['pnpm', '-s', 'typecheck'],
]

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim()
const now = () => new Date().toISOString()

/** Base of the managed install that contains `repoRoot`, if it runs from one. */
export function managedBase(repoRoot: string): string | undefined {
  let real: string
  try {
    real = realpathSync(repoRoot)
  } catch (gone) {
    void gone
    return undefined
  }
  const releases = dirname(real)
  if (basename(releases) !== 'releases') return undefined
  const base = dirname(releases)
  return existsSync(join(base, 'releases.json')) ? base : undefined
}

/** Schema version a release understands (read from its source; 1 if absent). */
export function releaseSchema(dir: string): number {
  const f = join(dir, 'superagent', 'plugins', 'project-state', 'src', 'store.ts')
  if (!existsSync(f)) return 1
  const m = /STATE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(readFileSync(f, 'utf8'))
  return m ? Number(m[1]) : 1
}

function releaseVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version
  } catch (absent) {
    void absent
    return undefined
  }
}

const versionKey = (v: string) => v.replace(/^[^\d]*/, '').split(/[.-]/).map(x => (/^\d+$/.test(x) ? x.padStart(6, '0') : x)).join('.')

export class UpdateManager {
  readonly base: string
  private readonly o: UpdateOptions
  private job?: UpdateJob
  /** Resolves when the running update job ends (tests, CLI). */
  done: Promise<void> = Promise.resolve()

  constructor(options: UpdateOptions) {
    this.o = options
    this.base = options.base
  }

  private get file() { return join(this.base, 'releases.json') }
  private get source() { return join(this.base, 'source') }

  state(): ReleasesState {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as ReleasesState : { releases: {}, history: [] }
  }

  private save(s: ReleasesState): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(s, null, 2)}\n`)
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** Create the managed layout from a git URL/path and check out `ref` as the first release. */
  static install(base: string, from: string, ref?: string, steps: ReadonlyArray<readonly string[]> = DEFAULT_STEPS): UpdateManager {
    if (existsSync(join(base, 'releases.json'))) throw new UpdateError(`${base} is already a managed install`)
    mkdirSync(join(base, 'releases'), { recursive: true })
    execFileSync('git', ['clone', '--quiet', from, join(base, 'source')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const m = new UpdateManager({ base, home: '', steps })
    m.save({ releases: {}, history: [] })
    const sha = git(m.source, ['rev-parse', `${ref ?? 'HEAD'}^{commit}`])
    const id = m.addRelease(sha, ref)
    m.runSteps(join(base, 'releases', id), steps, join(base, 'install.log'))
    m.switchTo(id)
    const s = m.state()
    s.history.push({ at: now(), action: 'install', to: id })
    m.save(s)
    return m
  }

  /** Fetch and list versions newer than the current one (tags) plus the branch head. */
  check(): { current?: ReleaseInfo; available: Array<{ ref: string; commit: string; version?: string; newer: boolean }> } {
    git(this.source, ['fetch', '--quiet', '--tags', '--force', 'origin'])
    const s = this.state()
    const cur = s.current ? s.releases[s.current] : undefined
    const tags = git(this.source, ['tag', '--list']).split('\n').filter(t => /\d+\.\d+/.test(t))
    const available = tags.map(t => {
      const commit = git(this.source, ['rev-parse', `${t}^{commit}`])
      return { ref: t, commit, version: t.replace(/^[^\d]*/, ''), newer: !cur || (commit !== cur.commit && versionKey(t) > versionKey(cur.version ?? cur.ref ?? '0')) }
    }).sort((a, b) => versionKey(b.ref).localeCompare(versionKey(a.ref)))
    return { current: cur, available }
  }

  status(): { managed: true; base: string; state: ReleasesState; job?: UpdateJob } {
    return { managed: true, base: this.base, state: this.state(), job: this.job }
  }

  private addRelease(sha: string, ref?: string): string {
    const version = (() => { try { return JSON.parse(git(this.source, ['show', `${sha}:package.json`])).version as string } catch (absent) { void absent; return undefined } })()
    const id = `${version ?? 'rev'}-${sha.slice(0, 7)}`
    const dir = join(this.base, 'releases', id)
    if (!existsSync(dir)) git(this.source, ['worktree', 'add', '--detach', '--force', dir, sha])
    const s = this.state()
    s.releases[id] = { id, version, commit: sha, ref, installedAt: now(), schema: releaseSchema(dir) }
    this.save(s)
    return id
  }

  private runSteps(dir: string, steps: ReadonlyArray<readonly string[]>, log: string, onStep?: (s: string) => void): void {
    for (const [cmd, ...args] of steps) {
      const label = [cmd, ...args].join(' ')
      onStep?.(label)
      appendFileSync(log, `\n$ ${label}\n`)
      try {
        const out = execFileSync(cmd!, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: '1' } })
        appendFileSync(log, out)
      } catch (error) {
        const e = error as { stdout?: Buffer; stderr?: Buffer; message: string }
        appendFileSync(log, `${e.stdout ?? ''}${e.stderr ?? ''}\n`)
        throw new UpdateError(`"${label}" failed: ${String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' ')}`)
      }
    }
  }

  /** Same as runSteps, without blocking the event loop (the server keeps serving). */
  private async runStepsAsync(dir: string, steps: ReadonlyArray<readonly string[]>, log: string, onStep?: (s: string) => void): Promise<void> {
    for (const [cmd, ...args] of steps) {
      const label = [cmd, ...args].join(' ')
      onStep?.(label)
      appendFileSync(log, `\n$ ${label}\n`)
      const { code, tail } = await new Promise<{ code: number | null; tail: string }>(resolve => {
        const child = spawn(cmd!, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } })
        let tail = ''
        const onData = (b: Buffer) => { appendFileSync(log, b); tail = (tail + String(b)).slice(-2000) }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('error', e => { tail += String(e); })
        child.on('close', c => resolve({ code: c, tail }))
      })
      if (code !== 0) throw new UpdateError(`"${label}" failed (exit ${code}): ${tail.trim().split('\n').slice(-3).join(' ')}`)
    }
  }

  /** Atomically point `current` at a release. */
  private switchTo(id: string): void {
    const s = this.state()
    if (!s.releases[id] || !existsSync(join(this.base, 'releases', id))) throw new UpdateError(`release ${id} is not installed`)
    const link = join(this.base, 'current')
    const tmp = join(this.base, `.current-${process.pid}`)
    rmSync(tmp, { force: true })
    symlinkSync(join('releases', id), tmp)
    renameSync(tmp, link)
    if (s.current !== id) s.previous = s.current
    s.current = id
    this.save(s)
  }

  currentTarget(): string | undefined {
    const link = join(this.base, 'current')
    return existsSync(link) && lstatSync(link).isSymbolicLink() ? basename(readlinkSync(link)) : undefined
  }

  /**
   * Start an update in the background (poll `status().job`). Refuses when `busy` says work
   * is running, or when the target cannot read the current state format.
   */
  startUpdate(ref: string, busy?: string): UpdateJob {
    if (this.job?.status === 'running') throw new UpdateError('an update is already running')
    if (busy) throw new UpdateError(`cannot update while ${busy}`)
    mkdirSync(join(this.base, 'logs'), { recursive: true })
    const log = join(this.base, 'logs', `update-${Date.now()}.log`)
    const job: UpdateJob = { id: `upd-${Date.now()}`, status: 'running', step: 'preparing', target: ref, log }
    this.job = job
    // Runs in the background; the HTTP response returns immediately.
    this.done = (async () => {
      try {
        job.step = 'fetching'
        git(this.source, ['fetch', '--quiet', '--tags', '--force', 'origin'])
        const sha = git(this.source, ['rev-parse', `${ref}^{commit}`])
        const s0 = this.state()
        if (s0.current && s0.releases[s0.current]?.commit === sha) throw new UpdateError(`${ref} is already running`)
        job.step = 'checking out'
        const id = this.addRelease(sha, ref)
        job.release = id
        const homeSchema = this.homeSchema()
        const schema = this.state().releases[id]!.schema
        if (schema < homeSchema) throw new UpdateError(`${ref} understands state format ${schema}, your state is format ${homeSchema}`)
        await this.runStepsAsync(join(this.base, 'releases', id), this.o.steps ?? DEFAULT_STEPS, log, s => { job.step = s })
        job.step = 'backing up state'
        const backup = this.o.backup?.(`pre-update-${id}`)
        job.step = 'switching'
        const previous = this.state().current
        this.switchTo(id)
        const s = this.state()
        s.pendingVerify = { id, previous, since: now(), backup }
        s.history.push({ at: now(), action: 'update', from: previous, to: id, note: backup ? `backup ${backup}` : undefined })
        this.save(s)
        job.status = 'switched'
        job.step = 'restarting'
        this.o.restart?.()
      } catch (error) {
        job.status = 'failed'
        job.error = String((error as Error).message ?? error)
        appendFileSync(log, `\nFAILED: ${job.error}\n`)
        // A half-built release is removed; the running one was never touched.
        if (job.release && this.state().current !== job.release) this.removeRelease(job.release)
      }
    })()
    return job
  }

  private homeSchema(): number {
    try {
      return (JSON.parse(readFileSync(join(this.o.home, 'state-version.json'), 'utf8')) as { schema?: number }).schema ?? 1
    } catch (absent) {
      void absent
      return STATE_SCHEMA_VERSION
    }
  }

  /** Switch back to the previous release (then restart). */
  rollback(busy?: string, note = 'manual'): string {
    if (busy) throw new UpdateError(`cannot roll back while ${busy}`)
    const s = this.state()
    if (!s.previous) throw new UpdateError('no previous release to roll back to')
    const target = s.previous
    if ((s.releases[target]?.schema ?? 1) < this.homeSchema()) throw new UpdateError(`${target} cannot read the current state format; restore the pre-update backup first`)
    const from = s.current
    this.switchTo(target)
    const after = this.state()
    after.pendingVerify = undefined
    after.history.push({ at: now(), action: note === 'auto' ? 'auto-rollback' : 'rollback', from, to: target, note })
    this.save(after)
    this.o.restart?.()
    return target
  }

  /**
   * Run by a freshly started release: if it is the pending one, keep it when `healthy`,
   * otherwise switch back and restart into the previous release.
   */
  verifyAfterStart(runningId: string, healthy: boolean, detail = ''): 'not-pending' | 'verified' | 'rolled-back' {
    const s = this.state()
    if (s.pendingVerify?.id !== runningId) return 'not-pending'
    if (healthy) {
      s.pendingVerify = undefined
      s.history.push({ at: now(), action: 'verified', to: runningId })
      this.save(s)
      return 'verified'
    }
    this.rollback(undefined, 'auto')
    const after = this.state()
    after.history[after.history.length - 1]!.note = `new release failed its start-up check: ${detail}`.slice(0, 500)
    this.save(after)
    return 'rolled-back'
  }

  /** Remove installed releases except current and previous (keep the newest `keep`). */
  prune(keep = 3): string[] {
    const s = this.state()
    const ids = Object.values(s.releases).sort((a, b) => b.installedAt.localeCompare(a.installedAt)).map(r => r.id)
    const removable = ids.filter(id => id !== s.current && id !== s.previous).slice(Math.max(0, keep - 2))
    for (const id of removable) this.removeRelease(id)
    return removable
  }

  private removeRelease(id: string): void {
    const dir = join(this.base, 'releases', id)
    try {
      git(this.source, ['worktree', 'remove', '--force', dir])
    } catch (notWorktree) {
      void notWorktree
      rmSync(dir, { recursive: true, force: true })
    }
    const s = this.state()
    delete s.releases[id]
    this.save(s)
  }
}

/** True when a supervisor (systemd) will start us again after we exit. */
export function isSupervised(): boolean {
  return process.env.SUPERAGENT_SUPERVISED === '1' || !!process.env.INVOCATION_ID
}

/** Exit so the supervisor restarts the service (after the HTTP response is flushed). */
export function scheduleRestart(delayMs = 400): void {
  setTimeout(() => process.exit(75), delayMs).unref?.()
}

/** systemd user unit for `sa serve` from the managed install. */
export function systemdUnit(opts: { base: string; home?: string; host?: string; port?: number; node?: string; browser?: boolean }): string {
  const node = opts.node ?? process.execPath
  const args = ['serve', '--host', opts.host ?? '127.0.0.1', '--port', String(opts.port ?? 7788), ...(opts.browser ? ['--browser'] : [])]
  return [
    '[Unit]',
    'Description=DGX Super Agent',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${join(opts.base, 'current')}`,
    `ExecStart=${node} ${join(opts.base, 'current', 'superagent', 'cli', 'src', 'main.ts')} ${args.join(' ')}`,
    'Environment=SUPERAGENT_SUPERVISED=1',
    ...(opts.home ? [`Environment=SUPERAGENT_HOME=${opts.home}`] : []),
    '# Put SUPERAGENT_HUMAN_TOKEN (and provider keys if you prefer env) here, mode 0600:',
    'EnvironmentFile=-%h/.config/superagent/env',
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

