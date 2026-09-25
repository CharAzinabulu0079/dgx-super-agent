/**
 * Headless Realtime/API gateway (Freeze §3, §12): JSON over HTTP + Server-Sent
 * Events. Every client (Web/PWA today, Digital Human later) uses this surface;
 * none of them touches the store directly.
 *
 * Binds 127.0.0.1 by default. Exposing it further is a Human Gate decision
 * (Freeze §6.3); set SUPERAGENT_TOKEN to require `Authorization: Bearer`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { parseGateSpec, type Project, type SuperAgentEvent } from '@superagent/contracts'
import { parseModelSpec } from '@superagent/model-policy'
import type { SuperAgentRuntime } from './runtime.ts'

export interface ServerOptions {
  readonly runtime: SuperAgentRuntime
  readonly host?: string
  readonly port?: number
  readonly token?: string
  /** Directory with the built UI (`superagent/ui/dist`). */
  readonly uiDir?: string
  /** Watch registered project trees and rescan architecture on change. */
  readonly watch?: boolean
  readonly watchDebounceMs?: number
}

export interface RunningServer {
  readonly url: string
  readonly server: Server
  close(): Promise<void>
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: any; query: URLSearchParams }) => unknown | Promise<unknown>

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { runtime } = options
  const { store, engine, chief, observatory } = runtime
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = []
  const route = (method: string, path: string, handler: Handler): void => {
    const keys: string[] = []
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)' })}$`)
    routes.push({ method, pattern, keys, handler })
  }
  const project = (pid: string): Project => {
    const p = store.getProject(pid)
    if (!p) throw new HttpError(404, `project ${pid} not found`)
    return p
  }
  const runningGoals = new Set<string>()

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
  })
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
      runningGoals: [...runningGoals].filter(k => k.startsWith(`${p.id}/`)).map(k => k.split('/')[1]),
    }
  })

  // ---------------------------------------------------------------- goals & tasks
  route('POST', '/api/projects/:pid/goals', ({ params, body }) => {
    if (typeof body?.objective !== 'string' || !body.objective.trim()) throw new HttpError(400, 'objective is required')
    return chief.createGoal(project(params.pid!).id, body.objective.trim())
  })
  route('POST', '/api/projects/:pid/goals/:gid/tasks', ({ params, body }) => {
    if (typeof body?.title !== 'string' || typeof body?.instructions !== 'string') throw new HttpError(400, 'title and instructions are required')
    return chief.addTask(project(params.pid!).id, params.gid!, body)
  })
  route('POST', '/api/projects/:pid/goals/:gid/run', ({ params }) => {
    const p = project(params.pid!)
    const key = `${p.id}/${params.gid}`
    if (runningGoals.has(key)) throw new HttpError(409, 'goal already running')
    runningGoals.add(key)
    void chief.runGoal(p.id, params.gid!)
      .catch(error => store.emitTyped('goal/updated', p.id, { error: String(error) }, { goalId: params.gid }))
      .finally(() => runningGoals.delete(key))
    return { started: true }
  })
  route('POST', '/api/projects/:pid/tasks/:tid/stop', ({ params }) => engine.stop(project(params.pid!).id, params.tid!))
  route('POST', '/api/projects/:pid/tasks/:tid/steer', ({ params, body }) => {
    if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required')
    return engine.steer(project(params.pid!).id, params.tid!, body.text.trim())
  })
  route('POST', '/api/projects/:pid/tasks/:tid/model', ({ params, body }) => {
    const p = project(params.pid!)
    const role = body?.role ?? 'worker'
    if (!['planner', 'worker', 'reviewer', 'escalation'].includes(role)) throw new HttpError(400, `invalid role ${role}`)
    const model = parseModelSpec(String(body?.model ?? ''))
    if (!model) throw new HttpError(400, 'model must be "provider/model" or "local-default"')
    const task = store.requireTask(p.id, params.tid!)
    if (engine.isRunning(task.id)) throw new HttpError(409, 'task is running; stop it first')
    return store.updateTask(p.id, task.id, { policy: { ...task.policy, model: { ...task.policy.model, [role]: model } } })
  })
  route('POST', '/api/projects/:pid/human-gates/:hid', ({ params, body }) => {
    const decision = body?.decision
    if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'decision must be approved|rejected')
    const p = project(params.pid!)
    const task = engine.resolveHumanGate(p.id, params.hid!, decision, String(body?.resolution ?? ''))
    return { gate: store.getHumanGate(p.id, params.hid!), task: task ?? null }
  })
  route('GET', '/api/projects/:pid/receipts', ({ params, query }) => store.listReceipts(project(params.pid!).id, query.get('task') ?? undefined))
  route('GET', '/api/projects/:pid/workers/:wid/reports', ({ params }) => store.readReports(project(params.pid!).id, params.wid!))
  route('GET', '/api/projects/:pid/events', ({ params, query }) => store.readEvents(project(params.pid!).id, Number(query.get('since') ?? 0), Number(query.get('limit') ?? 500)))

  // ---------------------------------------------------------------- architecture
  route('GET', '/api/projects/:pid/architecture', async ({ params }) => {
    const p = project(params.pid!)
    let graph = observatory.withRuntime(p.root, runtime.runtimeInputs(p))
    if (!graph) {
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
      const pids = client.project ? [client.project] : store.listProjects().map(p => p.id)
      for (const pid of pids) {
        const since = client.cursor.get(pid) ?? store.readEvents(pid, 0, 1).at(-1)?.seq ?? 0
        const events: SuperAgentEvent[] = store.readEvents(pid, since, 200)
        if (!client.cursor.has(pid)) { client.cursor.set(pid, since); continue }
        for (const e of events) client.res.write(`id: ${pid}:${e.seq}\nevent: superagent\ndata: ${JSON.stringify(e)}\n\n`)
        if (events.length) client.cursor.set(pid, events.at(-1)!.seq)
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
        if (options.token && req.headers.authorization !== `Bearer ${options.token}` && url.searchParams.get('token') !== options.token) throw new HttpError(401, 'unauthorized')
        if (url.pathname === '/api/events/stream') {
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
          const body = req.method === 'POST' ? await readBody(req) : undefined
          const result = await r.handler({ req, res, params, body, query: url.searchParams })
          sendJson(res, 200, result ?? null)
          return
        }
        throw new HttpError(404, `no route ${req.method} ${url.pathname}`)
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
      const status = error instanceof HttpError ? error.status : /not found/.test(String(error)) ? 404 : 500
      sendJson(res, status, { error: (error as Error).message ?? String(error) })
    }
  }

  await new Promise<void>(res => server.listen(options.port ?? 7788, options.host ?? '127.0.0.1', res))
  const addr = server.address() as AddressInfo
  return {
    url: `http://${addr.address}:${addr.port}`,
    server,
    close: async () => {
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
