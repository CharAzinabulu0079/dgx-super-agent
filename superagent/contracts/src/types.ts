/**
 * SuperAgent shared contracts (Freeze §5 `contracts/`, §6, §7, §10, §11).
 *
 * Every record here is plain JSON: it is written to the state store, streamed to
 * clients, and (for WorkerReport) produced by models, so it must survive a
 * JSON round-trip unchanged.
 */

export type ProjectId = string
export type GoalId = string
export type TaskId = string
export type WorkerId = string
export type ReceiptId = string
export type GateId = string
export type HumanGateId = string

export type IsoTime = string

// ---------------------------------------------------------------- model policy

/** A concrete model route. `provider` is a DSH LLM route name (e.g. `deepseek`, `anthropic`, `local`). */
export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/** Freeze §11: per-task manual model selection. No automatic router in v0.1. */
export interface TaskPolicy {
  readonly model: {
    readonly planner?: ModelRef
    readonly worker: ModelRef
    readonly reviewer?: ModelRef
    /** Used by the `escalate-model` retry strategy; absent → strategy is skipped. */
    readonly escalation?: ModelRef
  }
  readonly production_write: boolean
  /** Hard cap on Worker attempts for one task. */
  readonly maxAttempts: number
  /** Same failure signature this many times in a row under one strategy → switch strategy. */
  readonly maxSameFailure: number
  /** Ordered retry strategies; the loop advances through them on repeated failure. */
  readonly strategies: readonly RetryStrategy[]
}

export type RetryStrategy = 'retry-with-feedback' | 'fresh-context' | 'escalate-model'

// ---------------------------------------------------------------- project / goal

export interface Project {
  readonly id: ProjectId
  readonly name: string
  /** Absolute path of the project working tree. */
  readonly root: string
  readonly createdAt: IsoTime
  /** Default gates applied to tasks that name none. */
  readonly defaultGates: readonly GateSpec[]
  /** Module ids that Workers may not change without a Human Gate. */
  readonly protectedModules: readonly string[]
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'failed'

export interface Goal {
  readonly id: GoalId
  readonly projectId: ProjectId
  readonly objective: string
  readonly status: GoalStatus
  readonly taskIds: readonly TaskId[]
  readonly createdAt: IsoTime
  readonly updatedAt: IsoTime
  readonly blocker?: string
}

// ---------------------------------------------------------------- task / loop

/** Freeze §6.2 Worker loop states, as tracked by the engine (not self-reported). */
export type TaskState =
  | 'pending'
  | 'executing'
  | 'verifying'
  | 'retrying'
  | 'passed'
  | 'failed'
  | 'human_gate'
  | 'stopped'

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['passed', 'failed', 'stopped']

export interface TaskScope {
  /** Paths (relative to project root) the Worker is expected to touch. */
  readonly paths: readonly string[]
  /** Architecture module ids the task targets. */
  readonly modules: readonly string[]
}

export interface Attempt {
  readonly n: number
  readonly strategy: RetryStrategy
  readonly model: ModelRef
  readonly workerId: WorkerId
  readonly startedAt: IsoTime
  readonly endedAt?: IsoTime
  readonly receiptId?: ReceiptId
  readonly verdict?: Verdict
  readonly failureSignature?: string
}

export interface Task {
  readonly id: TaskId
  readonly projectId: ProjectId
  readonly goalId: GoalId
  readonly title: string
  readonly instructions: string
  readonly scope: TaskScope
  /** Gates to run; empty → project defaults. */
  readonly gates: readonly GateSpec[]
  readonly policy: TaskPolicy
  readonly state: TaskState
  readonly attempts: readonly Attempt[]
  readonly createdAt: IsoTime
  readonly updatedAt: IsoTime
  readonly humanGateId?: HumanGateId
  /** Pending steer text for the next attempt (user "Steer"). */
  readonly steer?: string
  /** Strategy chosen by the loop policy for the next attempt. */
  readonly nextStrategy?: RetryStrategy
  /** Set by Stop; the engine halts at the next checkpoint. */
  readonly stopRequested?: boolean
}

// ---------------------------------------------------------------- worker

export type WorkerStatus = 'starting' | 'running' | 'exited' | 'killed'

export interface Worker {
  readonly id: WorkerId
  readonly taskId: TaskId
  readonly projectId: ProjectId
  readonly attempt: number
  readonly executor: string
  readonly model: ModelRef
  readonly status: WorkerStatus
  readonly startedAt: IsoTime
  readonly endedAt?: IsoTime
  /** DSH session id when the executor is DSH-backed. */
  readonly sessionId?: string
  /** Modules the Worker last reported changing (drives Observatory "Worker Active"). */
  readonly activeModules: readonly string[]
  readonly lastReport?: WorkerReport
}

export type WorkerReportKind = 'progress' | 'blocker' | 'result'

/** The Worker's own claim. It is recorded, never trusted as PASS (Freeze §6, rule 8). */
export type WorkerClaim = 'claimed_pass' | 'claimed_fail' | 'not_run'

/** Freeze §6.2 structured Worker report. */
export interface WorkerReport {
  readonly task_id: TaskId
  readonly kind: WorkerReportKind
  readonly current_state: string
  /** 0–100. */
  readonly progress: number
  readonly changed_modules: readonly string[]
  readonly verification_result: WorkerClaim
  readonly blocker: string | null
  readonly next_action: string | null
  readonly human_required: boolean
  readonly model: ModelRef
  readonly summary: string
  readonly at?: IsoTime
}

// ---------------------------------------------------------------- verification

export type GateKind = 'command' | 'e2e' | 'architecture-drift' | 'hygiene'
export type GateParser = 'exit-code' | 'node-test' | 'playwright-json'

export interface GateSpec {
  readonly id: GateId
  readonly kind: GateKind
  /** Shell command for `command` / `e2e` gates, run in `cwd` (relative to project root). */
  readonly command?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  /** A non-required gate reports but cannot fail the verdict. */
  readonly required: boolean
  readonly parser?: GateParser
}

export type GateStatus = 'pass' | 'fail' | 'error' | 'skipped'

export interface GateResult {
  readonly gateId: GateId
  readonly kind: GateKind
  readonly status: GateStatus
  readonly required: boolean
  readonly durationMs: number
  readonly summary: string
  /** Last lines of output, for Worker feedback and humans. */
  readonly outputTail: string
  /** Normalized failure identity used by the loop breaker; absent on pass. */
  readonly failureSignature?: string
  readonly details?: Record<string, unknown>
}

export type Verdict = 'PASS' | 'FAIL'

/** Independent verification record for one attempt. */
export interface Receipt {
  readonly id: ReceiptId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly attempt: number
  readonly verdict: Verdict
  readonly reason: string
  readonly gateResults: readonly GateResult[]
  readonly workerClaim: WorkerClaim
  /** True when the Worker claimed PASS but gates disagreed. */
  readonly claimOverruled: boolean
  readonly model: ModelRef
  readonly strategy: RetryStrategy
  readonly changedFiles: readonly string[]
  readonly changedModules: readonly string[]
  readonly impactedModules: readonly string[]
  readonly createdAt: IsoTime
}

// ---------------------------------------------------------------- human gate

/** Freeze §6.3 escalation reasons. Routine build/test failures are NOT here. */
export type HumanGateReason =
  | 'product-direction'
  | 'architecture-boundary'
  | 'irreversible-data'
  | 'permission-expansion'
  | 'production-deploy'
  | 'priority-sacrifice'
  | 'repeated-failure'
  | 'protected-module'
  | 'worker-requested'

export type HumanGateStatus = 'open' | 'approved' | 'rejected'

export interface HumanGate {
  readonly id: HumanGateId
  readonly projectId: ProjectId
  readonly taskId?: TaskId
  readonly reason: HumanGateReason
  readonly detail: string
  readonly status: HumanGateStatus
  readonly createdAt: IsoTime
  readonly resolvedAt?: IsoTime
  readonly resolution?: string
}

// ---------------------------------------------------------------- events

export type SuperAgentEventType =
  | 'project/created'
  | 'goal/created'
  | 'goal/updated'
  | 'task/created'
  | 'task/state'
  | 'task/steer'
  | 'worker/started'
  | 'worker/report'
  | 'worker/exited'
  | 'receipt/created'
  | 'loop/decision'
  | 'human-gate/opened'
  | 'human-gate/resolved'
  | 'chief/wake'
  | 'architecture/updated'
  | 'architecture/drift'
  | 'learning/candidate'
  | 'learning/promoted'
  | 'learning/archived'

/** Append-only, per-project event (events.jsonl). `seq` is monotonic per project. */
export interface SuperAgentEvent {
  readonly seq: number
  readonly ts: IsoTime
  readonly type: SuperAgentEventType
  readonly projectId: ProjectId
  readonly goalId?: GoalId
  readonly taskId?: TaskId
  readonly workerId?: WorkerId
  readonly data: Record<string, unknown>
}
