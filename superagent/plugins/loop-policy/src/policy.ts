/**
 * Loop Policy (Freeze §6.2 / §6.3 / §15 "连续失败会切换策略或升级").
 *
 * A pure function from the task's attempt history to the next step. Routine
 * failures (build/test/lint/E2E) are retried by the loop; only the §6.3 cases
 * escalate to a Human Gate.
 */
import type { Attempt, BlockedAction, HumanGateReason, Receipt, RetryStrategy, Task, WorkerReport } from '@superagent/contracts'

export type LoopDecision =
  | { readonly action: 'pass'; readonly reason: string }
  | { readonly action: 'retry'; readonly strategy: RetryStrategy; readonly reason: string; readonly switched: boolean }
  | { readonly action: 'human_gate'; readonly reason: HumanGateReason; readonly detail: string; readonly actions?: readonly BlockedAction[] }

export interface LoopInput {
  readonly task: Task
  /** Completed attempts including the one just verified (with verdict + signature). */
  readonly attempts: readonly Attempt[]
  readonly receipt: Pick<Receipt, 'verdict' | 'reason' | 'changedModules' | 'integrity'>
  readonly lastReport?: WorkerReport
  readonly protectedModules: readonly string[]
  /** Tool calls the pre-tool guard blocked during this attempt. */
  readonly blockedActions?: readonly BlockedAction[]
}

/** Strategies usable under this policy (escalate-model requires an escalation model). */
export function availableStrategies(task: Task): RetryStrategy[] {
  return task.policy.strategies.filter(s => s !== 'escalate-model' || task.policy.model.escalation !== undefined)
}

/** Number of trailing attempts that failed with `signature` under `strategy`. */
export function trailingSameFailures(attempts: readonly Attempt[], signature: string | undefined, strategy: RetryStrategy): number {
  if (!signature) return 0
  let n = 0
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i]!
    if (a.verdict !== 'FAIL' || a.failureSignature !== signature || a.strategy !== strategy) break
    n++
  }
  return n
}

export function decideNext(input: LoopInput): LoopDecision {
  const { task, attempts, receipt, lastReport } = input
  const last = attempts.at(-1)
  if (!last) throw new Error('decideNext requires at least one completed attempt')

  // Blocked dangerous actions need a human before anything else, green or not.
  const blocked = input.blockedActions ?? []
  if (blocked.length) {
    const unique = [...new Map(blocked.map(a => [a.fingerprint, a])).values()]
    return { action: 'human_gate', reason: unique[0]!.category, detail: `blocked before execution: ${unique.map(a => `[${a.category}] ${a.rule} — ${a.summary}`).join('; ')}`, actions: unique }
  }
  const touchedProtected = receipt.changedModules.filter(m => input.protectedModules.includes(m))
  if (touchedProtected.length) {
    return { action: 'human_gate', reason: 'protected-module', detail: `attempt ${last.n} changed protected modules: ${touchedProtected.join(', ')}` }
  }
  // A Worker's request for a human decision wins over a green verdict: passing
  // gates say nothing about product direction or irreversible operations.
  if (lastReport?.human_required) {
    return { action: 'human_gate', reason: 'worker-requested', detail: lastReport.blocker ?? lastReport.summary ?? 'worker requested a human decision' }
  }
  const review = (receipt.integrity?.findings ?? []).filter(f => f.severity === 'review')
  if (receipt.verdict === 'PASS' && review.length) {
    return { action: 'human_gate', reason: 'verification-change', detail: `PASS depends on changed verification assets (human-granted): ${review.map(f => f.detail).join('; ')}` }
  }
  if (receipt.verdict === 'PASS') return { action: 'pass', reason: receipt.reason }
  if (attempts.length >= task.policy.maxAttempts) {
    return { action: 'human_gate', reason: 'repeated-failure', detail: `attempt budget exhausted (${attempts.length}/${task.policy.maxAttempts}); last: ${receipt.reason}` }
  }

  const strategies = availableStrategies(task)
  const current = last.strategy
  const same = trailingSameFailures(attempts, last.failureSignature, current)
  if (same >= task.policy.maxSameFailure) {
    const idx = strategies.indexOf(current)
    const next = strategies[idx + 1]
    if (!next) {
      return {
        action: 'human_gate',
        reason: 'repeated-failure',
        detail: `same failure ${last.failureSignature} ×${same}; all strategies exhausted (${strategies.join(' → ')})`,
      }
    }
    return { action: 'retry', strategy: next, switched: true, reason: `same failure ×${same} under ${current}; switching to ${next}` }
  }
  return { action: 'retry', strategy: current, switched: false, reason: `retry under ${current}: ${receipt.reason}` }
}
