/**
 * Loop Engineering engine (Freeze §6.2): per task,
 *   EXECUTE (Worker) → VERIFY (independent gates) → decide (loop policy)
 *   → PASS | RETRY (feedback / fresh context / escalated model) | HUMAN GATE.
 *
 * The engine is deterministic code; all LLM reasoning happens inside the Worker
 * executor (a DSH session in production).
 */
import type { Attempt, GateSpec, HumanGate, Project, Receipt, RetryStrategy, Task, WorkerClaim, WorkerReport } from '@superagent/contracts'
import { TERMINAL_TASK_STATES, now, parseWorkerReport } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'
import { receiptSignature, type Verifier } from '@superagent/verifier'
import { availableStrategies, decideNext, type LoopDecision } from '@superagent/loop-policy'
import { modelForStrategy } from '@superagent/model-policy'
import type { AttemptFeedback, WorkerExecutor } from './executor.ts'
import { diffSnapshots, snapshotTree } from './git.ts'

/** Optional Architecture Observatory hooks (Phase C). */
export interface ArchitectureHooks {
  /** Map changed file paths to module ids. */
  modulesForFiles(project: Project, files: readonly string[]): string[]
  /** Modules transitively affected by a change to `modules`. */
  impactOf(project: Project, modules: readonly string[]): string[]
  /** Refresh the persisted graph after an attempt. */
  refresh?(project: Project): void | Promise<void>
}

export interface EngineOptions {
  readonly store: StateStore
  readonly verifier: Verifier
  readonly executor: WorkerExecutor
  readonly architecture?: ArchitectureHooks
  /** Called for events that should wake the (expensive) Chief model. */
  readonly onChiefWake?: (wake: ChiefWake) => void | Promise<void>
  /** Promoted memory for a project, injected into Worker prompts. */
  readonly memory?: (projectId: string) => readonly string[]
}

export interface ChiefWake {
  readonly projectId: string
  readonly taskId?: string
  readonly goalId?: string
  readonly reason: 'human-gate' | 'claim-overruled' | 'strategy-switch' | 'task-passed' | 'goal-finished' | 'architecture-drift'
  readonly detail: string
}

export interface RunTaskResult {
  readonly task: Task
  readonly receipts: readonly Receipt[]
  readonly humanGate?: HumanGate
}

export class LoopEngine {
  readonly store: StateStore
  readonly verifier: Verifier
  readonly executor: WorkerExecutor
  readonly architecture?: ArchitectureHooks
  private readonly onChiefWake?: EngineOptions['onChiefWake']
  private readonly memory?: EngineOptions['memory']
  private readonly running = new Map<string, AbortController>()

  constructor(options: EngineOptions) {
    this.store = options.store
    this.verifier = options.verifier
    this.executor = options.executor
    this.architecture = options.architecture
    this.onChiefWake = options.onChiefWake
    this.memory = options.memory
  }

  gatesFor(project: Project, task: Task): GateSpec[] {
    return [...(task.gates.length ? task.gates : project.defaultGates)]
  }

  /** Abort a running task's current Worker and stop the loop at the next checkpoint. */
  stop(projectId: string, taskId: string): Task {
    const task = this.store.updateTask(projectId, taskId, { stopRequested: true })
    this.running.get(taskId)?.abort()
    if (!this.running.has(taskId) && !TERMINAL_TASK_STATES.includes(task.state)) {
      return this.store.updateTask(projectId, taskId, { state: 'stopped' })
    }
    return task
  }

  /** Queue steer text for the next Worker attempt. */
  steer(projectId: string, taskId: string, text: string): Task {
    const task = this.store.updateTask(projectId, taskId, { steer: text })
    this.store.emitTyped('task/steer', projectId, { text }, { taskId, goalId: task.goalId })
    return task
  }

  isRunning(taskId: string): boolean { return this.running.has(taskId) }

  /**
   * Run the loop for one task until PASS, Human Gate, stop, or budget exhaustion.
   * Resumable: re-running a non-terminal task continues from its recorded attempts.
   */
  async runTask(projectId: string, taskId: string): Promise<RunTaskResult> {
    if (this.running.has(taskId)) throw new Error(`task ${taskId} is already running`)
    const controller = new AbortController()
    this.running.set(taskId, controller)
    const receipts: Receipt[] = []
    try {
      const project = this.store.requireProject(projectId)
      let task = this.store.requireTask(projectId, taskId)
      if (TERMINAL_TASK_STATES.includes(task.state) || task.state === 'human_gate') return { task, receipts }
      if (task.stopRequested) return { task: this.store.updateTask(projectId, taskId, { state: 'stopped' }), receipts }

      for (;;) {
        const strategy: RetryStrategy = task.nextStrategy ?? availableStrategies(task)[0] ?? 'retry-with-feedback'
        const n = task.attempts.length + 1
        const model = modelForStrategy(task.policy, strategy)
        const worker = this.store.createWorker({ taskId, projectId, attempt: n, executor: this.executor.name, model })
        const attempt: Attempt = { n, strategy, model, workerId: worker.id, startedAt: now() }
        const steer = task.steer
        task = this.store.updateTask(projectId, taskId, { state: 'executing', attempts: [...task.attempts, attempt], steer: undefined })

        const before = snapshotTree(project.root)
        const previous = task.attempts.at(-2)
        const previousSessionId = previous ? this.store.getWorker(projectId, previous.workerId)?.sessionId : undefined
        this.store.updateWorker(projectId, worker.id, { status: 'running' })
        const output = await this.safeRun({
          project, task, worker, attempt: n, strategy, model,
          feedback: this.feedbackFor(projectId, task),
          previousSessionId: strategy === 'retry-with-feedback' ? previousSessionId : undefined,
          steer,
          memory: this.memory?.(projectId),
          stateHome: this.store.home,
          report: partial => {
            const report = parseWorkerReport(partial, { task_id: taskId, model })
            this.store.appendReport(projectId, worker.id, report)
          },
          signal: controller.signal,
        })
        this.store.updateWorker(projectId, worker.id, {
          status: output.exit === 'cancelled' ? 'killed' : 'exited', endedAt: now(), sessionId: output.sessionId,
        })

        task = this.store.requireTask(projectId, taskId)
        if (task.stopRequested || output.exit === 'cancelled') {
          task = this.closeAttempt(task, { endedAt: now() })
          return { task: this.store.updateTask(projectId, taskId, { state: 'stopped', attempts: task.attempts }), receipts }
        }

        const reports = this.store.readReports(projectId, worker.id)
        const lastReport = reports.at(-1)
        const claim = workerClaim(reports)
        const changedFiles = diffSnapshots(before, snapshotTree(project.root), project.root)
        const reportedModules = [...new Set(reports.flatMap(r => r.changed_modules))]
        const detectedModules = this.architecture?.modulesForFiles(project, changedFiles) ?? []
        const changedModules = [...new Set([...detectedModules, ...reportedModules])].sort()
        const impactedModules = this.architecture?.impactOf(project, changedModules) ?? []

        task = this.store.updateTask(projectId, taskId, { state: 'verifying' })
        const gates = this.gatesFor(project, task)
        const draft = await this.verifier.verify({
          task, projectRoot: project.root, attempt: n, gates, workerClaim: claim, model, strategy,
          changedFiles, changedModules, impactedModules, signal: controller.signal,
        })
        // Gates are the authority even when the Worker process crashed or timed out.
        const receipt = this.store.createReceipt(draft)
        receipts.push(receipt)
        if (receipt.claimOverruled) {
          await this.wake({ projectId, taskId, goalId: task.goalId, reason: 'claim-overruled', detail: `attempt ${n}: worker claimed PASS; ${receipt.reason}` })
        }
        await this.architecture?.refresh?.(project)

        task = this.closeAttempt(this.store.requireTask(projectId, taskId), {
          endedAt: now(), receiptId: receipt.id, verdict: receipt.verdict, failureSignature: receiptSignature(receipt),
        })
        task = this.store.updateTask(projectId, taskId, { attempts: task.attempts })

        const decision = decideNext({ task, attempts: task.attempts, receipt, lastReport, protectedModules: project.protectedModules })
        this.store.emitTyped('loop/decision', projectId, { attempt: n, decision, workerExit: output.exit }, { taskId, goalId: task.goalId })

        const outcome = await this.apply(project, task, decision, receipts)
        if (outcome) return outcome
        task = this.store.requireTask(projectId, taskId)
        if (task.stopRequested) return { task: this.store.updateTask(projectId, taskId, { state: 'stopped' }), receipts }
      }
    } finally {
      this.running.delete(taskId)
    }
  }

  private async apply(project: Project, task: Task, decision: LoopDecision, receipts: Receipt[]): Promise<RunTaskResult | undefined> {
    const pid = project.id
    switch (decision.action) {
      case 'pass': {
        const done = this.store.updateTask(pid, task.id, { state: 'passed', nextStrategy: undefined })
        await this.wake({ projectId: pid, taskId: task.id, goalId: task.goalId, reason: 'task-passed', detail: decision.reason })
        return { task: done, receipts }
      }
      case 'retry': {
        this.store.updateTask(pid, task.id, { state: 'retrying', nextStrategy: decision.strategy })
        if (decision.switched) {
          await this.wake({ projectId: pid, taskId: task.id, goalId: task.goalId, reason: 'strategy-switch', detail: decision.reason })
        }
        return undefined
      }
      case 'human_gate': {
        const gate = this.store.openHumanGate({ projectId: pid, taskId: task.id, reason: decision.reason, detail: decision.detail })
        const blocked = this.store.updateTask(pid, task.id, { state: 'human_gate', humanGateId: gate.id })
        await this.wake({ projectId: pid, taskId: task.id, goalId: task.goalId, reason: 'human-gate', detail: `${decision.reason}: ${decision.detail}` })
        return { task: blocked, receipts, humanGate: gate }
      }
      default: {
        const never: never = decision
        throw new Error(`unknown loop decision ${JSON.stringify(never)}`)
      }
    }
  }

  /**
   * Apply a human decision to a gated task.
   * approved: protected-module with a PASS receipt → passed; otherwise the task
   * re-enters the loop with a fresh attempt budget and the resolution as steer.
   * rejected: the task fails.
   */
  resolveHumanGate(projectId: string, gateId: string, decision: 'approved' | 'rejected', resolution: string): Task | undefined {
    const gate = this.store.resolveHumanGate(projectId, gateId, decision, resolution)
    if (!gate.taskId) return undefined
    const task = this.store.requireTask(projectId, gate.taskId)
    if (task.state !== 'human_gate' || task.humanGateId !== gateId) return task
    if (decision === 'rejected') return this.store.updateTask(projectId, task.id, { state: 'failed' })
    const last = task.attempts.at(-1)
    if (gate.reason === 'protected-module' && last?.verdict === 'PASS') return this.store.updateTask(projectId, task.id, { state: 'passed' })
    return this.store.updateTask(projectId, task.id, {
      state: 'pending',
      steer: resolution || undefined,
      nextStrategy: availableStrategies(task)[0],
      policy: { ...task.policy, maxAttempts: task.attempts.length + task.policy.maxAttempts },
    })
  }

  /** Startup recovery: Workers that were running when the process died are marked killed. */
  recoverInterrupted(projectId: string): Task[] {
    const recovered: Task[] = []
    for (const worker of this.store.listWorkers(projectId)) {
      if (worker.status === 'running' || worker.status === 'starting') {
        this.store.updateWorker(projectId, worker.id, { status: 'killed', endedAt: now() })
      }
    }
    for (const task of this.store.listTasks(projectId)) {
      if ((task.state === 'executing' || task.state === 'verifying') && !this.running.has(task.id)) {
        const closed = this.closeAttempt(task, { endedAt: now() })
        recovered.push(this.store.updateTask(projectId, task.id, { state: 'retrying', attempts: closed.attempts }))
      }
    }
    return recovered
  }

  /** An executor that throws is a crashed attempt, never a stuck task. */
  private async safeRun(input: Parameters<WorkerExecutor['run']>[0]): Promise<Awaited<ReturnType<WorkerExecutor['run']>>> {
    try {
      return await this.executor.run(input)
    } catch (error) {
      return { exit: input.signal.aborted ? 'cancelled' : 'crashed', diagnostics: String((error as Error).stack ?? error) }
    }
  }

  private closeAttempt(task: Task, change: Partial<Attempt>): Task {
    const attempts = [...task.attempts]
    const last = attempts.pop()
    if (!last) return task
    return { ...task, attempts: [...attempts, { ...last, ...change }] }
  }

  private feedbackFor(projectId: string, task: Task): AttemptFeedback[] {
    return task.attempts
      .filter(a => a.receiptId)
      .map(a => {
        const r = this.store.getReceipt(projectId, a.receiptId!)!
        return {
          attempt: a.n, strategy: a.strategy, verdict: r.verdict, reason: r.reason, workerClaim: r.workerClaim, claimOverruled: r.claimOverruled,
          failingGates: r.gateResults.filter(g => g.status !== 'pass').map(g => ({ gateId: g.gateId, status: g.status, summary: g.summary, outputTail: g.outputTail })),
        }
      })
  }

  private async wake(wake: ChiefWake): Promise<void> {
    this.store.emitTyped('chief/wake', wake.projectId, { reason: wake.reason, detail: wake.detail }, { taskId: wake.taskId, goalId: wake.goalId })
    await this.onChiefWake?.(wake)
  }
}

/** The Worker's final claim: from its last `result` report, else its last report. */
export function workerClaim(reports: readonly WorkerReport[]): WorkerClaim {
  const result = [...reports].reverse().find(r => r.kind === 'result') ?? reports.at(-1)
  return result?.verification_result ?? 'not_run'
}
