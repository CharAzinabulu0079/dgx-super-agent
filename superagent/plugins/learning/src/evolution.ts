/**
 * Evolution seam (Directive §4.E): one contract for improving the harness itself.
 *
 *   Candidate → Eval (arms) → Compare → Promote | Reject
 *
 * A candidate never edits active knowledge directly; only `promote()` does, and only
 * when the kind's governance rule is satisfied (evidence and/or a human).
 */
import type { GateResult } from '@superagent/contracts'

export type EvolutionKind = 'memory' | 'skill' | 'workflow' | 'prompt' | 'routing-policy' | 'verifier-policy' | 'plugin-config'

export type CandidateStatus = 'candidate' | 'evaluating' | 'promoted' | 'rejected' | 'archived'

export interface Evidence {
  readonly projectId: string
  readonly taskId: string
  readonly receiptIds: readonly string[]
  readonly failureSignatures: readonly string[]
  /** Task baseline snapshot: the representative failing state for replay. */
  readonly snapshot?: string
}

/** Outcome of running the task under one arm (with or without the candidate). */
export interface ArmResult {
  readonly arm: 'baseline' | 'candidate'
  readonly passed: boolean
  readonly attempts: number
  readonly finalState: string
  readonly gateResults: readonly GateResult[]
  readonly integrityBlocked: boolean
  readonly durationMs: number
}

export interface EvalRecord {
  readonly at: string
  readonly method: 'fresh-replay' | 'human-review' | 'none'
  /** True when evaluation ran in a freshly reconstructed environment with a fresh Worker context. */
  readonly fresh: boolean
  /** True when the gates were chosen by the harness (registry), not by the candidate. */
  readonly heldOutGates: boolean
  readonly arms: readonly ArmResult[]
  readonly notes?: string
}

export interface Comparison {
  readonly improved: boolean
  readonly reason: string
}

export interface Candidate {
  readonly id: string
  readonly kind: EvolutionKind
  /** Skill name (kebab), memory key, workflow name, or the policy/config key it would change. */
  readonly name: string
  readonly description: string
  /** Skill/workflow: markdown procedure. Memory: the lesson. Policy/config: JSON document. */
  readonly body: string
  readonly rationale?: string
  readonly scope: 'project' | 'global'
  readonly source: 'trace-rule' | 'llm-reflection' | 'human'
  readonly evidence: Evidence
  readonly status: CandidateStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly evals: readonly EvalRecord[]
  readonly comparison?: Comparison
  readonly decision?: string
  /** Legacy v1 field: gates for replay evaluation (harness-chosen). */
  readonly evalGates?: readonly unknown[]
}

export type Governance = 'human-only' | 'evidence' | 'evidence-and-human'

/** Who/what may promote each kind. */
export const GOVERNANCE: Record<EvolutionKind, Governance> = {
  memory: 'human-only',
  skill: 'evidence',
  workflow: 'evidence',
  prompt: 'evidence',
  'routing-policy': 'evidence-and-human',
  'verifier-policy': 'evidence-and-human',
  'plugin-config': 'evidence-and-human',
}

/**
 * Compare arms. A candidate improves things only if it passes (with integrity intact) and
 * either the baseline arm fails or the candidate needs fewer attempts.
 */
export function compareArms(arms: readonly ArmResult[]): Comparison {
  const base = arms.find(a => a.arm === 'baseline')
  const cand = arms.find(a => a.arm === 'candidate')
  if (!cand) return { improved: false, reason: 'no candidate arm was evaluated' }
  if (cand.integrityBlocked) return { improved: false, reason: 'candidate arm violated verification integrity' }
  if (!cand.passed) return { improved: false, reason: `candidate arm did not pass (${cand.finalState} after ${cand.attempts} attempt(s))` }
  if (!base) return { improved: false, reason: 'no baseline arm to compare against' }
  if (!base.passed) return { improved: true, reason: `candidate passed in ${cand.attempts} attempt(s); baseline failed (${base.finalState})` }
  if (cand.attempts < base.attempts) return { improved: true, reason: `candidate passed in ${cand.attempts} vs baseline ${base.attempts} attempt(s)` }
  return { improved: false, reason: `no measurable improvement (both passed; candidate ${cand.attempts} vs baseline ${base.attempts} attempt(s))` }
}

/**
 * Whether a candidate may be promoted now.
 * @param humanApproved - a human explicitly approved this candidate.
 */
export function mayPromote(c: Pick<Candidate, 'kind' | 'comparison' | 'evals'>, humanApproved: boolean): { ok: boolean; reason: string } {
  const rule = GOVERNANCE[c.kind]
  const evidence = c.comparison?.improved === true && c.evals.some(e => e.method === 'fresh-replay' && e.fresh && e.heldOutGates)
  if (rule === 'human-only') return humanApproved ? { ok: true, reason: 'human approved' } : { ok: false, reason: `${c.kind} requires a human decision` }
  if (rule === 'evidence') return evidence ? { ok: true, reason: c.comparison!.reason } : { ok: false, reason: `${c.kind} requires fresh-replay evidence of improvement${c.comparison ? `: ${c.comparison.reason}` : ''}` }
  if (!evidence) return { ok: false, reason: `${c.kind} requires fresh-replay evidence of improvement and a human` }
  return humanApproved ? { ok: true, reason: `${c.comparison!.reason}; human approved` } : { ok: false, reason: `${c.kind} evidence present; a human must also approve` }
}
