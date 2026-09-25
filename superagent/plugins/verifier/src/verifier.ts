/**
 * Independent verification (Freeze §6.1-6, §8, rule 8).
 *
 * The verdict is computed only from gate results. The Worker's claim is recorded
 * next to it; a claimed PASS with failing gates is marked `claimOverruled`.
 * A task with no required gates can never PASS: "the model thinks it is done"
 * is not a verification.
 */
import type { GateKind, GateResult, GateSpec, ModelRef, Receipt, RetryStrategy, Task, Verdict, WorkerClaim } from '@superagent/contracts'
import { runCommandGate } from './command.ts'
import { runHygieneGate } from './hygiene.ts'

export interface GateContext {
  readonly projectRoot: string
  readonly task: Task
  readonly changedFiles: readonly string[]
  readonly signal?: AbortSignal
}

export type GateRunner = (spec: GateSpec, ctx: GateContext) => Promise<GateResult> | GateResult

export interface VerifyInput {
  readonly task: Task
  readonly projectRoot: string
  readonly attempt: number
  readonly gates: readonly GateSpec[]
  readonly workerClaim: WorkerClaim
  readonly model: ModelRef
  readonly strategy: RetryStrategy
  readonly changedFiles: readonly string[]
  readonly changedModules: readonly string[]
  readonly impactedModules: readonly string[]
  readonly signal?: AbortSignal
}

export type ReceiptDraft = Omit<Receipt, 'id' | 'createdAt'>

export class Verifier {
  private readonly runners = new Map<GateKind, GateRunner>()

  constructor() {
    this.runners.set('command', (spec, ctx) => runCommandGate(spec, ctx.projectRoot, ctx.signal))
    this.runners.set('e2e', (spec, ctx) => runCommandGate({ ...spec, parser: spec.parser ?? 'playwright-json' }, ctx.projectRoot, ctx.signal))
    this.runners.set('hygiene', (spec, ctx) => runHygieneGate(spec, ctx.projectRoot))
  }

  /** Register or replace a gate runner (e.g. the Observatory's `architecture-drift`). @returns disposer. */
  register(kind: GateKind, runner: GateRunner): () => void {
    const previous = this.runners.get(kind)
    this.runners.set(kind, runner)
    return () => {
      if (previous) this.runners.set(kind, previous)
      else this.runners.delete(kind)
    }
  }

  async runGate(spec: GateSpec, ctx: GateContext): Promise<GateResult> {
    const runner = this.runners.get(spec.kind)
    if (!runner) {
      return { gateId: spec.id, kind: spec.kind, required: spec.required, status: 'error', durationMs: 0, summary: `no runner registered for gate kind ${spec.kind}`, outputTail: '', failureSignature: `${spec.id}:no-runner` }
    }
    try {
      return await runner(spec, ctx)
    } catch (error) {
      return { gateId: spec.id, kind: spec.kind, required: spec.required, status: 'error', durationMs: 0, summary: `gate crashed: ${String(error)}`, outputTail: String((error as Error).stack ?? error), failureSignature: `${spec.id}:crash` }
    }
  }

  /**
   * Run every gate sequentially and produce a receipt draft.
   * @returns the draft; persisting it is the caller's job.
   */
  async verify(input: VerifyInput): Promise<ReceiptDraft> {
    const ctx: GateContext = { projectRoot: input.projectRoot, task: input.task, changedFiles: input.changedFiles, signal: input.signal }
    const results: GateResult[] = []
    for (const spec of input.gates) results.push(await this.runGate(spec, ctx))
    const { verdict, reason } = decideVerdict(results)
    return {
      projectId: input.task.projectId,
      taskId: input.task.id,
      attempt: input.attempt,
      verdict,
      reason,
      gateResults: results,
      workerClaim: input.workerClaim,
      claimOverruled: input.workerClaim === 'claimed_pass' && verdict === 'FAIL',
      model: input.model,
      strategy: input.strategy,
      changedFiles: input.changedFiles,
      changedModules: input.changedModules,
      impactedModules: input.impactedModules,
    }
  }
}

/** Pure verdict rule. */
export function decideVerdict(results: readonly GateResult[]): { verdict: Verdict; reason: string } {
  const required = results.filter(r => r.required)
  if (required.length === 0) return { verdict: 'FAIL', reason: 'no required gates: a Worker claim alone cannot PASS' }
  const bad = required.filter(r => r.status !== 'pass')
  if (bad.length) return { verdict: 'FAIL', reason: `required gates not passing: ${bad.map(r => `${r.gateId}=${r.status}`).join(', ')}` }
  return { verdict: 'PASS', reason: `all ${required.length} required gates passed` }
}

/** Combined failure signature of a receipt (stable across attempts for "same failure"). */
export function receiptSignature(receipt: Pick<Receipt, 'gateResults'>): string | undefined {
  const sigs = receipt.gateResults.filter(r => r.required && r.status !== 'pass').map(r => r.failureSignature ?? `${r.gateId}:${r.status}`)
  return sigs.length ? sigs.sort().join('|') : undefined
}
