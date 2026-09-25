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
import { resolveTaskPolicy, formatModel } from '@superagent/model-policy'
import type { LoopEngine } from './engine.ts'

export interface TaskInput {
  readonly title: string
  readonly instructions: string
  readonly scope?: Partial<TaskScope>
  readonly gates?: readonly unknown[]
  /** Untrusted policy fragment, e.g. `{ model: { worker: { provider, model } } }`. */
  readonly policy?: unknown
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

  addTask(projectId: string, goalId: string, input: TaskInput): Task {
    const project = this.store.requireProject(projectId)
    if (!this.store.getGoal(projectId, goalId)) throw new Error(`goal ${goalId} not found`)
    const gates: GateSpec[] = (input.gates ?? []).map((g, i) => parseGateSpec(g, `gates[${i}]`))
    return this.store.createTask({
      projectId, goalId,
      title: input.title,
      instructions: input.instructions,
      scope: { paths: input.scope?.paths ?? [], modules: input.scope?.modules ?? [] },
      gates,
      policy: resolveTaskPolicy(project.root, input.policy),
    })
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
      const task = this.store.requireTask(projectId, taskId)
      if (task.state === 'passed') continue
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
      lines.push(`- [${t.state}] ${t.title} — attempts ${t.attempts.length}/${t.policy.maxAttempts}, worker ${formatModel(t.policy.model.worker)}${receipt ? `, last receipt ${receipt.verdict}: ${receipt.reason}` : ''}`)
    }
    const open = this.store.listHumanGates(projectId, 'open')
    if (open.length) {
      lines.push('', 'Needs your decision:')
      for (const g of open) lines.push(`- ${g.id} [${g.reason}] ${g.detail}`)
    }
    return lines.join('\n')
  }
}
