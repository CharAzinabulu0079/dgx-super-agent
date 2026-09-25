/** Architecture Observatory view: React Flow module graph + node inspector + impact. */
import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type ArchitectureGraph, type GraphNode } from './api.ts'

const STATUS_COLOR: Record<string, string> = {
  'gate-failed': '#ef4444', 'worker-active': '#3b82f6', changing: '#f59e0b', stable: '#22c55e', protected: '#a855f7',
}
const primaryStatus = (s: string[]): string => ['gate-failed', 'worker-active', 'changing', 'stable'].find(x => s.includes(x)) ?? 'stable'

/** Layered layout: column = declared layer (or dependency depth), row = order within column. */
function layout(graph: ArchitectureGraph): Map<string, { x: number; y: number }> {
  const deps = new Map(graph.nodes.map(n => [n.id, graph.edges.filter(e => e.from === n.id && !e.testOnly).map(e => e.to)]))
  const depth = new Map<string, number>()
  const visit = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (stack.has(id)) return 0
    stack.add(id)
    const d = Math.max(-1, ...(deps.get(id) ?? []).map(x => visit(x, stack))) + 1
    stack.delete(id)
    depth.set(id, d)
    return d
  }
  const column = (n: GraphNode): number => (n.layer && graph.layers.includes(n.layer) ? graph.layers.indexOf(n.layer) : visit(n.id, new Set()))
  const rows = new Map<number, number>()
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const c = column(n)
    const r = rows.get(c) ?? 0
    rows.set(c, r + 1)
    pos.set(n.id, { x: c * 280, y: r * 110 })
  }
  return pos
}

export function ArchitectureView({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [graph, setGraph] = useState<ArchitectureGraph | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [showImpact, setShowImpact] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<ArchitectureGraph>('GET', `/api/projects/${projectId}/architecture`).then(setGraph, e => setError(String(e)))
  }, [projectId, refreshKey])

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] }
    const pos = layout(graph)
    const impacted = new Set(showImpact ? graph.changes.impacted : [])
    const nodes: Node[] = graph.nodes.map(n => {
      const st = primaryStatus(n.status)
      return {
        id: n.id,
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { label: (
          <div data-testid={`arch-node-${n.id}`} data-status={n.status.join(' ')}>
            <strong>{n.id}</strong>
            <div className="node-meta">{n.layer ?? '—'} · {n.files} files</div>
            <div className="node-badges">{n.status.map(s => <span key={s} className="badge" style={{ background: STATUS_COLOR[s] }}>{s}</span>)}{n.drift.length ? <span className="badge" style={{ background: '#dc2626' }}>drift</span> : null}</div>
          </div>
        ) },
        style: {
          border: `2px solid ${STATUS_COLOR[st]}`,
          outline: n.protected ? `3px dashed ${STATUS_COLOR.protected}` : impacted.has(n.id) ? '3px dotted #f59e0b' : undefined,
          outlineOffset: 3, borderRadius: 10, width: 200, background: 'var(--panel)', color: 'var(--fg)',
          boxShadow: selected === n.id ? '0 0 0 3px var(--accent)' : undefined,
        },
      }
    })
    const edges: Edge[] = graph.edges.filter(e => !e.testOnly).map(e => ({
      id: `${e.from}->${e.to}`, source: e.from, target: e.to, label: e.weight > 1 ? String(e.weight) : undefined,
      animated: graph.changes.modules.includes(e.to), style: { strokeDasharray: e.typeOnly ? '5 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed },
    }))
    return { nodes, edges }
  }, [graph, selected, showImpact])

  if (error) return <div className="error">{error}</div>
  if (!graph) return <div className="muted">Scanning architecture…</div>
  const node = graph.nodes.find(n => n.id === selected)
  const rescan = () => api<ArchitectureGraph>('POST', `/api/projects/${projectId}/architecture/scan`).then(setGraph, e => setError(String(e)))

  return (
    <div className="arch" data-testid="architecture-view">
      <div className="arch-toolbar">
        <span>{graph.stats.modules} modules · {graph.stats.edges} edges · {graph.stats.files} files · commit {graph.commit ?? '—'} · scanned {new Date(graph.generatedAt).toLocaleTimeString()}</span>
        <label><input type="checkbox" checked={showImpact} onChange={e => setShowImpact(e.target.checked)} /> change impact</label>
        <button onClick={rescan}>Rescan</button>
        <span className="legend">{Object.entries(STATUS_COLOR).map(([k, c]) => <span key={k}><i style={{ background: c }} />{k}</span>)}</span>
      </div>
      <div className="arch-body">
        <div className="arch-canvas">
          <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, n) => setSelected(n.id)} nodesDraggable proOptions={{ hideAttribution: true }}>
            <Background /><Controls /><MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <aside className="arch-side">
          {graph.changes.modules.length > 0 && (
            <section data-testid="impact-panel">
              <h4>Change impact</h4>
              <div>changing: {graph.changes.modules.join(', ')}</div>
              <div>impacted: {graph.changes.impacted.join(', ') || '—'}</div>
              <div>gates to run: {graph.changes.gates.join(', ') || '—'}</div>
            </section>
          )}
          {graph.drift.length > 0 && (
            <section>
              <h4>Architecture drift</h4>
              <ul>{graph.drift.map((d, i) => <li key={i} className={d.severity}>{d.severity} {d.kind}: {d.detail}</li>)}</ul>
            </section>
          )}
          {node ? (
            <section data-testid="node-inspector">
              <h4>{node.id}</h4>
              {node.description && <p className="muted">{node.description}</p>}
              <dl>
                <dt>Location</dt><dd><code>{node.root || '.'}</code>{node.entry && <> · entry <code>{node.entry}</code></>}</dd>
                <dt>Status</dt><dd>{node.status.join(', ')}</dd>
                <dt>Depends on</dt><dd>{node.dependsOn.join(', ') || '—'}</dd>
                <dt>Used by</dt><dd>{node.usedBy.join(', ') || '—'}</dd>
                <dt>Gates</dt><dd>{node.gates.join(', ') || '—'}</dd>
                <dt>ADRs</dt><dd>{node.adrs.join(', ') || '—'}</dd>
                <dt>Tests</dt><dd>{node.tests.length ? node.tests.map(t => <div key={t}><code>{t}</code></div>) : '—'}</dd>
                <dt>Drift</dt><dd>{node.drift.join(', ') || 'none'}</dd>
              </dl>
            </section>
          ) : <p className="muted">Click a module to inspect location, dependencies, users, ADRs and tests.</p>}
        </aside>
      </div>
    </div>
  )
}
