/**
 * Durable goal queue. One goal runs per project tree at a time (concurrent Workers in
 * one worktree would mix their changes); further run requests wait. A request is
 * persisted on the goal (`runRequested`), so a restarted server resumes what was
 * running or queued instead of forgetting it.
 */
import type { Goal } from '@superagent/contracts'
import type { StateStore } from '@superagent/project-state'
import type { Chief } from '@superagent/chief-worker'

const FINAL: ReadonlySet<Goal['status']> = new Set<Goal['status']>(['complete', 'failed'])

export class GoalRunner {
  private readonly store: StateStore
  private readonly chief: Chief
  private readonly active = new Map<string, Promise<void>>()
  private held = false

  constructor(store: StateStore, chief: Chief) {
    this.store = store
    this.chief = chief
    chief.hold = () => this.held
  }

  /**
   * Drain: no new goal or task starts; running tasks finish and their goals stay requested,
   * so they resume on release or after a restart (e.g. an update). Release resumes now.
   */
  setHold(on: boolean): void {
    this.held = on
    if (!on) this.resumeAll()
  }

  get onHold(): boolean {
    return this.held
  }

  /** Goal currently running in `projectId`, if any. */
  running(projectId: string): string | undefined {
    for (const k of this.active.keys()) if (k.startsWith(`${projectId}/`)) return k.slice(projectId.length + 1)
    return undefined
  }

  /** Request a run; starts now or when the project's current goal finishes. */
  start(projectId: string, goalId: string): { started: boolean; queued: boolean; runningGoal?: string } {
    const goal = this.store.getGoal(projectId, goalId)
    if (!goal) throw new Error(`goal ${goalId} not found`)
    if (this.active.has(`${projectId}/${goalId}`)) return { started: false, queued: false, runningGoal: goalId }
    this.store.updateGoal(projectId, goalId, { runRequested: true })
    const current = this.running(projectId)
    if (current) return { started: false, queued: true, runningGoal: current }
    this.pump(projectId)
    return { started: true, queued: false }
  }

  /** Resume every requested run (server start). */
  resumeAll(): void {
    for (const p of this.store.listProjects()) this.pump(p.id)
  }

  /** Resolves when nothing is running in the project (tests, CLI). */
  async idle(projectId: string): Promise<void> {
    for (;;) {
      const current = [...this.active.entries()].filter(([k]) => k.startsWith(`${projectId}/`)).map(([, v]) => v)
      if (!current.length) return
      await Promise.all(current)
    }
  }

  private pump(projectId: string): void {
    if (this.held || this.running(projectId)) return
    const next = this.store.listGoals(projectId)
      .filter(g => g.runRequested && !FINAL.has(g.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (!next) {
      // Clear stale requests on goals that already finished.
      for (const g of this.store.listGoals(projectId)) if (g.runRequested) this.store.updateGoal(projectId, g.id, { runRequested: false })
      return
    }
    const key = `${projectId}/${next.id}`
    const run = this.chief.runGoal(projectId, next.id)
      .then(() => undefined, error => { this.store.emitTyped('goal/updated', projectId, { error: String(error) }, { goalId: next.id }) })
      .finally(() => {
        this.active.delete(key)
        // A run ends complete, failed, blocked (human gate) or paused: the request is served.
        // Stopped by a hold it is still active and stays requested, to resume later.
        const g = this.store.getGoal(projectId, next.id)
        if (g && !(this.held && g.status === 'active')) this.store.updateGoal(projectId, next.id, { runRequested: false })
        this.pump(projectId)
      })
    this.active.set(key, run)
  }
}
