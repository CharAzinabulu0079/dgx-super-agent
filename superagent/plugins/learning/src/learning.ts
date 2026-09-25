/**
 * Learning v2 (Directive §4.D/§4.E) on the evolution contract:
 *
 *   Execution trace → Reflect (rules + LLM) → Candidate
 *     → Eval (fresh replay: baseline arm vs candidate arm) → Compare
 *     → Promote (per-kind governance) | Reject (archived with reason)
 *
 * Memory, Skill, Architecture and ADRs stay separate stores (Freeze §10.1). Nothing a
 * model proposes becomes active knowledge without evidence and/or a human.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, now, type PolicyLayer } from '@superagent/contracts'
import { loadGlobalPolicy, parsePolicyLayer, saveGlobalPolicy } from '@superagent/model-policy'
import type { StateStore } from '@superagent/project-state'
import { DEFAULT_VERIFICATION_POLICY, type Verifier } from '@superagent/verifier'
import { compareArms, mayPromote, type ArmResult, type Candidate, type CandidateStatus, type EvalRecord, type Evidence, type EvolutionKind } from './evolution.ts'
import { replayArm, type ReplayOptions } from './replay.ts'
import type { ProposedCandidate } from './reflector.ts'

export type { Candidate, CandidateStatus, Evidence }

type Draft = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'evals'>

export interface Extractor {
  /** Propose candidates from one finished task's trace. Must not promote. */
  extract(input: { store: StateStore; projectId: string; taskId: string }): Draft[] | Promise<Draft[]>
}

function evidenceOf(store: StateStore, projectId: string, taskId: string): Evidence | undefined {
  const task = store.requireTask(projectId, taskId)
  const receipts = store.listReceipts(projectId, taskId).sort((a, b) => a.attempt - b.attempt)
  if (!receipts.length) return undefined
  const signatures = [...new Set(receipts.flatMap(r => r.gateResults.filter(g => g.failureSignature).map(g => g.failureSignature!)))]
  return { projectId, taskId, receiptIds: receipts.map(r => r.id), failureSignatures: signatures, snapshot: task.baseline?.snapshot }
}

/**
 * Deterministic extractor: a task that PASSed after failing attempts yields a Memory
 * lesson and a Skill candidate describing what finally worked.
 */
export const traceExtractor: Extractor = {
  extract({ store, projectId, taskId }) {
    const task = store.requireTask(projectId, taskId)
    if (task.state !== 'passed') return []
    const receipts = store.listReceipts(projectId, taskId).sort((a, b) => a.attempt - b.attempt)
    const failed = receipts.filter(r => r.verdict === 'FAIL')
    const passed = receipts.find(r => r.verdict === 'PASS')
    const evidence = evidenceOf(store, projectId, taskId)
    if (!failed.length || !passed || !evidence) return []
    const project = store.requireProject(projectId)
    const lastWorker = task.attempts.at(-1)?.workerId
    const fixSummary = lastWorker ? (store.readReports(projectId, lastWorker).filter(r => r.kind !== 'progress').at(-1)?.summary ?? '') : ''
    const failingGates = [...new Set(failed.flatMap(r => r.gateResults.filter(g => g.status !== 'pass').map(g => `${g.gateId}: ${g.summary}`)))]
    const gates = task.gates.length ? task.gates : project.defaultGates
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
    return [
      {
        kind: 'memory', name: `lesson-${slug}`, scope: 'project', evidence, source: 'trace-rule',
        description: `Lesson from "${task.title}" (${failed.length} failed attempt(s) before PASS)`,
        body: `When ${failingGates.join('; ')} — the fix that passed independent verification was: ${fixSummary || `changes to ${passed.changedFiles.join(', ')}`}. Strategy that worked: ${task.attempts.at(-1)?.strategy}.`,
      },
      {
        kind: 'skill', name: `fix-${slug}`, scope: 'project', evidence, source: 'trace-rule',
        description: `Procedure that turned "${task.title}" green`,
        body: [
          `Use when: ${failingGates.join('; ')}`,
          `1. Reproduce with the gates: ${gates.map(g => `\`${g.command ?? g.kind}\``).join(', ')}.`,
          `2. Focus on: ${passed.changedModules.join(', ') || passed.changedFiles.join(', ')}.`,
          `3. Known fix: ${fixSummary || 'see evidence receipts'}.`,
          '4. Re-run the gates; the independent verifier decides PASS.',
        ].join('\n'),
      },
    ]
  },
}

/** Adapts an LLM reflector (e.g. DshReflector) to the Extractor interface. */
export function llmExtractor(reflector: { propose(store: StateStore, projectId: string, taskId: string): Promise<ProposedCandidate[]> }): Extractor {
  return {
    async extract({ store, projectId, taskId }) {
      const evidence = evidenceOf(store, projectId, taskId)
      if (!evidence) return []
      const proposals = await reflector.propose(store, projectId, taskId)
      return proposals.map(p => ({ ...p, scope: 'project' as const, evidence, source: 'llm-reflection' as const }))
    },
  }
}

const DIRS = { candidate: 'candidates', evaluating: 'candidates', promoted: 'promoted', rejected: 'archived', archived: 'archived' } as const

export class LearningStore {
  readonly root: string
  constructor(home: string) {
    this.root = join(home, 'learning')
    for (const d of ['candidates', 'promoted', 'archived']) mkdirSync(join(this.root, d), { recursive: true })
  }

  private path(dir: string, id: string): string { return join(this.root, dir, `${id}.json`) }

  private write(c: Candidate): Candidate {
    const file = this.path(DIRS[c.status], c.id)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(c, null, 2)}\n`)
    renameSync(`${file}.tmp`, file)
    return c
  }

  add(input: Draft): Candidate {
    const existing = this.list().find(c => c.kind === input.kind && c.name === input.name && c.evidence.taskId === input.evidence.taskId && c.status !== 'rejected' && c.status !== 'archived')
    if (existing) return existing
    const t = now()
    return this.write({ ...input, id: newId(input.kind === 'memory' ? 'mem' : 'cand'), status: 'candidate', createdAt: t, updatedAt: t, evals: [] })
  }

  get(id: string): Candidate | undefined {
    for (const d of ['candidates', 'promoted', 'archived']) {
      if (existsSync(this.path(d, id))) return JSON.parse(readFileSync(this.path(d, id), 'utf8')) as Candidate
    }
    return undefined
  }

  list(status?: CandidateStatus): Candidate[] {
    const out: Candidate[] = []
    for (const d of ['candidates', 'promoted', 'archived']) {
      for (const f of readdirSync(join(this.root, d))) if (f.endsWith('.json')) {
        const c = JSON.parse(readFileSync(join(this.root, d, f), 'utf8')) as Candidate
        out.push({ ...c, evals: c.evals ?? [] })
      }
    }
    return (status ? out.filter(c => c.status === status) : out).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  transition(c: Candidate, change: Partial<Candidate>): Candidate {
    const next = this.write({ ...c, ...change, updatedAt: now() })
    if (DIRS[c.status] !== DIRS[next.status] && existsSync(this.path(DIRS[c.status], c.id))) rmSync(this.path(DIRS[c.status], c.id))
    return next
  }
}

export interface LearningOptions {
  readonly extractors?: readonly Extractor[]
  /** Fresh-replay evaluation; without it nothing evidence-governed can be promoted (fail closed). */
  readonly replay?: ReplayOptions
}

export class LearningService {
  readonly store: StateStore
  readonly verifier: Verifier
  readonly learning: LearningStore
  readonly extractors: readonly Extractor[]
  replay?: ReplayOptions

  constructor(store: StateStore, verifier: Verifier, options: LearningOptions | readonly Extractor[] = {}) {
    const o: LearningOptions = Array.isArray(options) ? { extractors: options as readonly Extractor[] } : options as LearningOptions
    this.store = store
    this.verifier = verifier
    this.learning = new LearningStore(store.home)
    this.extractors = o.extractors ?? [traceExtractor]
    this.replay = o.replay
  }

  /** Reflect on a finished task; returns the new candidates (never promoted). Extractor errors are recorded, not fatal. */
  async reflect(projectId: string, taskId: string): Promise<Candidate[]> {
    const out: Candidate[] = []
    for (const ex of this.extractors) {
      let drafts: Draft[] = []
      try {
        drafts = await ex.extract({ store: this.store, projectId, taskId })
      } catch (error) {
        this.store.emitTyped('learning/archived', projectId, { reason: `reflection failed: ${String((error as Error).message ?? error)}` }, { taskId })
        continue
      }
      for (const draft of drafts) {
        const c = this.learning.add(draft)
        out.push(c)
        this.store.emitTyped('learning/candidate', projectId, { candidateId: c.id, kind: c.kind, name: c.name, source: c.source }, { taskId })
      }
    }
    return out
  }

  /**
   * Evaluate a candidate by fresh replay (baseline arm vs candidate arm), compare, and
   * promote or reject according to its kind's governance.
   */
  async evaluate(candidateId: string): Promise<Candidate> {
    let c = this.require(candidateId)
    if (c.kind === 'memory') throw new Error('memory candidates are promoted by human approval, not eval')
    if (c.status !== 'candidate') throw new Error(`candidate ${candidateId} is ${c.status}`)
    if (!this.replay) {
      const record: EvalRecord = { at: now(), method: 'none', fresh: false, heldOutGates: false, arms: [], notes: 'no replay executor configured; cannot produce evidence' }
      return this.learning.transition(c, { evals: [...c.evals, record], comparison: { improved: false, reason: record.notes! }, decision: 'awaiting replay capability' })
    }
    c = this.learning.transition(c, { status: 'evaluating' })
    const arms: ArmResult[] = []
    try {
      for (const arm of ['baseline', 'candidate'] as const) arms.push(await replayArm({ store: this.store, candidate: c, arm }, this.replay))
    } catch (error) {
      return this.reject(c, [], `replay failed: ${String((error as Error).message ?? error)}`)
    }
    const record: EvalRecord = { at: now(), method: 'fresh-replay', fresh: true, heldOutGates: true, arms }
    const comparison = compareArms(arms)
    c = this.learning.transition(c, { status: 'candidate', evals: [...c.evals, record], comparison })
    const gate = mayPromote(c, false)
    if (gate.ok) return this.promote(c, gate.reason)
    if (!comparison.improved) return this.reject(c, arms, comparison.reason)
    // Evidence present but a human must also approve (policy/config kinds).
    return this.learning.transition(c, { decision: gate.reason })
  }

  /** Human decision on a candidate. Memory: human-only. Policy/config: needs evidence too. Skills cannot be human-forced. */
  decide(candidateId: string, approved: boolean, note = ''): Candidate {
    const c = this.require(candidateId)
    if (c.status !== 'candidate') throw new Error(`candidate ${candidateId} is ${c.status}`)
    if (!approved) return this.reject(c, [], `human: rejected${note ? ` — ${note}` : ''}`)
    const gate = mayPromote(c, true)
    if (!gate.ok) throw new Error(`cannot promote: ${gate.reason}`)
    return this.promote(c, `human: approved${note ? ` — ${note}` : ''}; ${gate.reason}`)
  }

  /** @deprecated v1 name; kept for callers. Memory only. */
  decideMemory(candidateId: string, approved: boolean, note = ''): Candidate {
    const c = this.require(candidateId)
    if (c.kind !== 'memory') throw new Error('skills are promoted only through evaluate()')
    return this.decide(candidateId, approved, note)
  }

  private require(id: string): Candidate {
    const c = this.learning.get(id)
    if (!c) throw new Error(`candidate ${id} not found`)
    return c
  }

  private reject(c: Candidate, _arms: readonly ArmResult[], reason: string): Candidate {
    const next = this.learning.transition(c, { status: 'rejected', decision: reason })
    this.store.emitTyped('learning/archived', c.evidence.projectId, { candidateId: c.id, kind: c.kind, name: c.name, reason })
    return next
  }

  private promote(c: Candidate, reason: string): Candidate {
    // Validate before anything becomes active: an unusable policy is rejected, not half-applied.
    let activate: () => void
    try {
      activate = this.activator(c)
    } catch (error) {
      return this.reject(c, [], `invalid ${c.kind}: ${String((error as Error).message ?? error)}`)
    }
    const next = this.learning.transition(c, { status: 'promoted', decision: reason })
    this.apply(next)
    activate()
    this.store.emitTyped('learning/promoted', c.evidence.projectId, { candidateId: c.id, kind: c.kind, name: c.name, reason })
    return next
  }

  /**
   * Live appliers for policy kinds (both require replay evidence AND a human):
   * - routing-policy: a model-policy layer (models per role, attempts, strategies) merged
   *   into the project's layer (scope project) or the global layer (scope global);
   *   un-pinned tasks pick it up on their next attempt.
   * - verifier-policy: can only *tighten* verification — protected paths, env roots and
   *   lockfiles are added to the project's policy; nothing is ever removed this way.
   * plugin-config stays a file for a human to apply (DSH plugin configuration).
   */
  private activator(c: Candidate): () => void {
    const projects = c.scope === 'global' ? this.store.listProjects() : [this.store.requireProject(c.evidence.projectId)]
    if (c.kind === 'routing-policy') {
      const layer = parsePolicyLayer(JSON.parse(c.body), c.kind)
      const merge = (base: PolicyLayer | undefined): PolicyLayer => ({
        ...base, ...Object.fromEntries(Object.entries(layer).filter(([k, v]) => k !== 'models' && v !== undefined)),
        models: { ...base?.models, ...layer.models },
      })
      return c.scope === 'global'
        ? () => saveGlobalPolicy(this.store.home, merge(loadGlobalPolicy(this.store.home)))
        : () => { for (const p of projects) this.store.updateProject(p.id, { policy: merge(p.policy) }) }
    }
    if (c.kind === 'verifier-policy') {
      const raw = JSON.parse(c.body) as Record<string, unknown>
      const list = (k: string): string[] => {
        const v = raw[k]
        if (v === undefined) return []
        if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${k}: expected string[]`)
        return v as string[]
      }
      const unknown = Object.keys(raw).filter(k => !['protectedPaths', 'envRoots', 'lockfiles'].includes(k))
      if (unknown.length) throw new Error(`unsupported fields ${unknown.join(', ')} (only additions to protectedPaths/envRoots/lockfiles)`)
      const add = { protectedPaths: list('protectedPaths'), envRoots: list('envRoots'), lockfiles: list('lockfiles') }
      return () => {
        for (const p of projects) {
          const cur = p.verification ?? DEFAULT_VERIFICATION_POLICY
          const union = (a: readonly string[], b: string[]) => [...new Set([...a, ...b])]
          this.store.updateProject(p.id, { verification: { protectedPaths: union(cur.protectedPaths, add.protectedPaths), envRoots: union(cur.envRoots, add.envRoots), lockfiles: union(cur.lockfiles, add.lockfiles) } })
        }
      }
    }
    return () => {}
  }

  /** Kind-specific appliers: the only code that writes active knowledge. */
  private apply(c: Candidate): void {
    const dirFor: Partial<Record<EvolutionKind, string>> = { skill: 'skills', workflow: 'workflows', prompt: 'prompts', 'routing-policy': 'policies', 'verifier-policy': 'policies', 'plugin-config': 'plugin-config' }
    const dir = dirFor[c.kind]
    if (!dir) return // memory lives in the promoted store and is read by memoryFor()
    if (c.kind === 'skill') {
      mkdirSync(join(this.store.home, 'skills', c.name), { recursive: true })
      writeFileSync(join(this.store.home, 'skills', c.name, 'SKILL.md'), `---\nname: ${c.name}\ndescription: ${JSON.stringify(c.description)}\n---\n\n${c.body}\n\n<!-- promoted from ${c.id}: ${c.decision ?? ''} -->\n`)
      return
    }
    mkdirSync(join(this.store.home, dir), { recursive: true })
    writeFileSync(join(this.store.home, dir, `${c.name}.${c.kind.endsWith('policy') || c.kind === 'plugin-config' ? 'json' : 'md'}`), c.body)
  }

  /** Promoted skills relevant to a project (Workers + `.architecture/skills.json`). */
  projectSkills(projectId: string): Array<{ name: string; description: string; candidateId: string; body: string }> {
    return this.learning.list('promoted')
      .filter(c => (c.kind === 'skill' || c.kind === 'workflow' || c.kind === 'prompt') && (c.scope === 'global' || c.evidence.projectId === projectId))
      .map(c => ({ name: c.name, description: c.description, candidateId: c.id, body: c.body }))
  }

  /** Promoted memory for prompt context (project + global). */
  memoryFor(projectId: string): string[] {
    return this.learning.list('promoted').filter(c => c.kind === 'memory' && (c.scope === 'global' || c.evidence.projectId === projectId)).map(c => c.body)
  }
}
