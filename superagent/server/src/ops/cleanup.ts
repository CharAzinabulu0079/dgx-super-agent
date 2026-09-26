/**
 * Cleanup: keep a long-running install from rotting. Preview first, then apply chosen kinds.
 * Nothing that running work, open tasks or pending learning evaluations still need is touched.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TERMINAL_TASK_STATES } from '@superagent/contracts'
import { processAlive, type StateStore } from '@superagent/project-state'
import type { LoopEngine } from '@superagent/chief-worker'
import { listBackups, deleteBackup } from './backup.ts'
import type { UpdateManager } from './update.ts'

export type CleanupKind = 'orphan-workers' | 'stale-leases' | 'snapshot-refs' | 'worker-logs' | 'command-logs' | 'temp' | 'old-backups' | 'restore-leftovers' | 'old-releases'
export const CLEANUP_KINDS: readonly CleanupKind[] = ['orphan-workers', 'stale-leases', 'snapshot-refs', 'worker-logs', 'command-logs', 'temp', 'old-backups', 'restore-leftovers', 'old-releases']

export interface CleanupContext {
  readonly store: StateStore
  readonly engine: LoopEngine
  readonly update?: UpdateManager
  /** Logs / refs / leftovers older than this many days go (default 14). */
  readonly days?: number
  readonly keepBackups?: number
  readonly keepReleases?: number
  /** Learning candidates still awaiting evaluation (their task snapshots are kept). */
  readonly pendingLearningTasks?: () => Set<string>
}

export interface CleanupItem { readonly kind: CleanupKind; readonly label: string; readonly count: number; readonly bytes: number; readonly detail: string }

const DAY = 86_400_000

function sizeOf(path: string): number {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    return readdirSync(path).reduce((n, f) => n + sizeOf(join(path, f)), 0)
  } catch (gone) {
    void gone
    return 0
  }
}

interface Plan { item: CleanupItem; apply: () => void }

function plans(ctx: CleanupContext): Plan[] {
  const { store, engine } = ctx
  const cutoff = Date.now() - (ctx.days ?? 14) * DAY
  const out: Plan[] = []
  const projects = store.listProjects()

  // Workers whose process is gone (the engine's recovery closes their attempts).
  const orphanProjects = new Set<string>()
  let orphans = 0
  for (const p of projects) for (const w of store.listWorkers(p.id)) {
    if ((w.status === 'running' || w.status === 'starting') && !engine.isRunning(w.taskId) && !(w.pid && processAlive(w.pid))) { orphans++; orphanProjects.add(p.id) }
  }
  out.push({ item: { kind: 'orphan-workers', label: 'Orphaned Workers', count: orphans, bytes: 0, detail: 'Worker records still marked running without a process (their tasks resume from the last attempt)' }, apply: () => { for (const pid of orphanProjects) engine.recoverInterrupted(pid) } })

  const stale: Array<[string, string]> = []
  for (const p of projects) for (const t of store.listLeases(p.id)) {
    const lease = store.readLease(p.id, t)
    if (lease && !processAlive(lease.pid)) stale.push([p.id, t])
  }
  out.push({ item: { kind: 'stale-leases', label: 'Stale task leases', count: stale.length, bytes: 0, detail: 'locks left by processes that no longer exist' }, apply: () => { for (const [p, t] of stale) store.removeStaleLease(p, t) } })

  // Verification snapshot refs of finished tasks (kept while a learning candidate needs them).
  const keepTasks = ctx.pendingLearningTasks?.() ?? new Set<string>()
  const refs: Array<{ root: string; ref: string }> = []
  for (const p of projects) {
    if (!existsSync(p.root)) continue
    let list: string[] = []
    try {
      list = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/superagent/'], { cwd: p.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean)
    } catch (notGit) {
      void notGit
      continue
    }
    const tasks = new Map(store.listTasks(p.id).map(t => [t.id, t]))
    for (const ref of list) {
      const taskId = ref.split('/')[2]!
      const task = tasks.get(taskId)
      if (task && (!TERMINAL_TASK_STATES.includes(task.state) || Date.parse(task.updatedAt) > cutoff || keepTasks.has(taskId))) continue
      refs.push({ root: p.root, ref })
    }
  }
  out.push({ item: { kind: 'snapshot-refs', label: 'Old verification snapshots', count: refs.length, bytes: 0, detail: `refs/superagent/* of tasks finished more than ${ctx.days ?? 14} days ago (or deleted) in project repositories` }, apply: () => {
    for (const r of refs) { try { execFileSync('git', ['update-ref', '-d', r.ref], { cwd: r.root, stdio: 'ignore' }) } catch (gone) { void gone } }
    for (const root of new Set(refs.map(r => r.root))) { try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }) } catch (noop) { void noop } }
  } })

  const workerDirs: string[] = []
  const wroot = join(store.home, 'runtime', 'workers')
  if (existsSync(wroot)) {
    const workers = new Map(projects.flatMap(p => store.listWorkers(p.id)).map(w => [w.id, w]))
    for (const id of readdirSync(wroot)) {
      const w = workers.get(id)
      const ended = w?.endedAt ? Date.parse(w.endedAt) : undefined
      if (!w || (ended !== undefined && ended < cutoff)) workerDirs.push(join(wroot, id))
    }
  }
  out.push({ item: { kind: 'worker-logs', label: 'Old Worker logs', count: workerDirs.length, bytes: workerDirs.reduce((n, d) => n + sizeOf(d), 0), detail: 'prompts, DSH event logs and stderr of Workers that ended long ago (receipts are kept)' }, apply: () => { for (const d of workerDirs) rmSync(d, { recursive: true, force: true }) } })

  const cmdLogs: string[] = []
  const croot = join(store.home, 'runtime', 'commands')
  if (existsSync(croot)) for (const pid of readdirSync(croot)) for (const f of readdirSync(join(croot, pid))) {
    const file = join(croot, pid, f)
    if (statSync(file).mtimeMs < cutoff) cmdLogs.push(file)
  }
  out.push({ item: { kind: 'command-logs', label: 'Old command output', count: cmdLogs.length, bytes: cmdLogs.reduce((n, f) => n + sizeOf(f), 0), detail: 'output of ▷ Run / Terminal commands' }, apply: () => { for (const f of cmdLogs) rmSync(f, { force: true }) } })

  const temps: string[] = []
  const uid = process.getuid?.()
  for (const n of readdirSync(tmpdir())) {
    if (!/^sa-(gate|heldout|idx)-/.test(n)) continue
    const p = join(tmpdir(), n)
    try {
      const st = statSync(p)
      if (st.mtimeMs < Date.now() - 3_600_000 && (uid === undefined || st.uid === uid)) temps.push(p)
    } catch (gone) {
      void gone
    }
  }
  out.push({ item: { kind: 'temp', label: 'Leftover temp folders', count: temps.length, bytes: temps.reduce((n, d) => n + sizeOf(d), 0), detail: `SuperAgent gate/verification temp folders in ${tmpdir()} older than 1 hour` }, apply: () => { for (const d of temps) rmSync(d, { recursive: true, force: true }) } })

  const backups = listBackups(store.home)
  const oldBackups = backups.slice(ctx.keepBackups ?? 10)
  out.push({ item: { kind: 'old-backups', label: 'Old backups', count: oldBackups.length, bytes: oldBackups.reduce((n, b) => n + b.size, 0), detail: `keeps the newest ${ctx.keepBackups ?? 10}` }, apply: () => { for (const b of oldBackups) deleteBackup(store.home, b.id) } })

  const leftovers = readdirSync(store.home).filter(n => /^\.(restore-old|restore-stage|backup-stage)-/.test(n)).map(n => join(store.home, n)).filter(p => statSync(p).mtimeMs < cutoff || /stage/.test(p))
  out.push({ item: { kind: 'restore-leftovers', label: 'Replaced state from restores', count: leftovers.length, bytes: leftovers.reduce((n, d) => n + sizeOf(d), 0), detail: `state set aside by restores more than ${ctx.days ?? 14} days ago` }, apply: () => { for (const d of leftovers) rmSync(d, { recursive: true, force: true }) } })

  if (ctx.update) {
    const s = ctx.update.state()
    const ids = Object.values(s.releases).sort((a, b) => b.installedAt.localeCompare(a.installedAt)).map(r => r.id).filter(id => id !== s.current && id !== s.previous)
    const extra = ids.slice(Math.max(0, (ctx.keepReleases ?? 3) - 2))
    out.push({ item: { kind: 'old-releases', label: 'Old releases', count: extra.length, bytes: extra.reduce((n, id) => n + sizeOf(join(ctx.update!.base, 'releases', id)), 0), detail: 'installed versions other than the current and previous' }, apply: () => { ctx.update!.prune(ctx.keepReleases ?? 3) } })
  }
  return out
}

export function previewCleanup(ctx: CleanupContext): CleanupItem[] {
  return plans(ctx).map(p => p.item)
}

export function applyCleanup(ctx: CleanupContext, kinds: readonly string[]): CleanupItem[] {
  const chosen = new Set(kinds)
  const done: CleanupItem[] = []
  for (const p of plans(ctx)) {
    if (!chosen.has(p.item.kind) || p.item.count === 0) continue
    p.apply()
    done.push(p.item)
  }
  return done
}
