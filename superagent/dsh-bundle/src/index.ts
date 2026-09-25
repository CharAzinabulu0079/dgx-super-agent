/**
 * SuperAgent Cordis plugin for DSH sessions (loaded via the bundle patch).
 *
 * Worker tool (active when the Worker env is present, set by DshHeadlessExecutor):
 *   superagent_report      structured progress/blocker/result report → state store
 * Chief tools (client of the SuperAgent Realtime/API gateway):
 *   superagent_status      project progress report (from state, not memory)
 *   superagent_create_goal / superagent_add_task / superagent_run_goal
 *   superagent_architecture  module graph queries: overview, module detail, impact
 *
 * Human Gates are deliberately NOT resolvable from a model tool (Freeze §6.3).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseWorkerReport } from '@superagent/contracts'
import { StateStore } from '@superagent/project-state'

export const name = 'superagent-tools'
export const inject = ['tools']

export interface Config {
  apiUrl?: string
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

async function callApi(apiUrl: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const token = process.env.SUPERAGENT_TOKEN
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new Error(`SuperAgent API ${method} ${path}: ${json.error ?? res.status}`)
  return json
}

export function apply(ctx: Context, config: Config = {}): void {
  const apiUrl = (config.apiUrl ?? process.env.SUPERAGENT_API_URL ?? 'http://127.0.0.1:7788').replace(/\/$/, '')
  const tools = (ctx as any).tools
  const worker = {
    home: process.env.SUPERAGENT_HOME,
    projectId: process.env.SUPERAGENT_PROJECT_ID,
    taskId: process.env.SUPERAGENT_TASK_ID,
    workerId: process.env.SUPERAGENT_WORKER_ID,
  }

  if (worker.home && worker.projectId && worker.taskId && worker.workerId) {
    const store = new StateStore(worker.home)
    tools.register(defineTool({
      name: 'superagent_report',
      description: 'Report structured progress, a blocker, or your final result to the SuperAgent Chief. Your claim is recorded but an independent verifier decides PASS. Set human_required only for product-direction, irreversible-data, permission, production, or architecture-boundary decisions.',
      parameters: {
        kind: { type: 'string', enum: ['progress', 'blocker', 'result'], required: true },
        current_state: { type: 'string', required: true, description: 'What you are doing now, e.g. "running unit tests"' },
        progress: { type: 'number', description: '0-100' },
        changed_modules: { type: 'array', items: { type: 'string' }, description: 'Architecture module ids you changed' },
        verification_result: { type: 'string', enum: ['claimed_pass', 'claimed_fail', 'not_run'] },
        blocker: { type: 'string' },
        next_action: { type: 'string' },
        human_required: { type: 'boolean' },
        summary: { type: 'string' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean', required: true }, at: { type: 'string', required: true } } },
        render: (_args, value) => text(`report recorded at ${value.at}; the independent verifier decides PASS`),
      },
      async execute(args) {
        const model = { provider: process.env.SUPERAGENT_MODEL_PROVIDER ?? 'unknown', model: process.env.SUPERAGENT_MODEL ?? 'unknown' }
        const report = parseWorkerReport(args, { task_id: worker.taskId!, model })
        const stored = store.appendReport(worker.projectId!, worker.workerId!, report)
        return { recorded: true, at: stored.at ?? '' }
      },
    }))
  }

  tools.register(defineTool({
    name: 'superagent_status',
    description: 'Get the progress report of a SuperAgent project workspace (goal, tasks, attempts, verdicts, decisions waiting for the human). Omit project to list projects.',
    parameters: { project: { type: 'string', description: 'Project id' } },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      if (!args.project) {
        const projects = await callApi(apiUrl, 'GET', '/api/projects', undefined, exec.signal)
        return projects.map((p: any) => `${p.id}\t${p.root}\t${p.goal?.status ?? 'no goal'}${p.openHumanGates ? `\t${p.openHumanGates} decision(s) waiting` : ''}`).join('\n') || 'no projects'
      }
      return (await callApi(apiUrl, 'GET', `/api/projects/${encodeURIComponent(args.project)}`, undefined, exec.signal)).report
    },
  }))

  tools.register(defineTool({
    name: 'superagent_create_goal',
    description: 'Create a durable goal in a SuperAgent project workspace.',
    parameters: { project: { type: 'string', required: true }, objective: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_a, v) => text(JSON.stringify(v)) },
    async execute(args, exec) {
      const goal = await callApi(apiUrl, 'POST', `/api/projects/${encodeURIComponent(args.project)}/goals`, { objective: args.objective }, exec.signal)
      return { goalId: goal.id, status: goal.status }
    },
  }))

  tools.register(defineTool({
    name: 'superagent_add_task',
    description: 'Add a Worker task to a goal. Gates are deterministic checks the independent verifier runs (e.g. {"id":"unit","kind":"command","command":"npm test"}); omit to use project defaults. worker_model is "provider/model" or "local-default".',
    parameters: {
      project: { type: 'string', required: true },
      goal: { type: 'string', required: true },
      title: { type: 'string', required: true },
      instructions: { type: 'string', required: true },
      modules: { type: 'array', items: { type: 'string' } },
      paths: { type: 'array', items: { type: 'string' } },
      gates: { type: 'array', items: { type: 'json' } },
      worker_model: { type: 'string' },
      escalation_model: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(JSON.stringify(v)) },
    async execute(args, exec) {
      const model = (s?: string) => (!s ? undefined : s === 'local-default' ? { provider: 'local-default', model: 'default' } : { provider: s.split('/')[0], model: s.split('/').slice(1).join('/') })
      const worker = model(args.worker_model)
      const escalation = model(args.escalation_model)
      const task = await callApi(apiUrl, 'POST', `/api/projects/${encodeURIComponent(args.project)}/goals/${encodeURIComponent(args.goal)}/tasks`, {
        title: args.title, instructions: args.instructions, scope: { modules: args.modules ?? [], paths: args.paths ?? [] }, gates: args.gates ?? [],
        policy: worker || escalation ? { model: { ...(worker ? { worker } : {}), ...(escalation ? { escalation } : {}) } } : undefined,
      }, exec.signal)
      return { taskId: task.id, model: task.policy.model }
    },
  }))

  tools.register(defineTool({
    name: 'superagent_run_goal',
    description: 'Start (or continue) the Loop for a goal: Workers execute, the independent verifier checks, failures retry automatically; only true human decisions stop it. Returns immediately; use superagent_status to follow.',
    parameters: { project: { type: 'string', required: true }, goal: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_a, v) => text(JSON.stringify(v)) },
    async execute(args, exec) {
      return callApi(apiUrl, 'POST', `/api/projects/${encodeURIComponent(args.project)}/goals/${encodeURIComponent(args.goal)}/run`, {}, exec.signal)
    },
  }))

  tools.register(defineTool({
    name: 'superagent_architecture',
    description: 'Query the live project architecture map instead of reading the whole repository: overview (modules, layers, drift, current changes), a module (location, deps, users, gates, ADRs, tests), or impact of changing modules.',
    parameters: {
      project: { type: 'string', required: true },
      module: { type: 'string', description: 'Module id for detail' },
      impact_of: { type: 'array', items: { type: 'string' }, description: 'Module ids to compute change impact for' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => text(JSON.stringify(v, null, 1)) },
    async execute(args, exec) {
      const g = await callApi(apiUrl, 'GET', `/api/projects/${encodeURIComponent(args.project)}/architecture`, undefined, exec.signal)
      if (args.module) return g.nodes.find((n: any) => n.id === args.module) ?? { error: `no module ${args.module}`, modules: g.nodes.map((n: any) => n.id) }
      if (args.impact_of?.length) {
        const usedBy = new Map<string, string[]>()
        for (const e of g.edges) usedBy.set(e.to, [...(usedBy.get(e.to) ?? []), e.from])
        const seen = new Set<string>(args.impact_of)
        const queue = [...args.impact_of]
        while (queue.length) for (const up of usedBy.get(queue.shift()!) ?? []) if (!seen.has(up)) { seen.add(up); queue.push(up) }
        for (const m of args.impact_of) seen.delete(m)
        const impacted = [...seen].sort()
        const gates = [...new Set(g.nodes.filter((n: any) => args.impact_of!.includes(n.id) || impacted.includes(n.id)).flatMap((n: any) => n.gates))]
        return { changed: args.impact_of, impacted, gates }
      }
      return {
        stats: g.stats, layers: g.layers, commit: g.commit,
        modules: g.nodes.map((n: any) => ({ id: n.id, layer: n.layer, status: n.status, dependsOn: n.dependsOn, files: n.files })),
        drift: g.drift, changes: g.changes,
      }
    },
  }))
}
