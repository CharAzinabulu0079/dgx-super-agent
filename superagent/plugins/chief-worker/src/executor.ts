/**
 * Worker executor seam. A Worker is a short-lived, task-scoped agent session
 * (Freeze §6.2). Executors run one attempt; they never decide PASS.
 */
import type { ModelRef, Project, Receipt, RetryStrategy, Task, Worker, WorkerReport } from '@superagent/contracts'
import type { ToolPolicy } from '@superagent/loop-policy'

export interface AttemptFeedback {
  readonly attempt: number
  readonly strategy: RetryStrategy
  readonly verdict: Receipt['verdict']
  readonly reason: string
  readonly failingGates: ReadonlyArray<{ gateId: string; status: string; summary: string; outputTail: string }>
  readonly workerClaim: Receipt['workerClaim']
  readonly claimOverruled: boolean
  /** Integrity findings (tampering with verification assets/environment). */
  readonly integrity?: readonly string[]
}

export interface WorkerRunInput {
  readonly project: Project
  readonly task: Task
  readonly worker: Worker
  readonly attempt: number
  readonly strategy: RetryStrategy
  readonly model: ModelRef
  /** Previous attempts' independent verification results, newest last. */
  readonly feedback: readonly AttemptFeedback[]
  /** DSH session id of the previous attempt, for strategies that continue it. */
  readonly previousSessionId?: string
  readonly steer?: string
  /** Human-approved project memory (promoted Learning items). */
  readonly memory?: readonly string[]
  /** Promoted (or, during replay, candidate) skills/procedures. */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly body: string }>
  /** Pre-tool policy the Worker's tool calls are judged by (enforced inside DSH by the bundle guard). */
  readonly toolPolicy?: ToolPolicy
  /** SuperAgent state home, so out-of-process Workers can report into the store. */
  readonly stateHome: string
  /** Record a structured report (in-process executors). */
  readonly report: (report: Omit<WorkerReport, 'task_id' | 'model'> & Partial<Pick<WorkerReport, 'task_id' | 'model'>>) => void
  readonly signal: AbortSignal
  /** Out-of-process executors report their process-group leader pid for crash recovery. */
  readonly onSpawn?: (pid: number) => void
}

export interface WorkerRunOutput {
  readonly exit: 'completed' | 'crashed' | 'cancelled' | 'timeout'
  readonly sessionId?: string
  readonly finalText?: string
  readonly diagnostics?: string
}

export interface WorkerExecutor {
  readonly name: string
  run(input: WorkerRunInput): Promise<WorkerRunOutput>
}

/** A test/demo executor whose behaviour is a plain function (no model). */
export class ScriptedExecutor implements WorkerExecutor {
  readonly name = 'scripted'
  private readonly script: (input: WorkerRunInput) => Promise<WorkerRunOutput | void> | WorkerRunOutput | void

  constructor(script: (input: WorkerRunInput) => Promise<WorkerRunOutput | void> | WorkerRunOutput | void) {
    this.script = script
  }

  async run(input: WorkerRunInput): Promise<WorkerRunOutput> {
    try {
      return (await this.script(input)) ?? { exit: 'completed' }
    } catch (error) {
      return { exit: 'crashed', diagnostics: String((error as Error).stack ?? error) }
    }
  }
}
