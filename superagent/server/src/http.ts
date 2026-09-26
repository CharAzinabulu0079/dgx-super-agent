/**
 * Headless Realtime/API gateway (Freeze §3, §12): JSON over HTTP + Server-Sent
 * Events. Every client (Web/PWA today, Digital Human later) uses this surface;
 * none of them touches the store directly.
 *
 * Binds 127.0.0.1 by default. Exposing it further is a Human Gate decision
 * (Freeze §6.3). Privileges: anonymous (reads), agent token (Chief tools), human token
 * (Human Gates, policy, registry, project registration) — see ADR-0013.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { parseGateSpec, type Project, type SuperAgentEvent } from '@superagent/contracts'
import { effectiveModels, loadGlobalPolicy, parseModelSpec, parsePolicyLayer, roleModel, saveGlobalPolicy } from '@superagent/model-policy'
import type { SuperAgentRuntime } from './runtime.ts'
import { narrate } from './narrate.ts'
import { LinkSigner, listProjectDir, sendFile } from './files-http.ts'
import { ShareError, mimeOf as mimeOfName, resolveProjectFile, shareFile, sharedFilePath } from '@superagent/project-state'
import type { ChiefMessage, SharedFile } from '@superagent/contracts'
import { workerTranscript } from './transcript.ts'
import { CommandError, CommandRunner } from './commands.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { backupFile, createBackup } from './ops/backup.ts'
import { UpdateManager, isSupervised, managedBase, scheduleRestart } from './ops/update.ts'
import { appVersion } from './ops/version.ts'
import { preflightChecks, type HealthContext } from './ops/health.ts'
import { REPO_ROOT } from '@superagent/testkit'
import { presetViews } from './ops/presets.ts'
import { AppearanceError, GRADIENT_PRESETS, MAX_BACKGROUND_BYTES, deleteBackground, findBackground, listBackgrounds, loadAppearance, saveAppearance, saveBackground } from './appearance.ts'
import { ChiefDriver, DshChiefChannel, GateRegistryError, WakeMonitor, type ChiefChannel } from '@superagent/chief-worker'

export interface ServerOptions {
  readonly runtime: SuperAgentRuntime
  readonly host?: string
  readonly port?: number
  /**
   * Human credential for privileged actions (resolve Human Gates, edit policy/registry,
   * promote memory, register projects). Defaults to a random value held only in memory,
   * printed by `sa serve`; it is never written to disk or passed to Workers.
   */
  readonly humanToken?: string
  /** Credential for Chief/agent clients (goals, tasks by registry id, runs). Default random. */
  readonly agentToken?: string
  /**
   * Also require a token for reads (default: reads open on localhost). Always on when
   * the server listens on a non-loopback address (LAN / WireGuard).
   */
  readonly protectReads?: boolean
  /**
   * Chief auto-wake. `true` delivers wakes to a persistent DSH Chief session
   * (profile superagent-chief-cli); pass a channel to override; omit to disable.
   */
  readonly chiefWake?: boolean | { readonly channel?: ChiefChannel; readonly intervalMs?: number; readonly minIntervalMs?: number; readonly env?: Record<string, string> }
  /**
   * Human ↔ Chief chat in the UI, through the same persistent Chief session the wakes use.
   * `true` = DSH Chief channel (needs the superagent-chief-cli profile); or pass a channel.
   */
  readonly chiefChat?: boolean | ChiefChannel
  /** Extra environment for the default DSH Chief channel (e.g. model endpoint). */
  readonly chiefEnv?: Record<string, string>
  /** Directory with the built UI (`superagent/ui/dist`). */
  readonly uiDir?: string
  /** Watch registered project trees and rescan architecture on change. */
  readonly watch?: boolean
  readonly watchDebounceMs?: number
  /** Recover interrupted tasks and resume requested goal runs on start (`sa serve`). */
  readonly resumeGoals?: boolean
  /** The human token is stable across restarts (SUPERAGENT_HUMAN_TOKEN) — shown by the health check. */
  readonly stableToken?: boolean
  /** Managed-install updates (default: detected from where this code runs). Tests pass their own. */
  readonly update?: { readonly base: string; readonly steps?: ReadonlyArray<readonly string[]>; readonly restart?: () => boolean }
}

export interface RunningServer {
  readonly url: string
  readonly humanToken: string
  readonly agentToken: string
  readonly server: Server
  close(): Promise<void>
}

export class HttpError extends Error {
  readonly status: number
  /** Extra JSON fields for the error response (e.g. failing health checks). */
  readonly data?: Record<string, unknown>
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

export type Role = 'human' | 'agent' | 'anonymous'
type Level = 'read' | 'agent' | 'human'
type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; query: URLSearchParams; role: Role }) => unknown | Promise<unknown>

const RANK: Record<Role, number> = { anonymous: 0, agent: 1, human: 2 }
const NEED: Record<Level, number> = { read: 0, agent: 1, human: 2 }

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/**
 * DNS-rebinding guard for a loopback server with anonymous reads: a page on an attacker's
 * domain that resolves to 127.0.0.1 is "same-origin" with itself, so the Origin check alone
 * does not stop it. Only loopback names are accepted in the Host header.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase())
  if (!m) return false
  const name = m[1]!.replace(/^\[|\]$/g, '')
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name)
}

export async function startServer(input: ServerOptions): Promise<RunningServer> {
  // Anything beyond loopback (e.g. a WireGuard address or 0.0.0.0) gets no anonymous reads.
  const options: ServerOptions = { ...input, protectReads: input.protectReads || !isLoopbackHost(input.host ?? '127.0.0.1') }
  const { runtime } = options
  const { store, engine, chief, observatory } = runtime
  const humanToken = options.humanToken ?? randomBytes(24).toString('base64url')
  const agentToken = options.agentToken ?? randomBytes(24).toString('base64url')
  const roleOf = (req: IncomingMessage, url: URL): Role => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const given = header ?? url.searchParams.get('token') ?? ''
    if (given && sameSecret(given, humanToken)) return 'human'
    if (given && sameSecret(given, agentToken)) return 'agent'
    return 'anonymous'
  }
  type Raw = { readonly types: RegExp; readonly maxBytes: number }
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; level: Level; handler: Handler; raw?: Raw }> = []
  const route = (method: string, path: string, handler: Handler, level: Level = method === 'GET' ? 'read' : 'agent', raw?: Raw): void => {
    const keys: string[] = []
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)' })}$`)
    routes.push({ method, pattern, keys, level, handler, raw })
  }
  const project = (pid: string): Project => {
    const p = /^[\w.-]+$/.test(pid) ? store.getProject(pid) : undefined
    if (!p) throw new HttpError(404, `project ${pid} not found`)
    return p
  }
  const goals = runtime.goals
  const healthCtx = (): HealthContext => ({
    store, repoRoot: REPO_ROOT, dshHome: join(store.home, 'dsh-home'), usesDsh: engine.executor.name === 'dsh-headless',
    isTaskRunning: id => engine.isRunning(id), host: options.host ?? '127.0.0.1', stableToken: options.stableToken,
  })
  /** Refuse to start work while something is red (e.g. no DSH Worker profile); `force` overrides. */
  const preflight = (pid: string, force: unknown): void => {
    if (force === true) return
    const failing = preflightChecks(healthCtx(), pid).filter(c => c.status === 'fail')
    if (failing.length) throw new HttpError(412, `not ready: ${failing.map(c => `${c.title}${c.fix ? ` (fix: ${c.fix})` : ''}`).join('; ')}`, { checks: failing })
  }
  const links = new LinkSigner()
  const commands = new CommandRunner(store)
  const installBase = options.update?.base ?? managedBase(REPO_ROOT)
  const updateManager = installBase ? new UpdateManager({
    base: installBase, home: store.home, steps: options.update?.steps,
    backup: label => createBackup(store.home, { label, ...appVersion() }).id,
    restart: () => { if (options.update?.restart) options.update.restart(); else if (isSupervised()) scheduleRestart() },
  }) : undefined
  let chiefDriver: ChiefDriver | undefined
  let chiefChannel: ChiefChannel | undefined
  const chatAbort = new AbortController()

  // ---------------------------------------------------------------- projects
  route('GET', '/api/health', () => ({ ok: true, home: store.home }))
  route('GET', '/api/projects', () => store.listProjects().map(p => ({ ...p, goal: store.currentGoal(p.id) ?? null, openHumanGates: store.listHumanGates(p.id, 'open').length })))
  route('POST', '/api/projects', async ({ body }) => {
    if (typeof body?.name !== 'string' || typeof body?.root !== 'string') throw new HttpError(400, 'name and root are required')
    if (!existsSync(body.root) || !statSync(body.root).isDirectory()) throw new HttpError(400, `root ${body.root} is not a directory`)
    const gates = Array.isArray(body.defaultGates) ? body.defaultGates.map((g: unknown, i: number) => parseGateSpec(g, `defaultGates[${i}]`)) : []
    const p = await runtime.addProject({ name: body.name, root: body.root, defaultGates: gates, protectedModules: body.protectedModules ?? [] })
    watchProject(p)
    return p
  }, 'human')
  route('GET', '/api/projects/:pid', ({ params }) => {
    const p = project(params.pid!)
    const goal = store.currentGoal(p.id)
    return {
      project: p,
      goal: goal ?? null,
      goals: store.listGoals(p.id),
      tasks: store.listTasks(p.id).map(t => ({ ...t, running: engine.isRunning(t.id) })),
      workers: store.listWorkers(p.id).slice(-50),
      humanGates: store.listHumanGates(p.id),
      report: chief.statusReport(p.id),
      models: effectiveModels(loadGlobalPolicy(store.home), p.policy),
      runningGoals: goals.running(p.id) ? [goals.running(p.id)] : [],
    }
  })

  // ---------------------------------------------------------------- goals & tasks
  route('POST', '/api/projects/:pid/goals', ({ params, body }) => {
    if (typeof body?.objective !== 'string' || !body.objective.trim()) throw new HttpError(400, 'objective is required')
    return chief.createGoal(project(params.pid!).id, body.objective.trim())
  })
  route('POST', '/api/projects/:pid/goals/:gid/tasks', ({ params, body, role }) => {
    if (typeof body?.title !== 'string' || typeof body?.instructions !== 'string') throw new HttpError(400, 'title and instructions are required')
    // Grants are human-only; agents may only reference registry gates (ADR-0012).
    const { grants: _ignored, ...input } = body
    void _ignored
    try {
      return chief.addTask(project(params.pid!).id, params.gid!, input, role === 'human' ? 'human' : 'agent')
    } catch (error) {
      if (error instanceof GateRegistryError) throw new HttpError(400, error.message)
      throw error
    }
  })
  route('POST', '/api/projects/:pid/goals/:gid/run', ({ params, body }) => {
    const p = project(params.pid!)
    preflight(p.id, body?.force)
    // One goal per project tree at a time (concurrent Workers would mix their changes);
    // a second request is queued durably and starts when the current goal ends.
    const r = goals.start(p.id, params.gid!)
    if (!r.started && !r.queued) throw new HttpError(409, 'goal already running')
    return r
  })
  // "Describe what you want": the Chief plans the request into tasks (registry gates
  // only), creates the goal and starts (or queues) it.
  route('POST', '/api/projects/:pid/requests', async ({ params, body }) => {
    const p = project(params.pid!)
    if (typeof body?.request !== 'string' || !body.request.trim()) throw new HttpError(400, 'request is required')
    if (body.request.length > 20_000) throw new HttpError(413, 'request too long')
    if (body.run !== false) preflight(p.id, body.force)
    // Quick model override for this request: a preset id or a role → model map; pinned on its tasks.
    let policy: unknown
    if (typeof body.preset === 'string' || (body.models && typeof body.models === 'object')) {
      const models = typeof body.preset === 'string' ? presetViews(store.home).find(x => x.id === body.preset)?.models : body.models
      if (!models) throw new HttpError(400, `unknown preset ${body.preset}`)
      const parsed: Record<string, unknown> = {}
      for (const role of ['worker', 'reviewer', 'escalation', 'planner'] as const) {
        const spec = (models as Record<string, unknown>)[role]
        if (typeof spec === 'string' && spec) parsed[role] = parseModelSpec(spec) ?? (() => { throw new HttpError(400, `invalid model for ${role}: ${spec}`) })()
      }
      policy = { model: parsed }
    }
    const planned = await chief.planGoal(p.id, body.request.trim(), { planner: runtime.planner, review: body.review === true, architecture: runtime.architectureSummary(p), policy })
    const run = body.run === false ? { started: false, queued: false } : goals.start(p.id, planned.goal.id)
    return { ...planned, run }
  })
  route('POST', '/api/projects/:pid/tasks/:tid/stop', ({ params }) => engine.stop(project(params.pid!).id, params.tid!))
  route('POST', '/api/projects/:pid/tasks/:tid/steer', ({ params, body }) => {
    if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required')
    return engine.steer(project(params.pid!).id, params.tid!, body.text.trim())
  })
  route('POST', '/api/projects/:pid/tasks/:tid/model', ({ params, body }) => {
    const p = project(params.pid!)
    const modelRole = body?.role ?? 'worker'
    if (!['planner', 'worker', 'reviewer', 'escalation'].includes(modelRole)) throw new HttpError(400, `invalid role ${modelRole}`)
    const model = parseModelSpec(String(body?.model ?? ''))
    if (!model) throw new HttpError(400, 'model must be "provider/model" or "local-default"')
    const task = store.requireTask(p.id, params.tid!)
    if (engine.isRunning(task.id)) throw new HttpError(409, 'task is running; stop it first')
    return store.updateTask(p.id, task.id, {
      policy: { ...task.policy, model: { ...task.policy.model, [modelRole]: model } },
      pinnedModels: { ...task.pinnedModels, [modelRole]: model },
    })
  }, 'human')
  route('POST', '/api/projects/:pid/human-gates/:hid', ({ params, body }) => {
    const decision = body?.decision
    if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'decision must be approved|rejected')
    const p = project(params.pid!)
    const task = engine.resolveHumanGate(p.id, params.hid!, decision, String(body?.resolution ?? ''))
    // An approval unblocks the goal: pick it back up without a separate "Start".
    let resumed = false
    if (task && decision === 'approved' && (task.state === 'pending' || task.state === 'passed')) {
      const goal = store.getGoal(p.id, task.goalId)
      if (goal?.status === 'blocked') resumed = goals.start(p.id, goal.id).started
    }
    return { gate: store.getHumanGate(p.id, params.hid!), task: task ?? null, resumed }
  }, 'human')
  // ---------------------------------------------------------------- model policy (Directive §4.F)
  route('GET', '/api/policy', () => ({ global: loadGlobalPolicy(store.home), effective: effectiveModels(loadGlobalPolicy(store.home)) }))
  route('POST', '/api/policy', ({ body }) => {
    try {
      return saveGlobalPolicy(store.home, parsePolicyLayer(body, 'global'))
    } catch (error) {
      throw new HttpError(400, String((error as Error).message))
    }
  }, 'human')
  route('POST', '/api/projects/:pid/policy', ({ params, body }) => {
    const p = project(params.pid!)
    try {
      return store.updateProject(p.id, { policy: parsePolicyLayer(body, 'project') })
    } catch (error) {
      throw new HttpError(400, String((error as Error).message))
    }
  }, 'human')
  route('GET', '/api/projects/:pid/chief', ({ params }) => {
    const p = project(params.pid!)
    const wakes = store.listRecords<{ status: string; createdAt: string }>(p.id, 'wakes').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return {
      enabled: chiefDriver !== undefined,
      pending: wakes.filter(w => w.status === 'pending').length,
      failed: wakes.filter(w => w.status === 'failed').length,
      lastDelivery: store.getMeta(p.id, 'chief-last-delivery') ?? null,
      session: store.getMeta(p.id, 'chief-session') ?? null,
      recent: wakes.slice(0, 20),
    }
  })
  route('GET', '/api/projects/:pid/activity', ({ params, query }) => {
    const p = project(params.pid!)
    const titles = new Map(store.listTasks(p.id).map(t => [t.id, t.title]))
    const limit = Math.min(Number(query.get('limit') ?? 100), 500)
    return store.readEvents(p.id, 0, 5_000).map(e => narrate(e, id => titles.get(id))).filter(Boolean).slice(-limit)
  })
  // ---------------------------------------------------------------- files (share, browse, preview/download links)
  const sharedFile = (pid: string, fid: string): SharedFile => {
    const f = store.getRecord<SharedFile>(pid, 'files', fid)
    if (!f) throw new HttpError(404, `file ${fid} not found`)
    return f
  }
  route('GET', '/api/projects/:pid/files', ({ params }) => store.listRecords<SharedFile>(project(params.pid!).id, 'files').sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  route('POST', '/api/projects/:pid/files', ({ params, body, role }) => {
    if (typeof body?.path !== 'string') throw new HttpError(400, 'path is required')
    try {
      return shareFile(store, project(params.pid!).id, body.path, { role: role === 'human' ? 'human' : 'chief' }, typeof body.note === 'string' ? body.note : undefined)
    } catch (error) {
      if (error instanceof ShareError) throw new HttpError(400, error.message)
      throw error
    }
  })
  route('GET', '/api/projects/:pid/tree', ({ params, query }) => {
    const p = project(params.pid!)
    try {
      return listProjectDir(p.root, query.get('path') ?? '', store.home)
    } catch (error) {
      throw new HttpError(400, String((error as Error).message))
    }
  })
  // Mint a short-lived link a browser (or phone) can open without the token.
  route('POST', '/api/links', ({ body }) => {
    const p = project(String(body?.project ?? ''))
    const d: 0 | 1 = body?.download === true ? 1 : 0
    if (typeof body?.file === 'string') {
      const f = sharedFile(p.id, body.file)
      const signed = links.sign({ p: p.id, f: f.id, d })
      return { ...signed, url: `/dl/${signed.token}`, name: f.name, mime: f.mime, size: f.size }
    }
    if (typeof body?.path !== 'string') throw new HttpError(400, 'file or path is required')
    try {
      const r = resolveProjectFile(p.root, body.path, store.home)
      const signed = links.sign({ p: p.id, path: r.rel, d })
      return { ...signed, url: `/dl/${signed.token}`, name: r.rel.split('/').at(-1), mime: mimeOfName(r.rel), size: statSync(r.abs).size }
    } catch (error) {
      if (error instanceof ShareError) throw new HttpError(400, error.message)
      throw error
    }
  }, 'read')
  // ---------------------------------------------------------------- appearance (theme, background, digital-human embed)
  const BG_TTL = 24 * 3_600_000
  const bgUrl = (id: string) => `/dl/${links.sign({ p: '', f: id, d: 0, k: 'bg' }, BG_TTL).token}`
  const appearanceView = () => {
    const appearance = loadAppearance(store.home)
    return {
      appearance,
      backgroundUrl: appearance.background.assetId ? bgUrl(appearance.background.assetId) : null,
      assets: listBackgrounds(store.home).map(a => ({ id: a.id, mime: a.mime, size: a.size, url: bgUrl(a.id) })),
      presets: GRADIENT_PRESETS,
    }
  }
  const appearanceErrors = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof AppearanceError) throw new HttpError(400, error.message)
      throw error
    }
  }
  route('GET', '/api/ui/appearance', () => appearanceView())
  route('POST', '/api/ui/appearance', ({ body }) => appearanceErrors(() => { saveAppearance(store.home, body); return appearanceView() }), 'human')
  route('POST', '/api/ui/backgrounds', ({ body }) => appearanceErrors(() => {
    if (!Buffer.isBuffer(body)) throw new AppearanceError('send the image/video bytes with its content-type')
    const a = saveBackground(store.home, body)
    return { id: a.id, mime: a.mime, size: a.size, url: bgUrl(a.id) }
  }), 'human', { types: /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm))\b/, maxBytes: MAX_BACKGROUND_BYTES.video })
  route('POST', '/api/ui/backgrounds/:id/delete', ({ params }) => appearanceErrors(() => {
    if (loadAppearance(store.home).background.assetId === params.id) throw new AppearanceError('this background is in use; pick another one first')
    deleteBackground(store.home, params.id!)
    return appearanceView()
  }), 'human')

  registerSystemRoutes(route, {
    store, healthCtx,
    busy: () => {
      const goal = store.listProjects().map(p => goals.running(p.id)).find(Boolean)
      return goal ? `goal ${goal} is running` : commands.anyRunning() ? 'a command is running' : undefined
    },
    backupLink: id => `/dl/${links.sign({ p: '', f: id, d: 1, k: 'backup' }).token}`,
    appVersion: () => appVersion(),
    update: updateManager,
    restart: options.update?.restart,
  })

  // ---------------------------------------------------------------- human-run commands (▷ on code blocks)
  const commandErrors = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof CommandError) throw new HttpError(400, error.message)
      throw error
    }
  }
  route('POST', '/api/projects/:pid/commands/check', ({ params, body }) => commands.check(project(params.pid!).id, String(body?.command ?? '')), 'human')
  route('POST', '/api/projects/:pid/commands', ({ params, body }) => commandErrors(() => commands.start(project(params.pid!).id, String(body?.command ?? ''), body?.confirmDanger === true)), 'human')
  route('GET', '/api/projects/:pid/commands', ({ params }) => commands.list(project(params.pid!).id), 'human')
  route('GET', '/api/projects/:pid/commands/:cid', ({ params }) => commandErrors(() => commands.get(project(params.pid!).id, params.cid!)), 'human')
  route('POST', '/api/projects/:pid/commands/:cid/stop', ({ params }) => commandErrors(() => commands.stop(project(params.pid!).id, params.cid!)), 'human')

  // ---------------------------------------------------------------- Chief conversation + Worker transcripts
  route('GET', '/api/projects/:pid/chief/messages', ({ params, query }) => {
    const p = project(params.pid!)
    const limit = Math.min(Number(query.get('limit') ?? 200), 1000)
    return { available: !!chiefChannel?.chat, busy: chiefChannel?.busy?.(p.id) ?? false, messages: store.listRecords<ChiefMessage>(p.id, 'chief-chat').slice(-limit) }
  })
  route('POST', '/api/projects/:pid/chief/messages', ({ params, body }) => {
    const p = project(params.pid!)
    if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required')
    if (!chiefChannel?.chat) throw new HttpError(503, 'Chief chat is not available: run `sa dsh setup` (creates the superagent-chief-cli profile) and restart `sa serve`')
    const queued = chiefChannel.busy?.(p.id) ?? false
    // Runs in the background; the reply streams into the transcript (SSE `chief/message`).
    void chiefChannel.chat(p.id, body.text.trim().slice(0, 20_000), chatAbort.signal, chief.statusReport(p.id)).catch(() => {})
    return { accepted: true, queued }
  }, 'human')
  route('GET', '/api/projects/:pid/workers/:wid/transcript', ({ params }) => {
    const p = project(params.pid!)
    const worker = store.getWorker(p.id, params.wid!)
    if (!worker) throw new HttpError(404, `worker ${params.wid} not found`)
    return { worker, ...workerTranscript(store.home, worker.id) }
  })
  route('GET', '/api/projects/:pid/receipts', ({ params, query }) => store.listReceipts(project(params.pid!).id, query.get('task') ?? undefined))
  route('GET', '/api/projects/:pid/workers/:wid/reports', ({ params }) => store.readReports(project(params.pid!).id, params.wid!))
  route('GET', '/api/projects/:pid/events', ({ params, query }) => store.readEvents(project(params.pid!).id, Number(query.get('since') ?? 0), Number(query.get('limit') ?? 500)))

  // ---------------------------------------------------------------- learning
  route('GET', '/api/learning', ({ query }) => {
    const pid = query.get('project')
    return runtime.learning.learning.list().filter(c => !pid || c.evidence.projectId === pid)
  })
  route('POST', '/api/learning/:cid/evaluate', ({ params }) => runtime.learning.evaluate(params.cid!))
  route('POST', '/api/learning/:cid/decide', ({ params, body }) => {
    if (typeof body?.approved !== 'boolean') throw new HttpError(400, 'approved (boolean) is required')
    return runtime.learning.decide(params.cid!, body.approved, String(body.note ?? ''))
  }, 'human')

  // ---------------------------------------------------------------- architecture
  route('GET', '/api/projects/:pid/architecture', async ({ params }) => {
    const p = project(params.pid!)
    let graph = observatory.withRuntime(p.root, runtime.runtimeInputs(p))
    if (!graph || graph.freshness?.stale) {
      await runtime.scanArchitecture(p)
      graph = observatory.withRuntime(p.root, runtime.runtimeInputs(p))
    }
    return graph
  })
  route('POST', '/api/projects/:pid/architecture/scan', async ({ params }) => {
    const p = project(params.pid!)
    await runtime.scanArchitecture(p)
    return observatory.withRuntime(p.root, runtime.runtimeInputs(p))
  })

  // ---------------------------------------------------------------- SSE
  const sseClients = new Set<{ res: ServerResponse; project?: string; cursor: Map<string, number> }>()
  const pump = setInterval(() => {
    for (const client of sseClients) {
      // A failure while serving one client (e.g. its project was removed) ends that stream;
      // it must never escape the timer, which would take the whole server down.
      try {
        const pids = client.project ? [client.project] : store.listProjects().map(p => p.id)
        for (const pid of pids) {
          if (!client.cursor.has(pid)) { client.cursor.set(pid, store.lastEventSeq(pid)); continue }
          // Oldest first, bounded per tick; a burst drains over the next ticks without gaps.
          const events: SuperAgentEvent[] = store.tailEvents(pid, client.cursor.get(pid)!, 500)
          for (const e of events) {
            client.res.write(`id: ${pid}:${e.seq}\nevent: superagent\ndata: ${JSON.stringify(e)}\n\n`)
            // Plain-language line for voice/avatar clients (Digital Human) and the UI's embed bridge.
            const line = narrate(e, id => store.getTask(pid, id)?.title)
            if (line) client.res.write(`event: activity\ndata: ${JSON.stringify({ projectId: pid, ...line })}\n\n`)
          }
          if (events.length) client.cursor.set(pid, events.at(-1)!.seq)
        }
      } catch (error) {
        sseClients.delete(client)
        client.res.end(`event: error\ndata: ${JSON.stringify({ error: String((error as Error).message ?? error) })}\n\n`)
      }
    }
  }, 400)
  const heartbeat = setInterval(() => { for (const c of sseClients) c.res.write(': ping\n\n') }, 15_000)

  // ---------------------------------------------------------------- watchers
  const watchers = new Map<string, FSWatcher>()
  const watchProject = (p: Project): void => {
    if (!options.watch || watchers.has(p.id) || !existsSync(p.root)) return
    let timer: NodeJS.Timeout | undefined
    try {
      const w = watch(p.root, { recursive: true }, (_type, file) => {
        const f = String(file ?? '')
        if (f.startsWith('.architecture') || f.includes('node_modules') || (f.startsWith('.git') && !/^\.git\/(HEAD|index)$/.test(f))) return
        clearTimeout(timer)
        timer = setTimeout(() => { void runtime.scanArchitecture(p).catch(() => {}) }, options.watchDebounceMs ?? 1500)
      })
      watchers.set(p.id, w)
    } catch (unsupported) {
      store.emitTyped('architecture/updated', p.id, { watchError: String(unsupported) })
    }
  }
  for (const p of store.listProjects()) watchProject(p)

  // ---------------------------------------------------------------- dispatch
  const uiDir = options.uiDir && existsSync(options.uiDir) ? resolve(options.uiDir) : undefined
  const server = createServer((req, res) => { void dispatch(req, res) })
  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname.startsWith('/api/')) {
        // CSRF guard for a local agent with shell access: browsers may send "simple"
        // cross-origin POSTs (text/plain) without preflight. Require JSON (forces a
        // preflight we never grant) and reject foreign Origins outright.
        if (!options.protectReads && !isLoopbackHostHeader(req.headers.host)) throw new HttpError(403, 'unexpected Host header (this server only answers to localhost)')
        const origin = req.headers.origin
        if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'cross-origin request refused')
        const contentType = String(req.headers['content-type'] ?? '')
        const isJson = contentType.startsWith('application/json')
        const role = roleOf(req, url)
        if (url.pathname === '/api/events/stream') {
          if (options.protectReads && role === 'anonymous') throw new HttpError(401, 'unauthorized')
          const only = url.searchParams.get('project')
          if (only !== null) project(only)
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          res.write(': connected\n\n')
          const client = { res, project: url.searchParams.get('project') ?? undefined, cursor: new Map<string, number>() }
          sseClients.add(client)
          req.on('close', () => sseClients.delete(client))
          return
        }
        for (const r of routes) {
          if (r.method !== req.method) continue
          const m = r.pattern.exec(url.pathname)
          if (!m) continue
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]))
          // Non-JSON POSTs only on declared binary routes, with a non-"simple" media type
          // (image/*, video/*), which browsers cannot send cross-origin without preflight.
          if (req.method === 'POST' && !isJson && !(r.raw && r.raw.types.test(contentType))) throw new HttpError(415, r.raw ? `unsupported upload type ${contentType || '(none)'}` : 'POST requires application/json')
          const need = r.level === 'read' && options.protectReads ? NEED.agent : NEED[r.level]
          if (RANK[role] < need) throw new HttpError(role === 'anonymous' ? 401 : 403, `${r.level} credential required`)
          const body = req.method === 'POST' ? (r.raw && !isJson ? await readRaw(req, r.raw.maxBytes) : await readBody(req)) : undefined
          const result = await r.handler({ req, res, params, body, query: url.searchParams, role })
          sendJson(res, 200, result ?? null)
          return
        }
        throw new HttpError(404, `no route ${req.method} ${url.pathname}`)
      }
      if (url.pathname.startsWith('/dl/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const link = links.verify(url.pathname.slice(4))
        if (!link) throw new HttpError(403, 'link expired or invalid — open the file again from SuperAgent')
        if (link.k === 'backup') {
          const file = backupFile(store.home, link.f ?? '')
          if (!existsSync(file)) throw new HttpError(404, 'backup not found')
          sendFile(req, res, file, `${link.f}.tar.gz`, true, 'application/gzip')
          return
        }
        if (link.k === 'bg') {
          const a = findBackground(store.home, link.f ?? '')
          if (!a) throw new HttpError(404, 'background not found')
          sendFile(req, res, a.file, `${a.id}${a.file.slice(a.file.lastIndexOf('.'))}`, false, a.mime)
          return
        }
        const p = project(link.p)
        if (link.f) {
          const f = sharedFile(p.id, link.f)
          sendFile(req, res, sharedFilePath(store, f), f.name, link.d === 1, f.mime)
        } else {
          // Re-validated at serve time: the tree may have changed since the link was minted.
          const r = resolveProjectFile(p.root, link.path ?? '', store.home)
          sendFile(req, res, r.abs, r.rel.split('/').at(-1)!, link.d === 1)
        }
        return
      }
      if (uiDir && req.method === 'GET') {
        const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
        let file = join(uiDir, rel)
        if (!file.startsWith(uiDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html')
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(readFileSync(file))
        return
      }
      throw new HttpError(404, 'not found')
    } catch (error) {
      // Nothing more to say once a response has started: drop the connection.
      if (res.headersSent) { res.destroy(); return }
      const status = error instanceof HttpError ? error.status : /not found|ENOENT/.test(String(error)) ? 404 : 500
      sendJson(res, status, { error: (error as Error).message ?? String(error), ...(error instanceof HttpError ? error.data : {}) })
    }
  }

  await new Promise<void>(res => server.listen(options.port ?? 7788, options.host ?? '127.0.0.1', res))
  const addr = server.address() as AddressInfo
  const url = `http://${addr.address}:${addr.port}`
  engine.setApiOrigins([url, `http://localhost:${addr.port}`])
  const cfg = typeof options.chiefWake === 'object' ? options.chiefWake : {}
  if (options.chiefWake || options.chiefChat) {
    // One channel for wakes and chat, so both serialize on the same persistent session.
    chiefChannel = typeof options.chiefChat === 'object' ? options.chiefChat
      : cfg.channel ?? new DshChiefChannel({ stateHome: store.home, apiUrl: url, agentToken, store, env: { ...cfg.env, ...options.chiefEnv }, model: pid => roleModel(store.home, store.getProject(pid), 'chief') })
  }
  if (options.chiefWake) {
    chiefDriver = new ChiefDriver({
      store, monitor: new WakeMonitor(store), minIntervalMs: cfg.minIntervalMs,
      channel: chiefChannel!,
      statusReport: id => chief.statusReport(id),
    })
    chiefDriver.start(cfg.intervalMs ?? 2_000)
  }
  if (options.resumeGoals) {
    for (const p of store.listProjects()) engine.recoverInterrupted(p.id)
    goals.resumeAll()
  }
  return {
    url,
    humanToken,
    agentToken,
    server,
    close: async () => {
      chiefDriver?.stop()
      chatAbort.abort()
      commands.stopAll()
      clearInterval(pump)
      clearInterval(heartbeat)
      for (const w of watchers.values()) w.close()
      for (const c of sseClients) c.res.end()
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (invalid) {
    throw new HttpError(400, `invalid JSON: ${String(invalid)}`)
  }
}

async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, `upload too large (max ${maxBytes} bytes)`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}
