/** Worker prompt construction and final-report extraction (model boundary). */
import { parseWorkerReport, type ModelRef, type WorkerReport } from '@superagent/contracts'
import type { WorkerRunInput } from './executor.ts'

export const REPORT_FENCE = 'superagent-report'

export function buildWorkerPrompt(input: Omit<WorkerRunInput, 'report' | 'signal'>, gates: ReadonlyArray<{ id: string; command?: string; kind: string; cwd?: string; heldOut?: unknown }>): string {
  const { task, project, attempt, strategy, feedback, steer } = input
  const lines: string[] = [
    `You are a SuperAgent Worker: a short-lived, task-scoped engineer. Work only inside ${project.root}.`,
    `Attempt ${attempt} (strategy: ${strategy}). Task id: ${task.id}.`,
    '',
    `## Task: ${task.title}`,
    task.instructions,
  ]
  if (task.scope.paths.length || task.scope.modules.length) {
    lines.push('', '## Scope')
    if (task.scope.paths.length) lines.push(`Paths: ${task.scope.paths.join(', ')}`)
    if (task.scope.modules.length) lines.push(`Architecture modules: ${task.scope.modules.join(', ')}`)
    lines.push('Read `.architecture/graph.json` (if present) instead of scanning the whole repository.')
  }
  lines.push('', '## Verification gates', 'After you finish, an independent verifier runs these gates. Your own claim of success is recorded but never counts as PASS.')
  for (const g of gates) {
    if (g.heldOut) lines.push(`- ${g.id} (${g.kind}, held-out): additional acceptance tests you cannot see run against your final tree. Implement the task fully and generally; do not special-case inputs.`)
    else lines.push(`- ${g.id} (${g.kind})${g.command ? `: \`${g.command}\`${g.cwd ? ` in ${g.cwd}` : ''}` : ''}`)
  }
  const failures = feedback.filter(f => f.verdict === 'FAIL')
  if (failures.length) {
    // fresh-context attempts get only the latest failure, condensed.
    const shown = strategy === 'fresh-context' ? failures.slice(-1) : failures.slice(-3)
    lines.push('', '## Previous attempts (independent verifier results)')
    for (const f of shown) {
      lines.push(`### Attempt ${f.attempt} — ${f.verdict}: ${f.reason}${f.claimOverruled ? ' (the Worker claimed PASS; the gates disagreed)' : ''}`)
      for (const finding of f.integrity ?? []) lines.push(`- INTEGRITY ${finding}. Revert those changes: verification assets and the environment are not yours to change.`)
      for (const g of f.failingGates) {
        lines.push(`- ${g.gateId}: ${g.status} — ${g.summary}`)
        if (g.outputTail) lines.push('```', g.outputTail.split('\n').slice(strategy === 'fresh-context' ? -15 : -40).join('\n'), '```')
      }
    }
    if (strategy === 'fresh-context') lines.push('Previous approaches failed repeatedly with the same error. Re-read the relevant code and try a different approach.')
  }
  if (steer) lines.push('', '## Direction from the human', steer)
  if (input.memory?.length) lines.push('', '## Project memory (human-approved lessons)', ...input.memory.map(m => `- ${m}`))
  for (const skill of input.skills ?? []) lines.push('', `## Skill: ${skill.name}`, skill.body)
  lines.push(
    '',
    '## Protocol',
    '1. Read the scope. 2. Plan briefly. 3. Make the change. 4. Run the gates yourself. 5. On failure, analyze and fix, then re-run.',
    '6. Stop and set `human_required: true` only for: product-direction choices, irreversible data deletion, permission/network expansion, production deployment, or changing architecture boundaries. Ordinary build/test/lint failures are yours to fix.',
    '7. If the `superagent_report` tool is available, call it for progress/blockers.',
    `8. End your final message with exactly one fenced block tagged \`${REPORT_FENCE}\` containing JSON:`,
    '```' + REPORT_FENCE,
    '{"kind":"result","current_state":"done","progress":100,"changed_modules":[],"verification_result":"claimed_pass","blocker":null,"next_action":null,"human_required":false,"summary":"<one line>"}',
    '```',
    '`verification_result` is `claimed_pass`, `claimed_fail`, or `not_run`.',
  )
  return lines.join('\n')
}

/**
 * Extract the last `superagent-report` block from a Worker's final message.
 * @returns the validated report, or undefined when absent/invalid.
 */
export function extractFinalReport(text: string, fallback: { task_id: string; model: ModelRef }): WorkerReport | undefined {
  const re = new RegExp('```' + REPORT_FENCE + '\\s*\\n([\\s\\S]*?)```', 'g')
  let last: string | undefined
  for (const m of text.matchAll(re)) last = m[1]
  if (last === undefined) return undefined
  try {
    return parseWorkerReport(JSON.parse(last), fallback)
  } catch (invalid) {
    void invalid
    return undefined
  }
}
