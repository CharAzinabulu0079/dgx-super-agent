/**
 * Architecture Observatory facade: scan → analyze → persist `.architecture/`.
 * Consumers (engine, Verifier, UI, Chief tools) read the persisted graph
 * instead of re-reading the repository (Freeze §18.6).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { GateResult, GateSpec } from '@superagent/contracts'
import { changeSet, detectDrift, runtimeOverlay, toMermaid, type RuntimeInputs } from './analysis.ts'
import { scanProject } from './scan.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type ArchitectureGraph, type DeclaredArchitecture, type DriftFinding, type GraphNode, type ModuleInfo, type RuntimeOverlay,
} from './schema.ts'

export const ARCH_DIR = '.architecture'

export interface ScanOptions {
  /** Git base for the change set; default: working tree vs HEAD. */
  readonly base?: string
  readonly runtime?: RuntimeInputs
  /** Skills relevant to this project (from the learning store). */
  readonly skills?: readonly unknown[]
  /** Write `.architecture/` (default true). */
  readonly write?: boolean
}

export function loadDeclared(root: string): DeclaredArchitecture & { acceptedDrift?: readonly string[] } {
  const file = join(root, ARCH_DIR, 'declared.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

export const driftKey = (f: DriftFinding): string => `${f.kind}:${[...f.modules].sort().join(',')}`

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  } catch (notGit) {
    void notGit
    return undefined
  }
}

/** Changed files: working tree vs HEAD (+ untracked), plus `base...HEAD` when given. */
export function changedFiles(root: string, base?: string): string[] {
  const out = new Set<string>()
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status) {
    const entries = status.split('\0').filter(Boolean)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      out.add(e.slice(3))
      if (e[0] === 'R' || e[0] === 'C') i++
    }
  }
  if (base) for (const f of (git(root, ['diff', '--name-only', `${base}...HEAD`]) ?? '').split('\n')) if (f) out.add(f)
  return [...out].filter(f => !f.startsWith(`${ARCH_DIR}/`)).sort()
}

/** File → module resolver rebuilt from persisted modules (no rescan). */
export function resolverFromModules(modules: readonly Pick<ModuleInfo, 'id' | 'paths' | 'root' | 'source'>[]): (file: string) => string | undefined {
  const ordered = [...modules].sort((a, b) => (a.source === 'declared' ? -1 : 0) - (b.source === 'declared' ? -1 : 0) || b.root.length - a.root.length)
  const matchers = ordered.map(m => ({ id: m.id, match: picomatch([...m.paths], { dot: true }) }))
  return file => matchers.find(m => m.match(file))?.id
}

function writeJson(dir: string, name: string, value: unknown): void {
  const file = join(dir, name)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

export class Observatory {
  /** Scan a project and (by default) persist `.architecture/`. */
  async scan(root: string, options: ScanOptions = {}): Promise<ArchitectureGraph> {
    const declared = loadDeclared(root)
    const scan = await scanProject(root, declared)
    const drift = detectDrift(declared, scan.modules, scan.edges)
    const accepted = new Set(declared.acceptedDrift ?? [])
    const effectiveDrift = drift.map(f => (accepted.has(driftKey(f)) ? { ...f, severity: 'warn' as const, detail: `${f.detail} (accepted)` } : f))
    const changes = changeSet(options.base ?? 'HEAD', changedFiles(root, options.base), scan.resolver.moduleOf, scan.modules, scan.edges)
    const runtime = runtimeOverlay(scan.modules, changes, options.runtime, scan.resolver.moduleOf)
    const graph = assembleGraph(root, declared, scan.modules, scan.edges, effectiveDrift, changes, runtime, scan.services, scan.files.length, scan.scanMs)

    if (options.write !== false) {
      const dir = join(root, ARCH_DIR)
      mkdirSync(dir, { recursive: true })
      if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '# volatile overlays (regenerated continuously)\nruntime.json\nchanges.json\n')
      writeJson(dir, 'modules.json', scan.modules)
      writeJson(dir, 'dependencies.json', { edges: scan.edges, fileCycles: scan.fileCycles })
      writeJson(dir, 'services.json', scan.services)
      writeJson(dir, 'interfaces.json', scan.interfaces)
      writeJson(dir, 'dataflows.json', declared.dataflows ?? [])
      writeJson(dir, 'skills.json', options.skills ?? [])
      writeJson(dir, 'drift.json', effectiveDrift)
      writeJson(dir, 'runtime.json', runtime)
      writeJson(dir, 'changes.json', changes)
      writeJson(dir, 'graph.json', graph)
      writeFileSync(join(dir, 'graph.mmd'), toMermaid(scan.modules, scan.edges, runtime.status, declared.layers ?? []))
    }
    return graph
  }

  /** Read the persisted graph, if any. */
  load(root: string): ArchitectureGraph | undefined {
    const file = join(root, ARCH_DIR, 'graph.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ArchitectureGraph : undefined
  }

  loadModules(root: string): ModuleInfo[] {
    const file = join(root, ARCH_DIR, 'modules.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ModuleInfo[] : []
  }

  /** Recompute only the runtime overlay on a persisted graph (cheap; for live UI). */
  withRuntime(root: string, runtime: RuntimeInputs | undefined): ArchitectureGraph | undefined {
    const graph = this.load(root)
    if (!graph) return undefined
    const modules = this.loadModules(root)
    const moduleOf = resolverFromModules(modules)
    const changes = changeSet(graph.changes.base, changedFiles(root), moduleOf, modules, graph.edges)
    const overlay = runtimeOverlay(modules, changes, runtime, moduleOf)
    const headCommit = git(root, ['rev-parse', '--short', 'HEAD'])?.trim()
    const sameFiles = JSON.stringify([...changes.files].sort()) === JSON.stringify([...graph.changes.files].sort())
    const unmapped = changes.files.filter(f => !moduleOf(f) && /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(f))
    const reason = headCommit !== graph.commit ? `HEAD moved (${graph.commit ?? 'none'} → ${headCommit ?? 'none'})` : !sameFiles ? 'working tree changed since the last scan' : unmapped.length ? `unmapped source files: ${unmapped.slice(0, 5).join(', ')}` : 'current'
    return {
      ...graph, changes, nodes: graph.nodes.map(n => ({ ...n, status: overlay.status[n.id] ?? ['stable'] })),
      freshness: { stale: reason !== 'current', reason, graphCommit: graph.commit, headCommit },
    }
  }
}

function assembleGraph(
  root: string, declared: DeclaredArchitecture, modules: readonly ModuleInfo[], edges: ArchitectureGraph['edges'],
  drift: readonly DriftFinding[], changes: ArchitectureGraph['changes'], runtime: RuntimeOverlay,
  services: ArchitectureGraph['services'], files: number, scanMs: number,
): ArchitectureGraph {
  const nodes: GraphNode[] = modules.map(m => ({
    id: m.id,
    label: m.id,
    layer: m.layer,
    root: m.root,
    status: runtime.status[m.id] ?? ['stable'],
    files: m.files,
    declared: m.declared,
    protected: m.protected,
    dependsOn: edges.filter(e => e.from === m.id).map(e => e.to),
    usedBy: edges.filter(e => e.to === m.id).map(e => e.from),
    gates: m.gates,
    adrs: m.adrs,
    tests: m.tests,
    entry: m.entry,
    description: m.description,
    drift: [...new Set(drift.filter(f => f.modules.includes(m.id)).map(f => f.kind))],
  }))
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    project: root.split('/').pop() ?? root,
    generatedAt: new Date().toISOString(),
    commit: git(root, ['rev-parse', '--short', 'HEAD'])?.trim(),
    layers: declared.layers ?? [],
    nodes, edges, drift, changes, services,
    dataflows: declared.dataflows ?? [],
    stats: { files, modules: modules.length, edges: edges.length, scanMs },
  }
}

/** Verifier gate: `architecture-drift` fails on error-severity drift not accepted in declared.json. */
export function driftGateRunner(observatory: Observatory) {
  return async (spec: GateSpec, ctx: { projectRoot: string }): Promise<GateResult> => {
    const started = Date.now()
    const graph = await observatory.scan(ctx.projectRoot)
    const errors = graph.drift.filter(f => f.severity === 'error')
    const warns = graph.drift.length - errors.length
    return {
      gateId: spec.id, kind: spec.kind, required: spec.required,
      status: errors.length ? 'fail' : 'pass',
      durationMs: Date.now() - started,
      summary: `${errors.length} architecture error(s), ${warns} warning(s) across ${graph.stats.modules} modules`,
      outputTail: graph.drift.map(f => `${f.severity.toUpperCase()} ${f.kind}: ${f.detail}`).join('\n'),
      failureSignature: errors.length ? `${spec.id}:${errors.map(driftKey).sort().join('|')}` : undefined,
      details: { drift: graph.drift },
    }
  }
}
