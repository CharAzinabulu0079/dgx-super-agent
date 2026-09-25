/**
 * Fresh replay (Directive §4.D): reconstruct the task's representative failing state
 * from its baseline snapshot in a separate git worktree, run a fresh Worker through the
 * normal loop + Verifier (integrity included) with harness-chosen gates, and report.
 * The original working tree and SuperAgent state are never touched.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, LoopEngine, type WorkerExecutor } from '@superagent/chief-worker'
import { parseTaskPolicy, type TaskPolicy } from '@superagent/contracts'
import type { ArmResult, Candidate } from './evolution.ts'

export interface ReplayOptions {
  /** Fresh executor per arm (fresh Worker context). */
  readonly executorFactory: () => WorkerExecutor
  /** Attempt budget per arm. */
  readonly maxAttempts?: number
  /** Ignored directories to link from the original project (dependencies). */
  readonly linkPaths?: readonly string[]
}

export interface ReplaySubject {
  readonly store: StateStore
  readonly candidate: Candidate
  readonly arm: 'baseline' | 'candidate'
}

/** Candidate content as the candidate arm sees it (prompt content or a policy override). */
export function armInjection(c: Candidate, base?: TaskPolicy): { skills?: Array<{ name: string; body: string }>; memory?: string[]; policy?: TaskPolicy } {
  switch (c.kind) {
    case 'routing-policy':
      // Validated like any untrusted policy fragment; invalid JSON makes the arm fail loudly.
      return base ? { policy: parseTaskPolicy(JSON.parse(c.body), base) } : {}
    case 'skill':
    case 'workflow':
    case 'prompt':
      return { skills: [{ name: c.name, body: c.body }] }
    case 'memory':
      return { memory: [c.body] }
    default:
      return {}
  }
}

export async function replayArm(subject: ReplaySubject, options: ReplayOptions): Promise<ArmResult> {
  const started = Date.now()
  const { store, candidate, arm } = subject
  const project = store.requireProject(candidate.evidence.projectId)
  const source = store.requireTask(candidate.evidence.projectId, candidate.evidence.taskId)
  const snapshot = candidate.evidence.snapshot ?? source.baseline?.snapshot
  if (!snapshot) throw new Error(`task ${source.id} has no baseline snapshot to replay from`)

  const worktree = mkdtempSync(join(tmpdir(), `sa-replay-${arm}-`))
  rmSync(worktree, { recursive: true, force: true })
  execFileSync('git', ['worktree', 'add', '--detach', '--force', worktree, snapshot], { cwd: project.root, stdio: 'pipe' })
  const home = mkdtempSync(join(tmpdir(), `sa-replay-home-${arm}-`))
  try {
    for (const rel of options.linkPaths ?? ['node_modules']) {
      if (existsSync(join(project.root, rel)) && !existsSync(join(worktree, rel))) symlinkSync(join(project.root, rel), join(worktree, rel))
    }
    const sandbox = new StateStore(home)
    const replayPolicy: TaskPolicy = { ...source.policy, maxAttempts: options.maxAttempts ?? 2, strategies: ['retry-with-feedback', 'fresh-context'] }
    const injection = arm === 'candidate' ? armInjection(candidate, replayPolicy) : {}
    const engine = new LoopEngine({
      store: sandbox, verifier: new Verifier(), executor: options.executorFactory(),
      skills: () => injection.skills ?? [], memory: () => injection.memory ?? [],
    })
    const gates = source.gates.length ? source.gates : project.defaultGates // harness-chosen, not candidate-chosen
    const replayProject = sandbox.createProject({
      name: `replay-${arm}`, root: worktree, defaultGates: [...gates], protectedModules: [...project.protectedModules],
    })
    if (project.verification) sandbox.updateProject(replayProject.id, { verification: project.verification })
    const chief = new Chief(engine)
    const goal = chief.createGoal(replayProject.id, `replay ${candidate.kind} ${candidate.name} (${arm})`)
    const task = sandbox.createTask({
      projectId: replayProject.id, goalId: goal.id, title: source.title, instructions: source.instructions, scope: source.scope,
      gates: [], policy: injection.policy ?? replayPolicy,
    })
    await chief.runGoal(replayProject.id, goal.id)
    const done = sandbox.requireTask(replayProject.id, task.id)
    const receipts = sandbox.listReceipts(replayProject.id, task.id).sort((a, b) => a.attempt - b.attempt)
    const last = receipts.at(-1)
    return {
      arm, passed: done.state === 'passed', attempts: done.attempts.length, finalState: done.state,
      gateResults: last?.gateResults ?? [],
      integrityBlocked: receipts.some(r => (r.integrity?.findings ?? []).some(f => f.severity === 'block')),
      durationMs: Date.now() - started,
    }
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: project.root, stdio: 'pipe' })
    } catch (alreadyGone) {
      void alreadyGone
      rmSync(worktree, { recursive: true, force: true })
    }
    rmSync(home, { recursive: true, force: true })
  }
}
