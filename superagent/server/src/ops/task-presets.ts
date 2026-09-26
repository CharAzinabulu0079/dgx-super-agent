/**
 * Task presets (what kind of work a request is): loop limits, review, extra checks and
 * how the Worker should approach it. Server-defined (trusted), so a preset may add a
 * gate command; the agent-facing gate registry still only takes ids.
 */
import type { GateSpec, Project } from '@superagent/contracts'

export interface TaskPresetView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly maxAttempts: number
  readonly review: boolean
  /** Why it cannot be used for this project, if so. */
  readonly problem?: string
}

export interface ResolvedTaskPreset {
  readonly guidance: string
  readonly maxAttempts: number
  readonly review: boolean
  readonly singleTask: boolean
  /** Checks added to every task of the request (on top of the project's). */
  readonly extraGates: (goalId: string) => GateSpec[]
}

interface Def extends Omit<ResolvedTaskPreset, 'extraGates'> {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly extraGates?: (goalId: string) => GateSpec[]
  readonly needs?: (p: Project) => string | undefined
}

export const researchReport = (goalId: string): string => `research/${goalId}.md`

const DEFS: readonly Def[] = [
  {
    id: 'bugfix', name: 'Bug fix', description: 'Reproduce, fix the cause, keep the change small.', maxAttempts: 6, review: false, singleTask: false,
    guidance: 'This is a bug fix. First reproduce the problem (a failing test if the project has tests), then fix the cause rather than the symptom. Keep the change minimal; do not refactor unrelated code.',
  },
  {
    id: 'feature', name: 'Feature', description: 'New behaviour with tests; reviewed.', maxAttempts: 8, review: true, singleTask: false,
    guidance: 'This is a new feature. Implement it completely, add tests for the new behaviour next to the existing ones, and keep existing behaviour unchanged.',
  },
  {
    id: 'refactor', name: 'Refactor', description: 'Same behaviour, better code; reviewed.', maxAttempts: 6, review: true, singleTask: false,
    guidance: 'This is a refactor: behaviour must not change. Do not add features. Every existing test must keep passing without being modified.',
  },
  {
    id: 'frontend-test', name: 'Front-end test', description: 'Checked in a real browser (needs an E2E check).', maxAttempts: 6, review: false, singleTask: false,
    guidance: 'This change is about the user interface. Verify it in a real browser (the browser tools), not only by reading code; the end-to-end check decides.',
    needs: p => (p.defaultGates.some(g => g.kind === 'e2e') ? undefined : 'this project has no end-to-end (browser) check'),
  },
  {
    id: 'research', name: 'Research', description: 'Investigate and write a report; no code changes.', maxAttempts: 3, review: false, singleTask: true,
    guidance: 'This is research, not a code change. Do not modify source code. Investigate (read code, run read-only commands, look things up), then write your findings, evidence and a recommendation in Markdown to the report file named below. The task is done when that report exists and is substantial.',
    extraGates: goalId => [{ id: 'research-report', kind: 'command', command: `test "$(wc -c < ${researchReport(goalId)})" -ge 400`, required: true, timeoutMs: 10_000 }],
  },
]

export function taskPresetViews(project?: Project): TaskPresetView[] {
  return DEFS.map(d => ({ id: d.id, name: d.name, description: d.description, maxAttempts: d.maxAttempts, review: d.review, ...(project && d.needs?.(project) ? { problem: d.needs(project) } : {}) }))
}

export function resolveTaskPreset(id: string, project: Project): ResolvedTaskPreset {
  const d = DEFS.find(x => x.id === id)
  if (!d) throw new Error(`unknown task preset ${id} (${DEFS.map(x => x.id).join(', ')})`)
  const problem = d.needs?.(project)
  if (problem) throw new Error(`${d.name}: ${problem}`)
  return { guidance: d.guidance, maxAttempts: d.maxAttempts, review: d.review, singleTask: d.singleTask, extraGates: d.extraGates ?? (() => []) }
}
