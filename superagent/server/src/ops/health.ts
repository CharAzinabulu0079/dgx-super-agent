/**
 * One-click Health Check: deterministic checks only (no model tokens unless `deep`).
 * Red = something will not work (blocks starting work); yellow = degraded / attention.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRef } from '@superagent/contracts'
import { processAlive, type StateStore } from '@superagent/project-state'
import { effectiveModels, loadGlobalPolicy } from '@superagent/model-policy'
import { dshBin } from '@superagent/testkit'
import { readIsolation } from '@superagent/chief-worker'
import { probeProvider, readRoutes, storedConnection, testModel, type ProbeResult } from './providers.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface HealthCheck {
  readonly id: string
  readonly group: 'runtime' | 'dsh' | 'models' | 'storage' | 'agents' | 'projects' | 'access'
  readonly status: CheckStatus
  readonly title: string
  readonly detail: string
  /** What to do about it (a button in the UI where possible). */
  readonly fix?: string
}
export interface HealthReport {
  readonly overall: 'green' | 'yellow' | 'red'
  readonly checkedAt: string
  readonly deep: boolean
  readonly checks: readonly HealthCheck[]
}

export interface HealthContext {
  readonly store: StateStore
  readonly repoRoot: string
  readonly dshHome: string
  /** Whether Workers run through DSH (a scripted executor needs no DSH checks). */
  readonly usesDsh: boolean
  readonly isTaskRunning?: (taskId: string) => boolean
  readonly host?: string
  readonly stableToken?: boolean
  /** Also send a 1-token request to each configured model (costs a few tokens). */
  readonly deep?: boolean
  /** Test seam. */
  readonly probe?: typeof probeProvider
}

const GB = 1024 ** 3

export function summarize(checks: readonly HealthCheck[], deep = false): HealthReport {
  const overall = checks.some(c => c.status === 'fail') ? 'red' : checks.some(c => c.status === 'warn') ? 'yellow' : 'green'
  return { overall, checkedAt: new Date().toISOString(), deep, checks }
}

function versionAtLeast(v: string, min: [number, number]): boolean {
  const [a = 0, b = 0] = v.split('.').map(Number)
  return a > min[0] || (a === min[0] && b >= min[1])
}

/** Fast checks needed before starting work (used as the run preflight). */
export function preflightChecks(ctx: HealthContext, projectId?: string): HealthCheck[] {
  const out: HealthCheck[] = []
  const { store } = ctx
  // storage
  try {
    const probe = join(store.home, `.health-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe)
    out.push({ id: 'storage.writable', group: 'storage', status: 'ok', title: 'State directory writable', detail: store.home })
  } catch (error) {
    out.push({ id: 'storage.writable', group: 'storage', status: 'fail', title: 'State directory not writable', detail: `${store.home}: ${String((error as Error).message)}`, fix: 'fix permissions of SUPERAGENT_HOME' })
  }
  try {
    const s = statfsSync(store.home)
    const free = s.bavail * s.bsize
    out.push({
      id: 'storage.disk', group: 'storage', status: free < GB ? 'fail' : free < 5 * GB ? 'warn' : 'ok',
      title: 'Free disk space', detail: `${(free / GB).toFixed(1)} GB free`, fix: free < 5 * GB ? 'run Cleanup, delete old backups or free space' : undefined,
    })
  } catch (unsupported) {
    void unsupported
  }
  if (ctx.usesDsh) {
    try {
      const bin = dshBin()
      const pkg = JSON.parse(readFileSync(join(ctx.repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version: string }
      const want = (JSON.parse(readFileSync(join(ctx.repoRoot, 'upstream', 'dsh.lock.json'), 'utf8')) as { npm: { version: string } }).npm.version
      out.push(pkg.version === want
        ? { id: 'dsh.binary', group: 'dsh', status: 'ok', title: 'DSH runtime', detail: `${pkg.version} (${bin})` }
        : { id: 'dsh.binary', group: 'dsh', status: 'fail', title: 'DSH version mismatch', detail: `installed ${pkg.version}, pinned ${want}`, fix: 'pnpm install' })
    } catch (error) {
      out.push({ id: 'dsh.binary', group: 'dsh', status: 'fail', title: 'DSH runtime missing', detail: String((error as Error).message), fix: 'pnpm install' })
    }
    const worker = existsSync(join(ctx.dshHome, 'profiles', 'superagent-worker', 'package.json'))
    out.push(worker
      ? { id: 'dsh.worker-profile', group: 'dsh', status: 'ok', title: 'Worker profile', detail: 'superagent-worker (SuperAgent guard + tools)' }
      : { id: 'dsh.worker-profile', group: 'dsh', status: 'fail', title: 'Worker profile missing', detail: 'Workers would run without the SuperAgent pre-tool guard', fix: 'sa dsh setup' })
  }
  for (const p of projectId ? [store.requireProject(projectId)] : store.listProjects()) {
    if (!existsSync(p.root)) {
      out.push({ id: `project.${p.id}.root`, group: 'projects', status: 'fail', title: `Project ${p.name}: folder missing`, detail: p.root, fix: 're-register the project with its new path' })
      continue
    }
    let git = false
    try {
      git = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: p.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true'
    } catch (notGit) {
      void notGit
    }
    if (!git) out.push({ id: `project.${p.id}.git`, group: 'projects', status: 'fail', title: `Project ${p.name}: not a git repository`, detail: 'verification integrity needs git snapshots', fix: 'git init && git add -A && git commit -m init (in the project)' })
    for (const g of p.defaultGates.filter(x => x.heldOut)) {
      if (!existsSync(join(store.home, 'heldout', g.heldOut!.source))) out.push({ id: `project.${p.id}.heldout.${g.id}`, group: 'projects', status: 'fail', title: `Project ${p.name}: hidden tests missing for gate ${g.id}`, detail: g.heldOut!.source, fix: 'sa heldout add … (or restore a backup)' })
    }
    const testGates = p.defaultGates.filter(g => g.kind === 'command' || g.kind === 'e2e')
    if (!testGates.length) out.push({ id: `project.${p.id}.gates`, group: 'projects', status: 'warn', title: `Project ${p.name}: no test gate`, detail: 'tasks are only checked for architecture drift', fix: 'add a test command in the project settings' })
    else if (git) out.push({ id: `project.${p.id}`, group: 'projects', status: 'ok', title: `Project ${p.name}`, detail: `${p.root} · gates ${p.defaultGates.map(g => g.id).join(', ')}` })
  }
  return out
}

/** Model reachability per provider in use (probe = free; deep = 1-token request). */
async function modelChecks(ctx: HealthContext): Promise<HealthCheck[]> {
  const out: HealthCheck[] = []
  const home = ctx.store.home
  const routes = readRoutes(home)
  const roles = effectiveModels(loadGlobalPolicy(home)) as Record<string, ModelRef | undefined>
  const byProvider = new Map<string, { model: ModelRef; roles: string[] }[]>()
  for (const [role, m] of Object.entries(roles)) {
    if (!m) continue
    const alias = routes.aliases?.[m.provider]
    const target = alias ? { provider: alias.provider, model: alias.model } : m
    const list = byProvider.get(target.provider) ?? []
    const hit = list.find(x => x.model.model === target.model)
    if (hit) hit.roles.push(role)
    else list.push({ model: target, roles: [role] })
    byProvider.set(target.provider, list)
  }
  const probe = ctx.probe ?? probeProvider
  for (const [provider, uses] of byProvider) {
    const label = uses.map(u => `${u.roles.join('/')} → ${u.model.model}`).join('; ')
    if (provider === 'local-default') {
      const key = process.env.DEEPSEEK_API_KEY || routes.env?.DEEPSEEK_API_KEY
      out.push(key
        ? { id: 'models.local-default', group: 'models', status: 'ok', title: 'local-default → DSH built-in route', detail: `${label}; DEEPSEEK_API_KEY set` }
        : { id: 'models.local-default', group: 'models', status: 'warn', title: 'local-default is not mapped to a model server', detail: `${label}; no provider configured and no DEEPSEEK_API_KEY`, fix: 'Models → add a provider and mark it "local default"' })
      continue
    }
    const conn = storedConnection(home, provider)
    if (!conn) {
      const cfg = (routes.piAiProviders as Record<string, { apiKeyEnv?: string }> | undefined)?.[provider]
      const keyVar = cfg?.apiKeyEnv
      const hasKey = keyVar ? !!(process.env[keyVar] || routes.env?.[keyVar]) : false
      out.push({ id: `models.${provider}`, group: 'models', status: hasKey ? 'ok' : 'warn', title: `Provider ${provider}`, detail: `${label}; ${cfg ? (hasKey ? 'key configured (catalog route; not probed)' : 'no key configured') : 'not configured — DSH must know this provider'}`, fix: hasKey ? undefined : 'Models → add this provider' })
      continue
    }
    const r: ProbeResult = await probe({ ...conn, timeoutMs: 4_000 })
    if (!r.ok) {
      out.push({ id: `models.${provider}`, group: 'models', status: 'fail', title: `Provider ${provider} unreachable`, detail: `${label}; ${r.detail}`, fix: r.kind === 'unauthorized' ? 'Models → update the key' : 'check the model server / Base URL' })
      continue
    }
    const missing = uses.filter(u => !r.models.includes(u.model.model)).map(u => u.model.model)
    let status: CheckStatus = missing.length ? 'warn' : 'ok'
    let detail = `${label}; ${r.detail}, ${r.latencyMs} ms${missing.length ? `; not listed: ${missing.join(', ')}` : ''}`
    if (ctx.deep) {
      for (const u of uses) {
        const t = await testModel({ ...conn, model: u.model.model })
        if (!t.ok) { status = 'fail'; detail += `; test ${u.model.model} failed: ${t.detail}` } else detail += `; ${u.model.model} answered in ${t.latencyMs} ms`
      }
    }
    out.push({ id: `models.${provider}`, group: 'models', status, title: `Provider ${provider}`, detail, fix: missing.length ? 'Models → pick a model the server lists' : undefined })
  }
  if (!byProvider.size) out.push({ id: 'models.none', group: 'models', status: 'warn', title: 'No model policy', detail: 'using built-in defaults' })
  return out
}

/** Ubuntu 24.04 blocks user namespaces for unconfined programs (a service): bwrap needs a profile. */
function bwrapFix(): string {
  let restricted = false
  try { restricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1' } catch (absent) { void absent }
  return restricted && existsSync('/usr/bin/bwrap')
    ? 'allow bubblewrap in AppArmor (Ubuntu 24.04 blocks it for services), then restart SuperAgent'
    : 'sudo apt install bubblewrap (or run Workers as a separate OS user)'
}

export async function runHealthCheck(ctx: HealthContext): Promise<HealthReport> {
  const checks: HealthCheck[] = []
  const node = process.versions.node
  checks.push(versionAtLeast(node, [22, 19])
    ? { id: 'runtime.node', group: 'runtime', status: 'ok', title: 'Node.js', detail: node }
    : { id: 'runtime.node', group: 'runtime', status: 'fail', title: 'Node.js too old', detail: `${node} (need ≥ 22.19)`, fix: 'install Node 22 LTS' })
  try {
    checks.push({ id: 'runtime.git', group: 'runtime', status: 'ok', title: 'git', detail: execFileSync('git', ['--version']).toString().trim() })
  } catch (missing) {
    void missing
    checks.push({ id: 'runtime.git', group: 'runtime', status: 'fail', title: 'git missing', detail: 'required for verification snapshots', fix: 'install git' })
  }
  checks.push(...preflightChecks(ctx))
  if (ctx.usesDsh) {
    const chief = existsSync(join(ctx.dshHome, 'profiles', 'superagent-chief-cli', 'package.json'))
    checks.push(chief
      ? { id: 'dsh.chief-profile', group: 'dsh', status: 'ok', title: 'Chief profile', detail: 'chat, planner, reviewer and auto-wake available' }
      : { id: 'dsh.chief-profile', group: 'dsh', status: 'warn', title: 'Chief profile missing', detail: 'no Chief chat, planning (falls back to one task), reviewer or auto-wake', fix: 'sa dsh setup' })
    const lib = join(ctx.repoRoot, 'superagent', 'dsh-bundle', 'lib', 'index.js')
    const src = join(ctx.repoRoot, 'superagent', 'dsh-bundle', 'src', 'index.ts')
    const fresh = existsSync(lib) && statSync(lib).mtimeMs >= statSync(src).mtimeMs
    checks.push(fresh
      ? { id: 'dsh.bundle', group: 'dsh', status: 'ok', title: 'SuperAgent DSH bundle built', detail: lib }
      : { id: 'dsh.bundle', group: 'dsh', status: 'warn', title: 'SuperAgent DSH bundle outdated', detail: 'source is newer than the build', fix: 'pnpm build (or sa dsh setup)' })
  }
  const chromium = process.env.SUPERAGENT_CHROMIUM || (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH) ? process.env.PLAYWRIGHT_BROWSERS_PATH : undefined) || ['/opt/pw-browsers', join(process.env.HOME ?? '', '.cache', 'ms-playwright')].find(p => existsSync(p))
  checks.push(chromium
    ? { id: 'runtime.browser', group: 'runtime', status: 'ok', title: 'Browser for E2E / browser Workers', detail: chromium }
    : { id: 'runtime.browser', group: 'runtime', status: 'warn', title: 'No browser found', detail: 'E2E gates and browser Workers will fail', fix: 'npx playwright install chromium (or set SUPERAGENT_CHROMIUM)' })
  checks.push(existsSync(join(ctx.repoRoot, 'superagent', 'ui', 'dist', 'index.html'))
    ? { id: 'runtime.ui', group: 'runtime', status: 'ok', title: 'Web UI built', detail: 'superagent/ui/dist' }
    : { id: 'runtime.ui', group: 'runtime', status: 'warn', title: 'Web UI not built', detail: 'the API works, the UI does not', fix: 'pnpm build' })
  // secrets
  const secrets = join(ctx.store.home, 'secrets')
  const routesFile = join(ctx.store.home, 'model-routes.json')
  const loose = [secrets, routesFile].filter(p => existsSync(p) && (statSync(p).mode & 0o077) !== 0)
  checks.push(loose.length
    ? { id: 'storage.secrets', group: 'storage', status: 'warn', title: 'Secrets readable by other users', detail: loose.join(', '), fix: 'chmod 700 secrets; chmod 600 model-routes.json' }
    : { id: 'storage.secrets', group: 'storage', status: 'ok', title: 'Secrets permissions', detail: 'owner-only' })
  const iso = readIsolation()
  checks.push(iso.available
    ? { id: 'agents.isolation', group: 'agents', status: 'ok', title: 'Worker read isolation', detail: iso.reason }
    : { id: 'agents.isolation', group: 'agents', status: 'warn', title: 'Workers are not read-isolated', detail: iso.reason, fix: bwrapFix() })
  checks.push(...await modelChecks(ctx))
  // agents
  let orphans = 0
  let stale = 0
  let failedWakes = 0
  for (const p of ctx.store.listProjects()) {
    for (const w of ctx.store.listWorkers(p.id)) {
      if ((w.status === 'running' || w.status === 'starting') && !ctx.isTaskRunning?.(w.taskId) && !(w.pid && processAlive(w.pid))) orphans++
    }
    for (const t of ctx.store.listLeases(p.id)) {
      const lease = ctx.store.readLease(p.id, t)
      if (lease && !processAlive(lease.pid)) stale++
    }
    failedWakes += ctx.store.listRecords<{ status: string }>(p.id, 'wakes').filter(w => w.status === 'failed').length
  }
  checks.push(orphans || stale
    ? { id: 'agents.leftovers', group: 'agents', status: 'warn', title: 'Leftovers from interrupted runs', detail: `${orphans} Worker record(s) without a process, ${stale} stale lease(s)`, fix: 'System → Cleanup' }
    : { id: 'agents.leftovers', group: 'agents', status: 'ok', title: 'Workers', detail: 'no orphaned Workers or stale leases' })
  checks.push(failedWakes
    ? { id: 'agents.chief', group: 'agents', status: 'warn', title: 'Chief wakes failed', detail: `${failedWakes} wake(s) could not be delivered`, fix: 'check the Chief model in Models' }
    : { id: 'agents.chief', group: 'agents', status: 'ok', title: 'Chief wake queue', detail: 'no failed deliveries' })
  // access
  if (ctx.host) {
    const remote = !/^(127\.|localhost$|::1$)/.test(ctx.host)
    checks.push({ id: 'access', group: 'access', status: remote && !ctx.stableToken ? 'warn' : 'ok', title: remote ? 'Remote access on' : 'Local access only', detail: remote ? `listening on ${ctx.host}; token required for every request` : 'listening on 127.0.0.1', fix: remote && !ctx.stableToken ? 'set SUPERAGENT_HUMAN_TOKEN so the phone link survives restarts' : undefined })
  }
  return summarize(checks, !!ctx.deep)
}
