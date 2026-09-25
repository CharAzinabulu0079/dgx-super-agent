/**
 * Chief decomposition (planner) and Reviewer (Cloud v1.0).
 *
 * Both are *advisors*: one-shot, read-only DSH sessions (bundle role `planner` /
 * `reviewer` → read tools only, SuperAgent state forbidden) whose answer is untrusted
 * JSON, validated here. A plan can only reference registry gate ids, so a model never
 * defines what "verified" means. A reviewer can block a PASS, never create one:
 * deterministic gates stay the authority.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GateSpec, ModelRef, Project, Receipt, Task } from '@superagent/contracts'
import { loadModelRoutes, modelPatch } from './dsh-executor.ts'
import { runDshStreaming } from './dsh-process.ts'

export const PLAN_FENCE = 'superagent-plan'
export const REVIEW_FENCE = 'superagent-review'
export const MAX_PLAN_TASKS = 8

export interface PlannedTask {
  readonly title: string
  readonly instructions: string
  readonly paths: readonly string[]
  readonly modules: readonly string[]
  /** Registry gate ids; empty = project defaults. */
  readonly gates: readonly string[]
  /** Ask the reviewer to inspect the diff after gates pass. */
  readonly review: boolean
}

export interface Plan {
  readonly objective: string
  readonly tasks: readonly PlannedTask[]
  /** Who produced it (`deterministic`, `dsh:<provider/model>`), and any fallback note. */
  readonly planner: string
  readonly note?: string
}

export interface PlanInput {
  readonly project: Project
  readonly request: string
  /** Gate ids the plan may reference (the project's Gate Registry). */
  readonly gates: readonly GateSpec[]
  /** Compact architecture overview (module ids, layers), if the Observatory has one. */
  readonly architecture?: string
  readonly signal?: AbortSignal
}

export interface Planner {
  readonly name: string
  plan(input: PlanInput): Promise<Plan>
}

export class PlanError extends Error {}

function extractFence(text: string, fence: string): unknown {
  const re = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)```', 'g')
  let last: string | undefined
  for (const m of text.matchAll(re)) last = m[1]
  if (last === undefined) throw new PlanError(`no \`${fence}\` block in the model's answer`)
  try {
    return JSON.parse(last)
  } catch (error) {
    throw new PlanError(`\`${fence}\` block is not JSON: ${(error as Error).message}`)
  }
}

const clip = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new PlanError(`${what}: expected non-empty string`)
  return v.trim().slice(0, max)
}
const strs = (v: unknown, what: string): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new PlanError(`${what}: expected string[]`)
  return (v as string[]).slice(0, 20)
}

/**
 * Validate a model-produced plan. Unknown gate ids are rejected (not dropped): a plan
 * that silently lost a gate would verify less than it claims.
 */
export function parsePlan(value: unknown, registry: readonly GateSpec[], planner: string): Plan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError('plan: expected object')
  const o = value as Record<string, unknown>
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) throw new PlanError('plan.tasks: expected a non-empty array')
  if (o.tasks.length > MAX_PLAN_TASKS) throw new PlanError(`plan.tasks: at most ${MAX_PLAN_TASKS} tasks`)
  const ids = new Set(registry.map(g => g.id))
  const tasks = o.tasks.map((t, i): PlannedTask => {
    if (!t || typeof t !== 'object') throw new PlanError(`plan.tasks[${i}]: expected object`)
    const r = t as Record<string, unknown>
    const gates = strs(r.gates, `plan.tasks[${i}].gates`)
    const unknown = gates.filter(g => !ids.has(g))
    if (unknown.length) throw new PlanError(`plan.tasks[${i}].gates: not in the gate registry: ${unknown.join(', ')} (allowed: ${[...ids].join(', ') || 'none'})`)
    return {
      title: clip(r.title, 120, `plan.tasks[${i}].title`),
      instructions: clip(r.instructions, 6_000, `plan.tasks[${i}].instructions`),
      paths: strs(r.paths, `plan.tasks[${i}].paths`),
      modules: strs(r.modules, `plan.tasks[${i}].modules`),
      gates,
      review: r.review === true,
    }
  })
  return { objective: clip(o.objective, 300, 'plan.objective'), tasks, planner }
}

/** Fallback planner: the whole request is one task on the project's default gates. */
export class DeterministicPlanner implements Planner {
  readonly name = 'deterministic'
  async plan(input: PlanInput): Promise<Plan> {
    const request = input.request.trim()
    if (!request) throw new PlanError('empty request')
    const firstLine = request.split('\n')[0]!.trim()
    return {
      objective: firstLine.slice(0, 300),
      tasks: [{ title: firstLine.slice(0, 120), instructions: request, paths: [], modules: [], gates: [], review: false }],
      planner: this.name,
    }
  }
}

export function planPrompt(input: Omit<PlanInput, 'signal'>): string {
  return [
    'You are the SuperAgent Chief planning step. Turn the user request below into a short sequence of Worker tasks.',
    `Repository: ${input.project.root} (you may read files; you cannot write or run commands).`,
    '',
    '## Request',
    input.request,
    '',
    '## Verification gates you may reference (by id only)',
    ...(input.gates.length ? input.gates.map(g => `- ${g.id} (${g.kind}${g.heldOut ? ', held-out' : ''})`) : ['- (none registered; leave "gates" empty)']),
    ...(input.architecture ? ['', '## Architecture', input.architecture] : []),
    '',
    '## Rules',
    `- 1 to ${MAX_PLAN_TASKS} tasks, in execution order; each independently verifiable and small enough for one Worker session.`,
    '- Prefer ONE task unless the request clearly has separable parts. Do not invent work the user did not ask for.',
    '- instructions: concrete, self-contained (the Worker sees only its own task), include acceptance criteria.',
    '- gates: registry ids from the list above, or [] for the project defaults. Never invent a gate.',
    '- review: true for changes that tests may not fully capture (UX, security, API design, data handling).',
    '',
    `Answer with exactly one fenced block tagged \`${PLAN_FENCE}\`:`,
    '```' + PLAN_FENCE,
    '{"objective":"<one line>","tasks":[{"title":"...","instructions":"...","paths":[],"modules":[],"gates":[],"review":false}]}',
    '```',
  ].join('\n')
}

export interface ReviewInput {
  readonly project: Project
  readonly task: Task
  readonly receipt: Receipt
  /** Unified diff of the task's change (task baseline → this attempt), bounded. */
  readonly diff: string
  readonly signal?: AbortSignal
}

export interface ReviewVerdict {
  readonly approve: boolean
  readonly comments: string
  readonly reviewer: string
}

export interface Reviewer {
  readonly name: string
  review(input: ReviewInput): Promise<ReviewVerdict>
}

export function reviewPrompt(input: Omit<ReviewInput, 'signal'>): string {
  const { task, receipt } = input
  return [
    'You are the SuperAgent Reviewer. The deterministic gates below already PASSED. Decide whether the change also does what the task asked,',
    'without obvious defects the tests would miss (special-casing test inputs, disabled behaviour, security holes, unrelated edits, missing parts).',
    'You can only request changes; you cannot pass anything the gates failed. Do not nitpick style.',
    '',
    `## Task: ${task.title}`,
    task.instructions.slice(0, 4_000),
    '',
    `## Gates: ${receipt.gateResults.map(g => `${g.gateId}=${g.status}`).join(', ')}`,
    '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
    '',
    `Answer with exactly one fenced block tagged \`${REVIEW_FENCE}\`:`,
    '```' + REVIEW_FENCE,
    '{"approve":true,"comments":"<what must change, specific and actionable; or a one-line approval>"}',
    '```',
  ].join('\n')
}

export function parseReview(text: string, reviewer: string): ReviewVerdict {
  const v = extractFence(text, REVIEW_FENCE)
  if (!v || typeof v !== 'object' || typeof (v as { approve?: unknown }).approve !== 'boolean') throw new PlanError('review: expected {"approve": boolean, "comments": string}')
  const o = v as { approve: boolean; comments?: unknown }
  return { approve: o.approve, comments: typeof o.comments === 'string' ? o.comments.slice(0, 4_000) : '', reviewer }
}

export interface DshAdvisorOptions {
  readonly stateHome: string
  /** DSH profile carrying the SuperAgent bundle (default `superagent-chief-cli`). */
  readonly profile?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly model?: (projectId: string) => ModelRef | undefined
}

/** One read-only DSH turn; returns the final text. */
export async function runAdvisor(o: DshAdvisorOptions, role: 'planner' | 'reviewer', project: Project, prompt: string, signal = new AbortController().signal): Promise<{ text: string; model?: ModelRef }> {
  const args = ['--profile', o.profile ?? 'superagent-chief-cli']
  const model = o.model?.(project.id)
  const patch = model ? modelPatch(model, loadModelRoutes(o.stateHome)) : undefined
  if (patch) {
    const dir = join(o.stateHome, 'runtime', role)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${project.id}.model.yml`), patch)
    args.push('--patch', join(dir, `${project.id}.model.yml`))
  }
  let text = ''
  const r = await runDshStreaming({
    args: [...args, '--json', prompt], cwd: project.root, signal, timeoutMs: o.timeoutMs ?? 5 * 60_000,
    // SUPERAGENT_HOME makes the bundle guard forbid the state/held-out store for this session.
    env: { DSH_HOME: join(o.stateHome, 'dsh-home'), SUPERAGENT_ROLE: role, SUPERAGENT_HOME: o.stateHome, ...o.env },
    onEvent: e => { if (e.type === 'final' && typeof e.text === 'string') text = e.text },
  })
  if (r.exitCode !== 0) throw new Error(`${role} session exited ${r.exitCode}${r.timedOut ? ' (timeout)' : ''}: ${r.stderrTail.slice(-300)}`)
  return { text, model }
}

export class DshPlanner implements Planner {
  readonly name = 'dsh'
  private readonly o: DshAdvisorOptions
  constructor(options: DshAdvisorOptions) {
    this.o = options
  }

  async plan(input: PlanInput): Promise<Plan> {
    const { text, model } = await runAdvisor(this.o, 'planner', input.project, planPrompt(input), input.signal)
    return parsePlan(extractFence(text, PLAN_FENCE), input.gates, `dsh:${model ? `${model.provider}/${model.model}` : 'default'}`)
  }
}

export class DshReviewer implements Reviewer {
  readonly name = 'dsh'
  private readonly o: DshAdvisorOptions
  constructor(options: DshAdvisorOptions) {
    this.o = options
  }

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const { text, model } = await runAdvisor(this.o, 'reviewer', input.project, reviewPrompt(input), input.signal)
    return parseReview(text, `dsh:${model ? `${model.provider}/${model.model}` : 'default'}`)
  }
}

/** Test/demo reviewer driven by a function. */
export class ScriptedReviewer implements Reviewer {
  readonly name = 'scripted'
  private readonly fn: (input: ReviewInput) => Omit<ReviewVerdict, 'reviewer'> | Promise<Omit<ReviewVerdict, 'reviewer'>>
  constructor(fn: ScriptedReviewer['fn']) {
    this.fn = fn
  }
  async review(input: ReviewInput): Promise<ReviewVerdict> {
    return { ...(await this.fn(input)), reviewer: this.name }
  }
}
