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

/** Roles a model can be assigned to (Directive §4.F). */
export type ModelRole = 'chief' | 'worker' | 'reviewer' | 'escalation' | 'planner'

/**
 * One layer of model/loop policy. Layers resolve defaults ← global ← project ← task pin.
 * Global lives in `$SUPERAGENT_HOME/policy.json`, project in the project record —
 * never in the Worker-writable tree.
 */
export interface PolicyLayer {
  readonly models?: Partial<Record<ModelRole, ModelRef>>
  readonly maxAttempts?: number
  readonly maxSameFailure?: number
  readonly strategies?: readonly RetryStrategy[]
}

// ---------------------------------------------------------------- project / goal

export interface Project {
  readonly id: ProjectId
  readonly name: string
  /** Absolute path of the project working tree. */
  readonly root: string
  readonly createdAt: IsoTime
  /** Default gates applied to tasks that name none (human-defined; part of the registry). */
  readonly defaultGates: readonly GateSpec[]
  /** Module ids that Workers may not change without a Human Gate. */
  readonly protectedModules: readonly string[]
  /**
   * Gate Registry: the only gate definitions a model-originated task may reference (by id).
   * Human-edited through the privileged API/CLI; stored outside the worktree.
   */
  readonly gateRegistry?: readonly GateSpec[]
  /** Verification-integrity policy; defaults apply when absent. */
  readonly verification?: VerificationPolicy
  /** Project-level model/loop policy layer (human-edited). */
  readonly policy?: PolicyLayer
}

/** What counts as a verification asset and what the Worker environment may not change. */
export interface VerificationPolicy {
  /** Globs of verification assets (tests, gate scripts, runner configs). Worker edits ⇒ integrity FAIL. */
  readonly protectedPaths: readonly string[]
  /** Ignored dependency/environment roots whose modification without a lockfile change ⇒ FAIL. */
  readonly envRoots: readonly string[]
  /** Lockfiles whose change legitimizes environment-root changes (surfaced, not failed). */
  readonly lockfiles: readonly string[]
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
  /** The goal should be (re)run; cleared when a run ends. Lets a restarted server resume it. */
  readonly runRequested?: boolean
  /** The plain-language request this goal came from, if any. */
  readonly request?: string
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
  /** Git snapshot commit of the full working tree before the Worker ran. */
  readonly baseSnapshot?: string
  /** Snapshot after the Worker ran (what was verified). */
  readonly afterSnapshot?: string
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
  /** Roles whose model was explicitly chosen for this task; other roles follow live defaults. */
  readonly pinnedModels?: Partial<Record<ModelRole, ModelRef>>
  /** Human-granted permissions for this task (never set by model tools). */
  readonly grants?: TaskGrants
  /** Pre-attempt gate run on the untouched tree: which named tests exist (anti-suppression). */
  readonly baseline?: TaskBaseline
  /** Strategy chosen by the loop policy for the next attempt. */
  readonly nextStrategy?: RetryStrategy
  /** Set by Stop; the engine halts at the next checkpoint. */
  readonly stopRequested?: boolean
  /** Require a reviewer's approval after gates PASS (the reviewer can block, never pass). */
  readonly review?: boolean
  /** Reviewer verdicts, oldest first. */
  readonly reviews?: readonly ReviewRecord[]
}

export interface ReviewRecord {
  readonly attempt: number
  readonly approve: boolean
  readonly comments: string
  readonly reviewer: string
  readonly at: IsoTime
}

export interface TaskGrants {
  /** Allow changes to verification assets; a PASS still requires human review of them. */
  readonly mayModifyVerification?: boolean
  /** Exact actions a human approved after the pre-tool guard blocked them. */
  readonly approvedActions?: readonly ApprovedAction[]
}

export interface ApprovedAction {
  /** Stable fingerprint of tool name + normalized arguments. */
  readonly fingerprint: string
  readonly summary: string
  readonly approvedAt: IsoTime
}

export interface TaskBaseline {
  readonly takenAt: IsoTime
  readonly snapshot?: string
  /** gateId → test identities observed (all outcomes) and their status. */
  readonly gates: Record<string, { readonly status: GateStatus; readonly tests: readonly string[] }>
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
  /** OS process (group leader) of an out-of-process Worker, for recovery. */
  readonly pid?: number
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
  /** Files this gate depends on (scripts, configs); treated as protected verification assets. */
  readonly assets?: readonly string[]
  /** With a parser: fewer executed tests ⇒ FAIL. Zero tests always FAILs. */
  readonly minTests?: number
  /** Extra environment for the gate process (the rest is an allowlist, not inherited). */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Held-out verification: test files kept outside the Worker's reach (under
   * `$SUPERAGENT_HOME/heldout/…`) and copied, only for this gate run, into a throwaway
   * verification worktree at `mountAt`. The Worker never sees or edits them.
   */
  readonly heldOut?: { readonly source: string; readonly mountAt: string }
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
  /** Test identities with outcome, when the parser can extract them. */
  readonly tests?: ReadonlyArray<{ readonly name: string; readonly ok: boolean }>
  /** Normalized failure identity used by the loop breaker; absent on pass. */
  readonly failureSignature?: string
  readonly details?: Record<string, unknown>
  /** Ran against held-out tests; its output is never shown to the Worker. */
  readonly heldOut?: boolean
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
  /** Verification-integrity findings for this attempt. */
  readonly integrity?: IntegrityReport
  readonly createdAt: IsoTime
}

export type IntegrityFindingKind =
  | 'verification-asset-modified'
  | 'package-scripts-modified'
  | 'environment-modified'
  | 'dependencies-changed'
  | 'head-moved'
  | 'baseline-test-missing'
  | 'not-a-git-repository'

export interface IntegrityFinding {
  readonly kind: IntegrityFindingKind
  /** `block` fails the verdict; `review` requires a human even on PASS; `info` is surfaced only. */
  readonly severity: 'block' | 'review' | 'info'
  readonly paths: readonly string[]
  readonly detail: string
}

export interface IntegrityReport {
  readonly baseSnapshot?: string
  readonly afterSnapshot?: string
  readonly findings: readonly IntegrityFinding[]
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
  | 'verification-change'
  | 'dangerous-action'
  | 'review-disagreement'

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
  /** Tool calls blocked before execution; approval authorizes exactly these fingerprints. */
  readonly actions?: readonly BlockedAction[]
}

/** A tool call the pre-tool guard denied, pending a human decision. */
export interface BlockedAction {
  readonly fingerprint: string
  readonly tool: string
  readonly summary: string
  readonly category: HumanGateReason
  readonly rule: string
  readonly workerId?: WorkerId
  readonly taskId?: TaskId
  readonly at: IsoTime
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
  | 'request/submitted'
  | 'review/completed'

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
