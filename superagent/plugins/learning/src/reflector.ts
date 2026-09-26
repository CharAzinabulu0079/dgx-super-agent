/**
 * LLM reflection through DSH (Directive §4.D): a model reads a compact execution trace
 * and proposes candidates. Output is untrusted model JSON: validated, size-bounded, and
 * only ever stored as candidates.
 */
import { join } from 'node:path'
import type { StateStore } from '@superagent/project-state'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ModelRef } from '@superagent/contracts'
import { loadModelRoutes, modelPatch, runDshStreaming } from '@superagent/chief-worker'
import type { EvolutionKind } from './evolution.ts'

export const CANDIDATES_FENCE = 'superagent-candidates'
const KINDS: readonly EvolutionKind[] = ['memory', 'skill', 'workflow', 'prompt', 'routing-policy', 'verifier-policy', 'plugin-config']

export interface ProposedCandidate {
  readonly kind: EvolutionKind
  readonly name: string
  readonly description: string
  readonly body: string
  readonly rationale?: string
}

/** Compact, bounded trace of one finished task for reflection. */
export function traceSummary(store: StateStore, projectId: string, taskId: string): string {
  const task = store.requireTask(projectId, taskId)
  const receipts = store.listReceipts(projectId, taskId).sort((a, b) => a.attempt - b.attempt)
  const lines = [`Task: ${task.title}`, `Instructions: ${task.instructions.slice(0, 1500)}`, `Final state: ${task.state}; attempts: ${task.attempts.length}`]
  for (const r of receipts) {
    lines.push(`\nAttempt ${r.attempt} (${r.strategy}, ${r.model.provider}/${r.model.model}): ${r.verdict} — ${r.reason.slice(0, 300)}`)
    for (const g of r.gateResults.filter(x => x.status !== 'pass')) lines.push(`  gate ${g.gateId}: ${g.summary}\n  ${g.outputTail.split('\n').slice(-8).join('\n  ')}`)
    for (const f of r.integrity?.findings ?? []) if (f.severity !== 'info') lines.push(`  integrity ${f.kind}: ${f.detail}`)
    if (r.changedFiles.length) lines.push(`  changed: ${r.changedFiles.slice(0, 20).join(', ')}`)
    const a = task.attempts.find(x => x.n === r.attempt)
    const last = a ? store.readReports(projectId, a.workerId).filter(x => x.kind !== 'progress').at(-1) : undefined
    if (last?.summary) lines.push(`  worker summary: ${last.summary.slice(0, 300)}`)
  }
  return lines.join('\n').slice(0, 12_000)
}

export function reflectionPrompt(trace: string): string {
  return [
    'You are the SuperAgent reflection step. Read this execution trace and propose reusable improvements.',
    'Propose only what the trace supports. Kinds: memory (a fact/lesson), skill (a repeatable procedure), workflow (a task template),',
    'prompt (Worker instruction addition), routing-policy / verifier-policy / plugin-config (JSON; require human approval).',
    'Nothing you propose takes effect directly: every candidate is replay-evaluated and/or human-reviewed.',
    '',
    '## Trace',
    trace,
    '',
    `Answer with exactly one fenced block tagged \`${CANDIDATES_FENCE}\` containing a JSON array of`,
    '{"kind","name" (kebab-case),"description","body","rationale"}. Use [] when nothing is worth keeping.',
  ].join('\n')
}

/** Parse and validate the model's candidate block. Invalid entries are dropped. */
export function parseCandidates(text: string): ProposedCandidate[] {
  const re = new RegExp('```' + CANDIDATES_FENCE + '\\s*\\n([\\s\\S]*?)```', 'g')
  let last: string | undefined
  for (const m of text.matchAll(re)) last = m[1]
  if (last === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch (invalid) {
    void invalid
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ProposedCandidate[] = []
  for (const c of raw.slice(0, 10)) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (!KINDS.includes(o.kind as EvolutionKind)) continue
    if (typeof o.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(o.name)) continue
    if (typeof o.body !== 'string' || !o.body.trim() || o.body.length > 8_000) continue
    out.push({
      kind: o.kind as EvolutionKind, name: o.name, body: o.body,
      description: typeof o.description === 'string' ? o.description.slice(0, 300) : o.name,
      rationale: typeof o.rationale === 'string' ? o.rationale.slice(0, 1_000) : undefined,
    })
  }
  return out
}

export interface DshReflectorOptions {
  readonly stateHome: string
  /** DSH profile (default `headless`: no SuperAgent tools needed). */
  readonly profile?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  /** Reviewer model (policy role `reviewer`). */
  readonly model?: (projectId: string) => ModelRef | undefined
}

/** Runs one DSH turn over the trace and returns validated proposals. */
export class DshReflector {
  private readonly o: DshReflectorOptions
  constructor(options: DshReflectorOptions) {
    this.o = options
  }

  async propose(store: StateStore, projectId: string, taskId: string, signal = new AbortController().signal): Promise<ProposedCandidate[]> {
    const project = store.requireProject(projectId)
    let final = ''
    const r = await runDshStreaming({
      args: [...this.modelArgs(projectId), '--json', reflectionPrompt(traceSummary(store, projectId, taskId))],
      cwd: project.root, signal, timeoutMs: this.o.timeoutMs ?? 5 * 60_000,
      env: { DSH_HOME: join(this.o.stateHome, 'dsh-home'), SUPERAGENT_ROLE: 'chief', ...loadModelRoutes(this.o.stateHome).env, ...this.o.env },
      onEvent: e => { if (e.type === 'final' && typeof e.text === 'string') final = e.text },
    })
    if (r.exitCode !== 0) throw new Error(`reflection session exited ${r.exitCode}: ${r.stderrTail.slice(-300)}`)
    return parseCandidates(final)
  }

  private modelArgs(projectId: string): string[] {
    const args = ['--profile', this.o.profile ?? 'headless']
    const model = this.o.model?.(projectId)
    const patch = model ? modelPatch(model, loadModelRoutes(this.o.stateHome)) : undefined
    if (patch) {
      const dir = join(this.o.stateHome, 'runtime', 'reflection')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${projectId}.model.yml`), patch)
      args.push('--patch', join(dir, `${projectId}.model.yml`))
    }
    return args
  }
}
