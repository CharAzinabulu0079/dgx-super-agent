/**
 * Deterministic Chief wake policy (Directive §4.C). Decides, per durable event,
 * whether the expensive Chief model must look. Ordinary progress stays state only.
 */
import type { SuperAgentEvent } from '@superagent/contracts'

export type WakeReason =
  | 'human-gate'
  | 'repeated-failure'
  | 'claim-overruled'
  | 'integrity-violation'
  | 'architecture-drift'
  | 'architecture-impact'
  | 'worker-blocker'
  | 'final-review'
  | 'goal-blocked'
  | 'learning-candidate'

export type WakePriority = 'high' | 'normal' | 'low'

export interface WakeDecision {
  readonly reason: WakeReason
  readonly priority: WakePriority
  readonly summary: string
}

export interface WakePolicyOptions {
  /** A receipt whose change impacts at least this many modules is architecture-level. */
  readonly impactThreshold: number
}

export const DEFAULT_WAKE_POLICY: WakePolicyOptions = { impactThreshold: 3 }

/**
 * @returns a wake decision, or undefined when the event is ordinary state.
 */
export function classifyEvent(event: SuperAgentEvent, options: WakePolicyOptions = DEFAULT_WAKE_POLICY): WakeDecision | undefined {
  const d = event.data as Record<string, any>
  switch (event.type) {
    case 'human-gate/opened':
      return { reason: 'human-gate', priority: 'high', summary: `Human Gate ${d.reason}: ${String(d.detail ?? '').slice(0, 300)}` }
    case 'loop/decision': {
      const decision = d.decision ?? {}
      if (decision.action === 'retry' && decision.switched) return { reason: 'repeated-failure', priority: 'normal', summary: String(decision.reason ?? 'strategy switch') }
      return undefined
    }
    case 'receipt/created':
      if (d.integrityBlocked) return { reason: 'integrity-violation', priority: 'high', summary: `attempt ${d.attempt}: ${String(d.reason ?? '').slice(0, 300)}` }
      if (d.claimOverruled) return { reason: 'claim-overruled', priority: 'normal', summary: `attempt ${d.attempt}: worker claimed PASS; ${String(d.reason ?? '').slice(0, 200)}` }
      if (Array.isArray(d.impactedModules) && d.impactedModules.length >= options.impactThreshold) {
        return { reason: 'architecture-impact', priority: 'normal', summary: `change impacts ${d.impactedModules.length} modules: ${d.impactedModules.slice(0, 8).join(', ')}` }
      }
      return undefined
    case 'architecture/drift':
      return { reason: 'architecture-drift', priority: 'high', summary: `${d.errors ?? '?'} architecture error(s) detected` }
    case 'worker/report': {
      const r = d.report ?? {}
      // human_required blockers become Human Gates (woken there); plain blockers still need the Chief.
      if (r.kind === 'blocker' && !r.human_required) return { reason: 'worker-blocker', priority: 'normal', summary: String(r.blocker ?? r.summary ?? 'worker blocked').slice(0, 300) }
      return undefined
    }
    case 'goal/updated':
      if (d.status === 'complete') return { reason: 'final-review', priority: 'normal', summary: 'goal complete — final candidate review' }
      if (d.status === 'blocked' || d.status === 'failed') return { reason: 'goal-blocked', priority: 'high', summary: `goal ${d.status}: ${String(d.blocker ?? '').slice(0, 300)}` }
      return undefined
    case 'learning/candidate':
      return { reason: 'learning-candidate', priority: 'low', summary: `${d.kind} candidate ${d.name}` }
    default:
      return undefined
  }
}
