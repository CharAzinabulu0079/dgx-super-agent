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
 *
 * Tools are role-scoped by SUPERAGENT_ROLE (`worker` | `chief`, default `chief`).
 * Every session also gets the SuperAgent pre-tool guard (`ctx.tools.guard`), a
 * monotonic deny DSH evaluates after `tools/pre-execute` and before the tool runs,
 * including nested PTC/workflow/subagent dispatches.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { now, parseWorkerReport } from '@superagent/contracts'
import { StateStore } from '@superagent/project-state'
import { decideToolCall, type ToolPolicy } from '@superagent/loop-policy'

export const name = 'superagent-tools'
export const inject = ['tools']

export interface Config {
  apiUrl?: string
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

async function callApi(apiUrl: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const token = process.env.SUPERAGENT_AGENT_TOKEN
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

  const role = process.env.SUPERAGENT_ROLE === 'worker' ? 'worker' : 'chief'
  const isWorker = role === 'worker' && !!(worker.home && worker.projectId && worker.taskId && worker.workerId)
  const store = worker.home ? new StateStore(worker.home) : undefined

  // ---- pre-tool guard (all roles) ------------------------------------------
  let policy: ToolPolicy = {
    role, projectRoot: process.cwd(), verificationPaths: [], protectedModulePaths: [], approvedActions: [],
    forbiddenPaths: worker.home ? [worker.home] : [], apiOrigins: [], productionWrite: false, tempRoots: [tmpdir(), '/tmp'],
  }
  if (process.env.SUPERAGENT_WORKER_POLICY) {
    // Fail closed: a Worker whose policy file is unreadable must not run unguarded.
    try {
      policy = JSON.parse(readFileSync(process.env.SUPERAGENT_WORKER_POLICY, 'utf8')) as ToolPolicy
    } catch (unreadable) {
      tools.guard(() => `SuperAgent policy unavailable (${String(unreadable)}); all tools are blocked for this Worker`)
    }
  }
  ctx.effect(() => tools.guard((exec: { name: string; arguments: unknown }) => {
    const args = (exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}) as Record<string, unknown>
    const d = decideToolCall(policy, exec.name, args)
    if (d.allow) return undefined
    if (isWorker && store) {
      const at = now()
      store.appendBlockedAction(worker.projectId!, worker.workerId!, { fingerprint: d.fingerprint, tool: exec.name, summary: d.summary, category: d.category, rule: d.rule, workerId: worker.workerId, taskId: worker.taskId, at })
      store.appendReport(worker.projectId!, worker.workerId!, parseWorkerReport({
        kind: 'blocker', current_state: `blocked: ${d.rule}`, progress: 0, verification_result: 'not_run',
        blocker: `${d.category}: ${d.summary}`, next_action: 'awaiting human approval', human_required: true, summary: `pre-tool guard blocked ${exec.name}`,
      }, { task_id: worker.taskId!, model: { provider: process.env.SUPERAGENT_MODEL_PROVIDER ?? 'unknown', model: process.env.SUPERAGENT_MODEL ?? 'unknown' } }))
    }
    return `SuperAgent policy blocked this call before execution (${d.category}: ${d.rule}). A human must approve it; the request has been recorded. Do not retry or work around it — continue with other work, or finish and report human_required.`
  }))

  if (isWorker && store) {
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

  if (role !== 'chief') return

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
