/**
 * Chief (总工) orchestration (Freeze §6.1). Long-lived, project-level.
 *
 * The Chief's *reasoning* (understanding the user, decomposing, architecture
 * judgement) is a DSH session using the SuperAgent tools; this class is the
 * deterministic side those tools call: goals, task creation, sequential goal
 * runs, and status summaries. It never watches Worker logs; it is woken only
 * through `LoopEngine.onChiefWake`.
 */
import type { Goal, GateSpec, Project, Task, TaskScope } from '@superagent/contracts'
import { parseGateSpec } from '@superagent/contracts'
import { formatModel, livePolicy, loadGlobalPolicy, resolveTaskPolicy } from '@superagent/model-policy'
import type { LoopEngine } from './engine.ts'
import { DeterministicPlanner, type Plan, type Planner } from './advisor.ts'

/** Who is creating a task. Only a human may define new gate commands (Gate Registry rule). */
export type Actor = 'human' | 'agent'

export class GateRegistryError extends Error {}

/** Registry = human-defined project gates (`gateRegistry` ∪ `defaultGates`), by id. */
export function gateRegistry(project: Project): Map<string, GateSpec> {
  return new Map([...project.defaultGates, ...(project.gateRegistry ?? [])].map(g => [g.id, g]))
}

/**
 * Resolve task gates. Agents (Chief model tools) may only reference registry ids;
 * an arbitrary model-written shell command never becomes a trusted gate.
 */
export function resolveGates(project: Project, gates: readonly unknown[], actor: Actor): GateSpec[] {
  const registry = gateRegistry(project)
  return gates.map((g, i) => {
    const ref = typeof g === 'string' ? g : (g !== null && typeof g === 'object' && Object.keys(g).length === 1 && typeof (g as { id?: unknown }).id === 'string') ? (g as { id: string }).id : undefined
    if (ref !== undefined) {
      const spec = registry.get(ref)
      if (!spec) throw new GateRegistryError(`gate "${ref}" is not in the project gate registry (${[...registry.keys()].join(', ') || 'empty'})`)
      return spec
    }
    if (actor !== 'human') throw new GateRegistryError(`gates[${i}]: agents may only reference registry gate ids; inline gate definitions require a human`)
    return parseGateSpec(g, `gates[${i}]`)
  })
}

export interface TaskInput {
  readonly title: string
  readonly instructions: string
  readonly scope?: Partial<TaskScope>
  readonly gates?: readonly unknown[]
  /** Untrusted policy fragment, e.g. `{ model: { worker: { provider, model } } }`. */
  readonly policy?: unknown
  /** Require reviewer approval after the gates pass. */
  readonly review?: boolean
}

export interface PlanGoalOptions {
  readonly planner?: Planner
  /** Review every task regardless of what the plan says. */
  readonly review?: boolean
  readonly architecture?: string
  readonly signal?: AbortSignal
}

export interface PlannedGoal {
  readonly goal: Goal
  readonly tasks: readonly Task[]
  readonly plan: Plan
}

export interface GoalRunResult {
  readonly goal: Goal
  readonly tasks: readonly Task[]
}

export class Chief {
  readonly engine: LoopEngine

  constructor(engine: LoopEngine) {
    this.engine = engine
  }

  private get store() { return this.engine.store }

  createGoal(projectId: string, objective: string): Goal {
    return this.store.createGoal(projectId, objective)
  }

  addTask(projectId: string, goalId: string, input: TaskInput, actor: Actor = 'human'): Task {
    const project = this.store.requireProject(projectId)
    if (!this.store.getGoal(projectId, goalId)) throw new Error(`goal ${goalId} not found`)
    const gates: GateSpec[] = resolveGates(project, input.gates ?? [], actor)
    const { policy, pinned } = resolveTaskPolicy({ global: loadGlobalPolicy(this.store.home), project: project.policy }, input.policy)
    return this.store.createTask({
      projectId, goalId,
      title: input.title,
      instructions: input.instructions,
      scope: { paths: input.scope?.paths ?? [], modules: input.scope?.modules ?? [] },
      gates,
      policy,
      pinnedModels: Object.keys(pinned).length ? pinned : undefined,
      review: input.review === true ? true : undefined,
    })
  }

  /**
   * "Describe what you want": plan the request into tasks and create the goal.
   * The plan is model output, so its tasks are added as `agent` (registry gate ids
   * only). A planner that fails or returns an invalid plan falls back to the
   * deterministic single-task plan, and the fallback is recorded on the goal.
   */
  async planGoal(projectId: string, request: string, options: PlanGoalOptions = {}): Promise<PlannedGoal> {
    const project = this.store.requireProject(projectId)
    if (!request.trim()) throw new Error('request is empty')
    const input = { project, request, gates: [...gateRegistry(project).values()], architecture: options.architecture, signal: options.signal }
    let plan: Plan
    try {
      plan = await (options.planner ?? new DeterministicPlanner()).plan(input)
    } catch (error) {
      const fallback = await new DeterministicPlanner().plan(input)
      plan = { ...fallback, note: `planner ${options.planner?.name ?? '?'} failed (${String((error as Error).message ?? error).slice(0, 300)}); using a single task` }
    }
    const goal = this.store.createGoal(projectId, plan.objective)
    this.store.updateGoal(projectId, goal.id, { request })
    this.store.emitTyped('request/submitted', projectId, { request: request.slice(0, 2_000), planner: plan.planner, note: plan.note, tasks: plan.tasks.map(t => t.title) }, { goalId: goal.id })
    const tasks = plan.tasks.map(t => this.addTask(projectId, goal.id, {
      title: t.title, instructions: t.instructions, scope: { paths: [...t.paths], modules: [...t.modules] }, gates: [...t.gates], review: options.review || t.review,
    }, 'agent'))
    return { goal: this.store.getGoal(projectId, goal.id)!, tasks, plan }
  }

  /**
   * Run the goal's unfinished tasks in order. Stops at the first Human Gate
   * (goal → blocked) or failure (goal → failed); all passed → complete.
   */
  async runGoal(projectId: string, goalId: string): Promise<GoalRunResult> {
    let goal = this.store.getGoal(projectId, goalId)
    if (!goal) throw new Error(`goal ${goalId} not found`)
    if (goal.status !== 'active') goal = this.store.updateGoal(projectId, goalId, { status: 'active', blocker: undefined })
    for (const taskId of goal.taskIds) {
      let task = this.store.requireTask(projectId, taskId)
      if (task.state === 'passed') continue
      // An explicit (re)run of the goal resumes tasks the human stopped earlier.
      if (task.state === 'stopped') task = this.store.updateTask(projectId, taskId, { state: task.attempts.length ? 'retrying' : 'pending', stopRequested: false })
      const { task: after, humanGate } = await this.engine.runTask(projectId, taskId)
      if (after.state === 'passed') continue
      if (after.state === 'human_gate') {
        goal = this.store.updateGoal(projectId, goalId, { status: 'blocked', blocker: `task ${after.title}: ${humanGate?.reason ?? 'human gate'} — ${humanGate?.detail ?? ''}` })
        return this.result(projectId, goal)
      }
      if (after.state === 'stopped') {
        goal = this.store.updateGoal(projectId, goalId, { status: 'paused' })
        return this.result(projectId, goal)
      }
      goal = this.store.updateGoal(projectId, goalId, { status: 'failed', blocker: `task ${after.title} ended ${after.state}` })
      return this.result(projectId, goal)
    }
    goal = this.store.updateGoal(projectId, goalId, { status: 'complete', blocker: undefined })
    this.store.emitTyped('chief/wake', projectId, { reason: 'goal-finished', detail: goal.objective }, { goalId })
    return this.result(projectId, goal)
  }

  private result(projectId: string, goal: Goal): GoalRunResult {
    return { goal, tasks: goal.taskIds.map(id => this.store.requireTask(projectId, id)) }
  }

  /** Human-readable progress report ("汇报一下进度"), built from state, not from memory. */
  statusReport(projectId: string): string {
    const project: Project = this.store.requireProject(projectId)
    const goal = this.store.currentGoal(projectId)
    const lines = [`# ${project.name}  (${project.root})`]
    if (!goal) return [...lines, 'No goal yet.'].join('\n')
    lines.push(`Goal: ${goal.objective} — **${goal.status}**${goal.blocker ? ` (blocker: ${goal.blocker})` : ''}`)
    for (const id of goal.taskIds) {
      const t = this.store.requireTask(projectId, id)
      const last = t.attempts.at(-1)
      const receipt = last?.receiptId ? this.store.getReceipt(projectId, last.receiptId) : undefined
      lines.push(`- [${t.state}] ${t.title} — attempts ${t.attempts.length}/${t.policy.maxAttempts}, worker ${formatModel(livePolicy(this.store.home, project, t).model.worker)}${receipt ? `, last receipt ${receipt.verdict}: ${receipt.reason}` : ''}`)
    }
    const open = this.store.listHumanGates(projectId, 'open')
    if (open.length) {
      lines.push('', 'Needs your decision:')
      for (const g of open) lines.push(`- ${g.id} [${g.reason}] ${g.detail}`)
    }
    return lines.join('\n')
  }
}
