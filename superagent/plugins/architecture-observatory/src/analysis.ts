/** Declared-vs-detected drift, change impact, and runtime status (Freeze §7.4, §7.5). */
import type { Receipt, Worker } from '@superagent/contracts'
import type { ChangeSet, DeclaredArchitecture, DriftFinding, ModuleEdge, ModuleInfo, NodeStatus, RuntimeOverlay } from './schema.ts'

/** Strongly connected components with >1 node (Tarjan). */
export function moduleCycles(ids: readonly string[], edges: readonly ModuleEdge[]): string[][] {
  const adj = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of edges) adj.get(e.from)?.push(e.to)
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const on = new Set<string>()
  const out: string[][] = []
  const strong = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++
    stack.push(v); on.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do { w = stack.pop()!; on.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1) out.push(comp.sort())
    }
  }
  for (const id of ids) if (!idx.has(id)) strong(id)
  return out
}

const matches = (pattern: string, id: string): boolean =>
  pattern === '*' || pattern === id || (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1)))

export function detectDrift(declared: DeclaredArchitecture, modules: readonly ModuleInfo[], edges: readonly ModuleEdge[]): DriftFinding[] {
  const findings: DriftFinding[] = []
  const ids = modules.map(m => m.id)
  const runtimeEdges = edges.filter(e => !e.testOnly)
  const byId = new Map(modules.map(m => [m.id, m]))

  if (!declared.allowCycles) {
    for (const cycle of moduleCycles(ids, runtimeEdges.filter(e => !e.typeOnly))) {
      findings.push({ kind: 'cycle', severity: 'error', modules: cycle, detail: `circular runtime dependency: ${cycle.join(' → ')} → ${cycle[0]}` })
    }
  }

  const layers = declared.layers ?? []
  if (layers.length) {
    for (const e of runtimeEdges) {
      const fl = byId.get(e.from)?.layer
      const tl = byId.get(e.to)?.layer
      if (!fl || !tl) continue
      if (layers.indexOf(tl) > layers.indexOf(fl)) {
        findings.push({ kind: 'layer-violation', severity: 'error', modules: [e.from, e.to], detail: `${e.from} (${fl}) depends on higher layer ${e.to} (${tl}); e.g. ${e.evidence[0] ?? ''}` })
      }
    }
  }

  for (const rule of declared.forbidden ?? []) {
    for (const e of runtimeEdges) {
      if (matches(rule.from, e.from) && matches(rule.to, e.to)) {
        findings.push({ kind: 'forbidden-dependency', severity: 'error', modules: [e.from, e.to], detail: `${e.from} → ${e.to} is forbidden${rule.reason ? ` (${rule.reason})` : ''}` })
      }
    }
  }

  const declaredModules = declared.modules ?? []
  if (declaredModules.length) {
    for (const m of modules) {
      if (!m.declared && m.files > 0) findings.push({ kind: 'unregistered-module', severity: 'warn', modules: [m.id], detail: `module ${m.id} (${m.root}) is not in declared.json` })
    }
    for (const d of declaredModules) {
      const m = byId.get(d.id)
      if (!m || m.files === 0) findings.push({ kind: 'missing-module', severity: 'warn', modules: [d.id], detail: `declared module ${d.id} matches no files` })
      if (d.dependsOn) {
        for (const e of runtimeEdges.filter(x => x.from === d.id)) {
          if (!d.dependsOn.includes(e.to)) findings.push({ kind: 'undeclared-dependency', severity: 'warn', modules: [e.from, e.to], detail: `${e.from} → ${e.to} is not in its dependsOn` })
        }
      }
    }
  }
  return findings
}

/** Modules that (transitively) depend on any of `changed` — who may break. */
export function reverseClosure(changed: readonly string[], edges: readonly ModuleEdge[]): string[] {
  const usedBy = new Map<string, string[]>()
  for (const e of edges) {
    if (!usedBy.has(e.to)) usedBy.set(e.to, [])
    usedBy.get(e.to)!.push(e.from)
  }
  const seen = new Set<string>(changed)
  const queue = [...changed]
  while (queue.length) {
    for (const up of usedBy.get(queue.shift()!) ?? []) {
      if (!seen.has(up)) { seen.add(up); queue.push(up) }
    }
  }
  for (const c of changed) seen.delete(c)
  return [...seen].sort()
}

export function changeSet(base: string, files: readonly string[], moduleOf: (f: string) => string | undefined, modules: readonly ModuleInfo[], edges: readonly ModuleEdge[]): ChangeSet {
  const changed = [...new Set(files.map(moduleOf).filter((m): m is string => m !== undefined))].sort()
  const impacted = reverseClosure(changed, edges)
  const gateIds = new Set<string>()
  for (const m of modules) if (changed.includes(m.id) || impacted.includes(m.id)) for (const g of m.gates) gateIds.add(g)
  return { base, files: [...files], modules: changed, impacted, gates: [...gateIds].sort() }
}

export interface RuntimeInputs {
  readonly workers: readonly Worker[]
  readonly receipts: readonly Receipt[]
  /** Latest attempt's receipt id per task (only these count for "gate failed"). */
  readonly latestReceiptIds: ReadonlySet<string>
  readonly taskStates: ReadonlyMap<string, string>
}

export function runtimeOverlay(modules: readonly ModuleInfo[], changes: ChangeSet, inputs: RuntimeInputs | undefined, moduleOf: (f: string) => string | undefined): RuntimeOverlay {
  const status: Record<string, NodeStatus[]> = {}
  const add = (id: string, s: NodeStatus): void => {
    if (!status[id]) status[id] = []
    if (!status[id]!.includes(s)) status[id]!.push(s)
  }
  for (const m of modules) if (m.protected) add(m.id, 'protected')
  for (const m of changes.modules) add(m, 'changing')
  const activeWorkers: RuntimeOverlay['activeWorkers'][number][] = []
  const failedGates: RuntimeOverlay['failedGates'][number][] = []
  if (inputs) {
    for (const w of inputs.workers) {
      if (w.status !== 'running' && w.status !== 'starting') continue
      const fromFiles = (w.lastReport?.current_state.match(/: (\S+)$/)?.[1] ?? '')
      const mods = [...new Set([...w.activeModules, ...(fromFiles ? [moduleOf(relativeToAny(fromFiles, modules))].filter((x): x is string => !!x) : [])])]
      for (const m of mods) add(m, 'worker-active')
      activeWorkers.push({ workerId: w.id, taskId: w.taskId, modules: mods, state: inputs.taskStates.get(w.taskId) ?? 'unknown' })
    }
    for (const r of inputs.receipts) {
      if (r.verdict !== 'FAIL' || !inputs.latestReceiptIds.has(r.id)) continue
      if (inputs.taskStates.get(r.taskId) === 'passed') continue
      const mods = [...new Set([...r.changedModules])]
      for (const m of mods) add(m, 'gate-failed')
      failedGates.push({ taskId: r.taskId, receiptId: r.id, modules: mods, gates: r.gateResults.filter(g => g.status !== 'pass' && g.required).map(g => g.gateId) })
    }
  }
  for (const m of modules) if (!status[m.id]) status[m.id] = ['stable']
  return { generatedAt: new Date().toISOString(), status, activeWorkers, failedGates }
}

/** Best effort: absolute Worker tool paths → project-relative, by matching a module root segment. */
function relativeToAny(path: string, modules: readonly ModuleInfo[]): string {
  for (const m of modules) {
    if (!m.root) continue
    const i = path.indexOf(`/${m.root}/`)
    if (i >= 0) return path.slice(i + 1)
  }
  return path
}

export function toMermaid(modules: readonly ModuleInfo[], edges: readonly ModuleEdge[], status: Record<string, NodeStatus[]>, layers: readonly string[]): string {
  const safe = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, '_')
  const lines = ['flowchart LR']
  const byLayer = new Map<string, ModuleInfo[]>()
  for (const m of modules) {
    const key = m.layer ?? ''
    if (!byLayer.has(key)) byLayer.set(key, [])
    byLayer.get(key)!.push(m)
  }
  const order = [...layers, ...[...byLayer.keys()].filter(k => !layers.includes(k))]
  for (const layer of order) {
    const members = byLayer.get(layer)
    if (!members?.length) continue
    if (layer) lines.push(`  subgraph ${safe(`layer_${layer}`)}["${layer}"]`)
    for (const m of members) lines.push(`${layer ? '    ' : '  '}${safe(m.id)}["${m.id}<br/><small>${m.files} files</small>"]`)
    if (layer) lines.push('  end')
  }
  for (const e of edges) if (!e.testOnly) lines.push(`  ${safe(e.from)} ${e.typeOnly ? '-.->' : '-->'} ${safe(e.to)}`)
  const classes: Record<NodeStatus, string> = {
    stable: 'fill:#e8f5e9,stroke:#2e7d32', changing: 'fill:#fff8e1,stroke:#f9a825', 'worker-active': 'fill:#e3f2fd,stroke:#1565c0',
    'gate-failed': 'fill:#ffebee,stroke:#c62828', protected: 'stroke:#6a1b9a,stroke-width:3px',
  }
  for (const [name, style] of Object.entries(classes)) lines.push(`  classDef ${safe(name)} ${style}`)
  for (const m of modules) {
    const s = status[m.id] ?? ['stable']
    const primary = (['gate-failed', 'worker-active', 'changing', 'stable'] as NodeStatus[]).find(x => s.includes(x)) ?? 'stable'
    lines.push(`  class ${safe(m.id)} ${safe(primary)}`)
  }
  return `${lines.join('\n')}\n`
}
