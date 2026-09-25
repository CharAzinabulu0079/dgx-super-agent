/**
 * Memory / Skill Learning v1 (Freeze §10). Hermes-style ideas, no second core.
 *
 *   Execution trace → Reflect/Extract → Candidate → Replay/Eval → PASS? → Promote | Archive
 *
 * Four stores stay separate: Memory (facts/preferences/lessons), Skill (repeatable
 * procedures), Architecture (.architecture/), ADR (DECISIONS.md). Invariants:
 *   - a Skill is promoted only after its eval gates PASS on the recorded evidence;
 *   - a Memory item is promoted only by an explicit human approval;
 *   - nothing an Agent "feels" is good becomes formal knowledge directly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, now, type GateSpec, type GateResult } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'
import type { Verifier } from '@superagent/verifier'

export type CandidateKind = 'skill' | 'memory'
export type CandidateStatus = 'candidate' | 'evaluating' | 'promoted' | 'archived'

export interface Evidence {
  readonly projectId: string
  readonly taskId: string
  readonly receiptIds: readonly string[]
  readonly failureSignatures: readonly string[]
}

export interface Candidate {
  readonly id: string
  readonly kind: CandidateKind
  /** Skill name (kebab) or memory key. */
  readonly name: string
  readonly description: string
  /** Skill: markdown procedure. Memory: the fact/preference/lesson text. */
  readonly body: string
  readonly scope: 'project' | 'global'
  readonly evidence: Evidence
  /** Skill replay/eval gates, run against the evidence project. */
  readonly evalGates: readonly GateSpec[]
  readonly status: CandidateStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly evalResults?: readonly GateResult[]
  readonly decision?: string
}

export interface Extractor {
  /** Propose candidates from one finished task's trace. Must not promote. */
  extract(input: { store: StateStore; projectId: string; taskId: string }): Array<Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>>
}

/**
 * Deterministic v0.1 extractor: a task that PASSed after failing attempts yields
 * (a) a Memory "lesson" linking the failure signature to what fixed it, and
 * (b) a Skill candidate "reproduce-and-fix" whose eval is the task's own gates.
 * An LLM reflector (DSH session) can implement the same interface later.
 */
export const traceExtractor: Extractor = {
  extract({ store, projectId, taskId }) {
    const task = store.requireTask(projectId, taskId)
    if (task.state !== 'passed') return []
    const receipts = store.listReceipts(projectId, taskId).sort((a, b) => a.attempt - b.attempt)
    const failed = receipts.filter(r => r.verdict === 'FAIL')
    const passed = receipts.find(r => r.verdict === 'PASS')
    if (!failed.length || !passed) return []
    const project = store.requireProject(projectId)
    const lastWorker = task.attempts.at(-1)?.workerId
    const fixSummary = lastWorker ? (store.readReports(projectId, lastWorker).at(-1)?.summary ?? '') : ''
    const signatures = [...new Set(failed.flatMap(r => r.gateResults.filter(g => g.failureSignature).map(g => g.failureSignature!)))]
    const failingGates = [...new Set(failed.flatMap(r => r.gateResults.filter(g => g.status !== 'pass').map(g => `${g.gateId}: ${g.summary}`)))]
    const evidence: Evidence = { projectId, taskId, receiptIds: receipts.map(r => r.id), failureSignatures: signatures }
    const gates = task.gates.length ? task.gates : project.defaultGates
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
    return [
      {
        kind: 'memory', name: `lesson-${slug}`, scope: 'project', evidence, evalGates: [],
        description: `Lesson from "${task.title}" (${failed.length} failed attempt(s) before PASS)`,
        body: `When ${failingGates.join('; ')} — the fix that passed independent verification was: ${fixSummary || `changes to ${passed.changedFiles.join(', ')}`}. Strategy that worked: ${task.attempts.at(-1)?.strategy}.`,
      },
      {
        kind: 'skill', name: `fix-${slug}`, scope: 'project', evidence, evalGates: gates,
        description: `Procedure that turned "${task.title}" green`,
        body: [
          `# fix-${slug}`, '', `Use when: ${failingGates.join('; ')}`, '',
          '## Procedure',
          `1. Reproduce with the gates: ${gates.map(g => `\`${g.command ?? g.kind}\``).join(', ')}.`,
          `2. Focus on: ${passed.changedModules.join(', ') || passed.changedFiles.join(', ')}.`,
          `3. Known fix: ${fixSummary || 'see evidence receipts'}.`,
          '4. Re-run the gates; the independent verifier decides PASS.',
        ].join('\n'),
      },
    ]
  },
}

export class LearningStore {
  readonly root: string
  constructor(home: string) {
    this.root = join(home, 'learning')
    for (const d of ['candidates', 'promoted', 'archived']) mkdirSync(join(this.root, d), { recursive: true })
  }

  private path(status: 'candidates' | 'promoted' | 'archived', id: string): string { return join(this.root, status, `${id}.json`) }

  private write(c: Candidate): Candidate {
    const dir = c.status === 'promoted' ? 'promoted' : c.status === 'archived' ? 'archived' : 'candidates'
    const tmp = `${this.path(dir, c.id)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`)
    renameSync(tmp, this.path(dir, c.id))
    return c
  }

  add(input: Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Candidate {
    const existing = this.list().find(c => c.name === input.name && c.status !== 'archived' && c.evidence.taskId === input.evidence.taskId)
    if (existing) return existing
    const t = now()
    return this.write({ ...input, id: newId(input.kind === 'skill' ? 'skc' : 'mem'), status: 'candidate', createdAt: t, updatedAt: t })
  }

  get(id: string): Candidate | undefined {
    for (const d of ['candidates', 'promoted', 'archived'] as const) {
      if (existsSync(this.path(d, id))) return JSON.parse(readFileSync(this.path(d, id), 'utf8')) as Candidate
    }
    return undefined
  }

  list(status?: CandidateStatus): Candidate[] {
    const out: Candidate[] = []
    for (const d of ['candidates', 'promoted', 'archived'] as const) {
      for (const f of readdirSync(join(this.root, d))) if (f.endsWith('.json')) out.push(JSON.parse(readFileSync(join(this.root, d, f), 'utf8')) as Candidate)
    }
    return (status ? out.filter(c => c.status === status) : out).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Move a candidate to a new status, removing it from its previous directory. */
  transition(c: Candidate, change: Partial<Candidate>): Candidate {
    const before = c.status === 'promoted' ? 'promoted' : c.status === 'archived' ? 'archived' : 'candidates'
    const next = this.write({ ...c, ...change, updatedAt: now() })
    const after = next.status === 'promoted' ? 'promoted' : next.status === 'archived' ? 'archived' : 'candidates'
    if (before !== after && existsSync(this.path(before, c.id))) rmSync(this.path(before, c.id))
    return next
  }
}

export class LearningService {
  readonly store: StateStore
  readonly verifier: Verifier
  readonly learning: LearningStore
  readonly extractors: readonly Extractor[]

  constructor(store: StateStore, verifier: Verifier, extractors: readonly Extractor[] = [traceExtractor]) {
    this.store = store
    this.verifier = verifier
    this.learning = new LearningStore(store.home)
    this.extractors = extractors
  }

  /** Reflect on a finished task; returns the new candidates (never promoted). */
  reflect(projectId: string, taskId: string): Candidate[] {
    const out: Candidate[] = []
    for (const ex of this.extractors) {
      for (const draft of ex.extract({ store: this.store, projectId, taskId })) {
        const c = this.learning.add(draft)
        out.push(c)
        this.store.emitTyped('learning/candidate', projectId, { candidateId: c.id, kind: c.kind, name: c.name }, { taskId })
      }
    }
    return out
  }

  /**
   * Replay/Eval a Skill candidate: run its gates on the evidence project.
   * PASS → promoted (and materialized as SKILL.md); FAIL/no gates → archived.
   */
  async evaluate(candidateId: string): Promise<Candidate> {
    const c = this.learning.get(candidateId)
    if (!c) throw new Error(`candidate ${candidateId} not found`)
    if (c.kind !== 'skill') throw new Error('memory candidates are promoted by human approval, not eval')
    if (c.status !== 'candidate') throw new Error(`candidate ${candidateId} is ${c.status}`)
    const project = this.store.requireProject(c.evidence.projectId)
    const task = this.store.requireTask(c.evidence.projectId, c.evidence.taskId)
    const results: GateResult[] = []
    for (const g of c.evalGates) results.push(await this.verifier.runGate(g, { projectRoot: project.root, task, changedFiles: [] }))
    const pass = results.length > 0 && results.filter(r => r.required).every(r => r.status === 'pass') && results.some(r => r.required)
    if (!pass) {
      const archived = this.learning.transition(c, { status: 'archived', evalResults: results, decision: results.length ? 'eval failed' : 'no eval gates' })
      this.store.emitTyped('learning/archived', project.id, { candidateId: c.id, reason: archived.decision })
      return archived
    }
    const promoted = this.learning.transition(c, { status: 'promoted', evalResults: results, decision: 'eval passed' })
    this.materializeSkill(promoted)
    this.store.emitTyped('learning/promoted', project.id, { candidateId: c.id, kind: 'skill', name: c.name })
    return promoted
  }

  /** Human decision on a Memory candidate (Freeze §10.2: no self-promotion). */
  decideMemory(candidateId: string, approved: boolean, note = ''): Candidate {
    const c = this.learning.get(candidateId)
    if (!c) throw new Error(`candidate ${candidateId} not found`)
    if (c.kind !== 'memory') throw new Error('skills are promoted only through evaluate()')
    if (c.status !== 'candidate') throw new Error(`candidate ${candidateId} is ${c.status}`)
    const next = this.learning.transition(c, { status: approved ? 'promoted' : 'archived', decision: `human: ${approved ? 'approved' : 'rejected'}${note ? ` — ${note}` : ''}` })
    this.store.emitTyped(approved ? 'learning/promoted' : 'learning/archived', c.evidence.projectId, { candidateId: c.id, kind: 'memory', name: c.name })
    return next
  }

  /** Promoted skills as DSH/Claude-style skill folders: `<home>/skills/<name>/SKILL.md`. */
  private materializeSkill(c: Candidate): void {
    const dir = join(this.store.home, 'skills', c.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${c.name}\ndescription: ${JSON.stringify(c.description)}\n---\n\n${c.body}\n\n<!-- promoted from ${c.id}; evidence ${c.evidence.receiptIds.join(', ')} -->\n`)
  }

  /** Skills relevant to a project (for `.architecture/skills.json`). */
  projectSkills(projectId: string): Array<{ name: string; description: string; candidateId: string }> {
    return this.learning.list('promoted').filter(c => c.kind === 'skill' && (c.scope === 'global' || c.evidence.projectId === projectId)).map(c => ({ name: c.name, description: c.description, candidateId: c.id }))
  }

  /** Promoted memory for prompt context (project + global). */
  memoryFor(projectId: string): string[] {
    return this.learning.list('promoted').filter(c => c.kind === 'memory' && (c.scope === 'global' || c.evidence.projectId === projectId)).map(c => c.body)
  }
}
