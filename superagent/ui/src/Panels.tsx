/** Harness capability panels (Directive §6): model policy, learning, health/wake. Details stay collapsible. */
import { useEffect, useState } from 'react'
import { api, fmtModel, type ModelRef } from './api.ts'

const ROLES = ['chief', 'worker', 'reviewer', 'escalation', 'planner'] as const
type Models = Partial<Record<(typeof ROLES)[number], ModelRef>>

export function PolicyPanel({ projectId, onError }: { projectId: string; onError: (e: string) => void }) {
  const [global, setGlobal] = useState<{ models?: Models }>({})
  const [project, setProject] = useState<{ models?: Models }>({})
  const [effective, setEffective] = useState<Models>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const load = () => {
    api<{ global: { models?: Models } }>('GET', '/api/policy').then(r => setGlobal(r.global), e => onError(String(e)))
    api<{ project: { policy?: { models?: Models } }; models: Models }>('GET', `/api/projects/${projectId}`).then(r => { setProject(r.project.policy ?? {}); setEffective(r.models) }, e => onError(String(e)))
  }
  useEffect(load, [projectId])
  const current = scope === 'global' ? global : project
  const save = () => {
    const models: Record<string, string | null> = {}
    for (const r of ROLES) {
      const v = (draft[r] ?? (current.models?.[r] ? fmtModel(current.models[r]) : '')).trim()
      if (v) models[r] = v
    }
    const path = scope === 'global' ? '/api/policy' : `/api/projects/${projectId}/policy`
    api('POST', path, { ...current, models }).then(() => { setDraft({}); load() }, e => onError(String(e)))
  }
  return (
    <section className="card" data-testid="policy-panel">
      <h3>Model policy</h3>
      <p className="muted">Defaults ← global ← project ← task pin. Un-pinned tasks pick up changes on their next attempt — no model call needed.</p>
      <div className="tabs inline">
        <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')} data-testid="policy-scope-global">All projects</button>
        <button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')} data-testid="policy-scope-project">This project</button>
      </div>
      <table className="tasks">
        <thead><tr><th>Role</th><th>{scope === 'global' ? 'Global default' : 'Project override'}</th><th>Effective here</th></tr></thead>
        <tbody>{ROLES.map(r => (
          <tr key={r}>
            <td>{r}</td>
            <td><input list="models" data-testid={`policy-${r}`} placeholder={current.models?.[r] ? fmtModel(current.models[r]) : 'inherit'} value={draft[r] ?? ''} onChange={e => setDraft({ ...draft, [r]: e.target.value })} /></td>
            <td data-testid={`effective-${r}`}>{effective[r] ? fmtModel(effective[r]) : <span className="muted">= worker</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      <button onClick={save} data-testid="policy-save">Save {scope} policy</button>
    </section>
  )
}

interface Candidate {
  id: string; kind: string; name: string; description: string; status: string; source: string; decision?: string; body: string
  comparison?: { improved: boolean; reason: string }
  evals: Array<{ method: string; arms: Array<{ arm: string; passed: boolean; attempts: number }> }>
}

const GOVERNANCE: Record<string, string> = {
  memory: 'human decision', skill: 'replay evidence', workflow: 'replay evidence', prompt: 'replay evidence',
  'routing-policy': 'evidence + human', 'verifier-policy': 'evidence + human', 'plugin-config': 'evidence + human',
}

export function LearningPanel({ projectId, onError, refreshKey }: { projectId: string; onError: (e: string) => void; refreshKey: number }) {
  const [items, setItems] = useState<Candidate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => api<Candidate[]>('GET', `/api/learning?project=${projectId}`).then(setItems, e => onError(String(e)))
  useEffect(() => { void load() }, [projectId, refreshKey])
  const act = (id: string, p: Promise<unknown>) => { setBusy(id); p.then(load, e => onError(String(e))).finally(() => setBusy(null)) }
  return (
    <section className="card" data-testid="learning-panel">
      <h3>Learning candidates</h3>
      <p className="muted">Nothing becomes active knowledge without evidence (fresh replay) and/or a human.</p>
      <table className="tasks">
        <thead><tr><th>Candidate</th><th>Status</th><th>Evidence</th><th /></tr></thead>
        <tbody>{items.map(c => (
          <tr key={c.id} data-testid={`candidate-${c.name}`}>
            <td><strong>{c.kind}</strong> {c.name}<div className="muted">{c.description} · {c.source} · needs {GOVERNANCE[c.kind]}</div>
              <details><summary>content</summary><pre>{c.body}</pre></details></td>
            <td><span className={`state ${c.status}`} data-testid="candidate-status">{c.status}</span>{c.decision && <div className="muted">{c.decision}</div>}</td>
            <td>{c.evals.flatMap(e => e.arms).map(a => <div key={a.arm}>{a.arm}: {a.passed ? 'PASS' : 'FAIL'} in {a.attempts}</div>)}{c.comparison && <div className="muted">{c.comparison.reason}</div>}</td>
            <td className="actions">
              {c.status === 'candidate' && c.kind !== 'memory' && <button disabled={busy === c.id} onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/evaluate`, {}))}>{busy === c.id ? 'Replaying…' : 'Evaluate (replay)'}</button>}
              {c.status === 'candidate' && (c.kind === 'memory' || GOVERNANCE[c.kind] === 'evidence + human') && <>
                <button onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/decide`, { approved: true }))} data-testid="candidate-approve">Approve</button>
                <button className="danger" onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/decide`, { approved: false }))}>Reject</button>
              </>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      {!items.length && <p className="muted">No candidates yet — they appear after tasks pass.</p>}
    </section>
  )
}

interface ChiefStatus { enabled: boolean; pending: number; failed: number; lastDelivery: { at: string; wakes: number } | null; session: { sessionId: string } | null; recent: Array<{ id: string; reason: string; priority: string; status: string; summary: string }> }
interface ArchStatus { stats: { modules: number }; drift: Array<{ severity: string }>; freshness?: { stale: boolean; reason: string } }

export function HealthPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [chief, setChief] = useState<ChiefStatus | null>(null)
  const [arch, setArch] = useState<ArchStatus | null>(null)
  useEffect(() => {
    api<ChiefStatus>('GET', `/api/projects/${projectId}/chief`).then(setChief, () => setChief(null))
    api<ArchStatus>('GET', `/api/projects/${projectId}/architecture`).then(setArch, () => setArch(null))
  }, [projectId, refreshKey])
  const errors = arch?.drift.filter(d => d.severity === 'error').length ?? 0
  return (
    <section className="card health" data-testid="health-panel">
      <h3>Health</h3>
      <div className="health-row">
        <span data-testid="health-chief" className={`badge ${chief?.failed ? 'warn' : ''}`}>Chief wake: {chief ? (chief.enabled ? `on · ${chief.pending} pending${chief.failed ? ` · ${chief.failed} failed` : ''}` : 'off') : '—'}</span>
        <span className="badge">last wake: {chief?.lastDelivery ? new Date(chief.lastDelivery.at).toLocaleTimeString() : 'never'}</span>
        <span data-testid="health-arch" className={`badge ${errors ? 'warn' : ''}`}>architecture: {arch ? `${arch.stats.modules} modules · ${errors} drift error(s)${arch.freshness?.stale ? ' · rescanning' : ''}` : '—'}</span>
      </div>
      {chief && chief.recent.length > 0 && (
        <details><summary>Recent Chief wakes</summary>
          <ul>{chief.recent.map(w => <li key={w.id}>[{w.priority}] {w.reason} — {w.status}: {w.summary}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
