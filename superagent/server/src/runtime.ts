/**
 * SuperAgent runtime composition: one StateStore, Verifier (+ architecture gate),
 * Observatory, LoopEngine and Chief, shared by the API server and the CLI.
 */
import type { Project } from '@superagent/contracts'
import { StateStore, defaultHome } from '@superagent/project-state'
import { Verifier } from '@superagent/verifier'
import { Chief, DshHeadlessExecutor, LoopEngine, type ChiefWake, type WorkerExecutor } from '@superagent/chief-worker'
import { Observatory, driftGateRunner, observatoryHooks, type RuntimeInputs } from '@superagent/architecture-observatory'

export interface RuntimeOptions {
  readonly home?: string
  readonly executor?: WorkerExecutor
  /** Extra DSH `--patch` overlays for Workers (e.g. browser-use). */
  readonly workerPatches?: readonly string[]
  readonly onChiefWake?: (wake: ChiefWake) => void
}

export interface SuperAgentRuntime {
  readonly store: StateStore
  readonly verifier: Verifier
  readonly observatory: Observatory
  readonly engine: LoopEngine
  readonly chief: Chief
  runtimeInputs(project: Project): RuntimeInputs
  /** Register a project and take its first architecture snapshot. */
  addProject(input: { name: string; root: string; defaultGates?: Project['defaultGates']; protectedModules?: string[] }): Promise<Project>
  scanArchitecture(project: Project): Promise<void>
}

export function createRuntime(options: RuntimeOptions = {}): SuperAgentRuntime {
  const store = new StateStore(options.home ?? defaultHome())
  const verifier = new Verifier()
  const observatory = new Observatory()
  verifier.register('architecture-drift', driftGateRunner(observatory))

  const runtimeInputs = (project: Project): RuntimeInputs => {
    const tasks = store.listTasks(project.id)
    const latest = new Set(tasks.map(t => t.attempts.at(-1)?.receiptId).filter((x): x is string => !!x))
    return {
      workers: store.listWorkers(project.id),
      receipts: store.listReceipts(project.id).filter(r => latest.has(r.id)),
      latestReceiptIds: latest,
      taskStates: new Map(tasks.map(t => [t.id, t.state])),
    }
  }

  const hooks = observatoryHooks(observatory, {
    runtime: runtimeInputs,
    onUpdated: (project, summary) => {
      store.emitTyped('architecture/updated', project.id, summary)
      if (summary.errors > 0) store.emitTyped('architecture/drift', project.id, summary)
    },
  })

  const engine = new LoopEngine({
    store, verifier,
    executor: options.executor ?? new DshHeadlessExecutor({ patches: options.workerPatches }),
    architecture: hooks,
    onChiefWake: options.onChiefWake,
  })
  const chief = new Chief(engine)

  return {
    store, verifier, observatory, engine, chief, runtimeInputs,
    async addProject(input) {
      const project = store.createProject(input)
      await hooks.refresh(project)
      return project
    },
    scanArchitecture: project => hooks.refresh(project),
  }
}
