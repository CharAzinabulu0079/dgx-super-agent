/**
 * Loop-engine integration: map changed files to modules and impact from the
 * persisted graph, and rescan after every attempt so the map stays live.
 * Structurally matches chief-worker's `ArchitectureHooks` (no import cycle).
 */
import type { Project } from '@superagent/contracts'
import { reverseClosure, type RuntimeInputs } from './analysis.ts'
import { Observatory, resolverFromModules } from './observatory.ts'

export interface ObservatoryHooksOptions {
  /** Supplies live worker/receipt state for the runtime overlay. */
  readonly runtime?: (project: Project) => RuntimeInputs | undefined
  readonly onUpdated?: (project: Project, summary: { modules: number; edges: number; drift: number; errors: number }) => void
}

export function observatoryHooks(observatory: Observatory = new Observatory(), options: ObservatoryHooksOptions = {}) {
  return {
    modulesForFiles(project: Project, files: readonly string[]): string[] {
      const moduleOf = resolverFromModules(observatory.loadModules(project.root))
      return [...new Set(files.map(moduleOf).filter((m): m is string => m !== undefined))].sort()
    },
    impactOf(project: Project, modules: readonly string[]): string[] {
      const graph = observatory.load(project.root)
      return graph ? reverseClosure(modules, graph.edges) : []
    },
    async refresh(project: Project): Promise<void> {
      const graph = await observatory.scan(project.root, { runtime: options.runtime?.(project) })
      options.onUpdated?.(project, {
        modules: graph.stats.modules, edges: graph.stats.edges, drift: graph.drift.length,
        errors: graph.drift.filter(d => d.severity === 'error').length,
      })
    },
  }
}
