/**
 * Architecture Graph schema (Freeze §7). Files under `<project>/.architecture/`:
 *
 *   declared.json      human/Chief-maintained intent (the only hand-edited file)
 *   modules.json       detected modules (+ declared metadata)
 *   dependencies.json  module-level edges with file-level evidence
 *   services.json      runnable entry points (bins, scripts, DSH bundles, servers)
 *   interfaces.json    exported symbols per module entry
 *   dataflows.json     declared data flows (not statically inferable in v0.1)
 *   runtime.json       live overlay: worker-active / gate-failed / changing
 *   skills.json        promoted Skills relevant to the project
 *   changes.json       working-tree / diff change set → impact
 *   drift.json         declared-vs-detected findings
 *   graph.json         everything the UI needs, in one document
 */

export const GRAPH_SCHEMA_VERSION = 1

export interface DeclaredModule {
  readonly id: string
  /** Globs (relative to project root) owned by this module. */
  readonly paths: readonly string[]
  readonly layer?: string
  readonly description?: string
  readonly protected?: boolean
  /** Allowed dependencies; when present, any other detected dependency is drift. */
  readonly dependsOn?: readonly string[]
  /** Gate ids that cover this module (drives change impact → gates). */
  readonly gates?: readonly string[]
  readonly adrs?: readonly string[]
}

export interface DeclaredArchitecture {
  readonly version?: number
  /** Ordered low → high. A module may depend on its own layer or lower. */
  readonly layers?: readonly string[]
  readonly modules?: readonly DeclaredModule[]
  readonly forbidden?: ReadonlyArray<{ readonly from: string; readonly to: string; readonly reason?: string }>
  readonly allowCycles?: boolean
  /** Drift finding keys (`kind:modA,modB`) acknowledged by a human; downgraded to warn. */
  readonly acceptedDrift?: readonly string[]
  /** Paths never scanned (globs). */
  readonly ignore?: readonly string[]
  readonly dataflows?: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>
}

export type ModuleSource = 'declared' | 'manifest' | 'directory'

export interface ModuleInfo {
  readonly id: string
  readonly source: ModuleSource
  /** Root directory relative to the project (first path for declared globs). */
  readonly root: string
  readonly paths: readonly string[]
  readonly packageName?: string
  readonly layer?: string
  readonly description?: string
  readonly protected: boolean
  readonly declared: boolean
  readonly files: number
  readonly gates: readonly string[]
  readonly adrs: readonly string[]
  readonly tests: readonly string[]
  readonly entry?: string
  readonly externalDeps: readonly string[]
}

export interface ModuleEdge {
  readonly from: string
  readonly to: string
  /** Number of file-level imports backing this edge. */
  readonly weight: number
  readonly typeOnly: boolean
  /** Every backing import comes from a test file (excluded from cycle/layer rules). */
  readonly testOnly: boolean
  /** Up to 5 example `file → file` imports. */
  readonly evidence: readonly string[]
}

export interface ServiceInfo {
  readonly id: string
  readonly module: string
  readonly kind: 'bin' | 'script' | 'dsh-bundle' | 'http-server'
  readonly detail: string
}

export interface InterfaceInfo {
  readonly module: string
  readonly entry: string
  readonly exports: readonly string[]
}

export type DriftKind = 'cycle' | 'layer-violation' | 'unregistered-module' | 'undeclared-dependency' | 'forbidden-dependency' | 'missing-module'
export type DriftSeverity = 'error' | 'warn'

export interface DriftFinding {
  readonly kind: DriftKind
  readonly severity: DriftSeverity
  readonly modules: readonly string[]
  readonly detail: string
}

export type NodeStatus = 'stable' | 'changing' | 'worker-active' | 'gate-failed' | 'protected'

export interface RuntimeOverlay {
  readonly generatedAt: string
  /** module → statuses (a module can be protected and changing). */
  readonly status: Record<string, NodeStatus[]>
  readonly activeWorkers: ReadonlyArray<{ readonly workerId: string; readonly taskId: string; readonly modules: readonly string[]; readonly state: string }>
  readonly failedGates: ReadonlyArray<{ readonly taskId: string; readonly receiptId: string; readonly modules: readonly string[]; readonly gates: readonly string[] }>
}

export interface ChangeSet {
  readonly base: string
  readonly files: readonly string[]
  readonly modules: readonly string[]
  /** Reverse-dependency closure of `modules` (excluding them). */
  readonly impacted: readonly string[]
  /** Gates covering changed + impacted modules. */
  readonly gates: readonly string[]
}

export interface GraphNode {
  readonly id: string
  readonly label: string
  readonly layer?: string
  readonly root: string
  readonly status: readonly NodeStatus[]
  readonly files: number
  readonly declared: boolean
  readonly protected: boolean
  readonly dependsOn: readonly string[]
  readonly usedBy: readonly string[]
  readonly gates: readonly string[]
  readonly adrs: readonly string[]
  readonly tests: readonly string[]
  readonly entry?: string
  readonly description?: string
  readonly drift: readonly DriftKind[]
}

export interface ArchitectureGraph {
  readonly schemaVersion: number
  readonly project: string
  readonly generatedAt: string
  readonly commit?: string
  readonly layers: readonly string[]
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly ModuleEdge[]
  readonly drift: readonly DriftFinding[]
  readonly changes: ChangeSet
  readonly services: readonly ServiceInfo[]
  readonly dataflows: DeclaredArchitecture['dataflows']
  readonly stats: { readonly files: number; readonly modules: number; readonly edges: number; readonly scanMs: number }
  /** Set on live reads: whether the persisted graph still describes the working tree. */
  readonly freshness?: { readonly stale: boolean; readonly reason: string; readonly graphCommit?: string; readonly headCommit?: string }
}
