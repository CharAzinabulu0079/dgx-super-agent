/** Harness capability panels (Directive §6): model policy, learning, health/wake. Details stay collapsible. */
import { useEffect, useState } from 'react'
import { api, fmtModel, type ModelRef } from './api.ts'
import { t, tState } from './i18n.ts'

const ROLES = ['chief', 'worker', 'reviewer', 'escalation', 'planner'] as const
type Models = Partial<Record<(typeof ROLES)[number], ModelRef>>

export function PolicyPanel({ projectId, onError }: { projectId: string; onError: (e: string) => void }) {
  const [global, setGlobal] = useState<{ models?: Models }>({})
  const [project, setProject] = useState<{ models?: Models }>({})
  const [effective, setEffective] = useState<Models>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [globalAutonomy, setGlobalAutonomy] = useState<string | undefined>()
  const [projectAutonomy, setProjectAutonomy] = useState<string | undefined>()
  const load = () => {
    api<{ global: { models?: Models; autonomy?: string } }>('GET', '/api/policy').then(r => { setGlobal(r.global); setGlobalAutonomy(r.global.autonomy) }, e => onError(String(e)))
    api<{ project: { policy?: { models?: Models; autonomy?: string } }; models: Models }>('GET', `/api/projects/${projectId}`).then(r => { setProject(r.project.policy ?? {}); setProjectAutonomy(r.project.policy?.autonomy); setEffective(r.models) }, e => onError(String(e)))
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
    const autonomy = scope === 'global' ? globalAutonomy : projectAutonomy
    api('POST', path, { ...current, models, autonomy: autonomy ?? null }).then(() => { setDraft({}); load() }, e => onError(String(e)))
  }
  return (
    <section className="card" data-testid="policy-panel">
      <h3>{t('Model policy')}</h3>
      <p className="muted">{t('Defaults ← global ← project ← task pin. Un-pinned tasks pick up changes on their next attempt — no model call needed.')}</p>
      <div className="tabs inline">
        <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')} data-testid="policy-scope-global">{t('All projects')}</button>
        <button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')} data-testid="policy-scope-project">{t('This project')}</button>
      </div>
      <table className="tasks">
        <thead><tr><th>{t('Role')}</th><th>{scope === 'global' ? t('Global default') : t('Project override')}</th><th>{t('Effective here')}</th></tr></thead>
        <tbody>{ROLES.map(r => (
          <tr key={r}>
            <td>{t(r)}</td>
            <td><input list="models" data-testid={`policy-${r}`} placeholder={current.models?.[r] ? fmtModel(current.models[r]) : t('inherit')} value={draft[r] ?? ''} onChange={e => setDraft({ ...draft, [r]: e.target.value })} /></td>
            <td data-testid={`effective-${r}`}>{effective[r] ? fmtModel(effective[r]) : <span className="muted">{t('= worker')}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="field"><div className="field-label">{t('Safe mode')}</div><div>
        <div className="seg" role="radiogroup">{(scope === 'project' ? ['', 'read-only', 'normal', 'high'] : ['read-only', 'normal', 'high']).map(m => {
          const cur = (scope === 'global' ? globalAutonomy ?? 'normal' : projectAutonomy ?? '')
          return <button key={m} role="radio" aria-checked={cur === m} className={cur === m ? 'on' : ''} onClick={() => (scope === 'global' ? setGlobalAutonomy(m) : setProjectAutonomy(m || undefined))} data-testid={`autonomy-${m || 'inherit'}`}>{t(m ? `autonomy:${m}` : 'inherit')}</button>
        })}</div>
        <div className="muted">{t('Read-only: Workers may look but every change needs your approval. Normal: risky actions need approval. High: also low-risk permission and listener actions run without asking; deleting, deploying, credentials and tests always ask.')}</div>
      </div></div>
      <button onClick={save} data-testid="policy-save">{t('Save {scope} policy', { scope })}</button>
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
      <h3>{t('Learning candidates')}</h3>
      <p className="muted">{t('Nothing becomes active knowledge without evidence (fresh replay) and/or a human.')}</p>
      <table className="tasks">
        <thead><tr><th>{t('Candidate')}</th><th>{t('Status')}</th><th>{t('Evidence')}</th><th /></tr></thead>
        <tbody>{items.map(c => (
          <tr key={c.id} data-testid={`candidate-${c.name}`}>
            <td><strong>{c.kind}</strong> {c.name}<div className="muted">{c.description} · {c.source} · {t('needs {g}', { g: t(GOVERNANCE[c.kind] ?? '') })}</div>
              <details><summary>{t('content')}</summary><pre>{c.body}</pre></details></td>
            <td><span className={`state ${c.status}`} data-testid="candidate-status">{tState(c.status)}</span>{c.decision && <div className="muted">{c.decision}</div>}</td>
            <td>{c.evals.flatMap(e => e.arms).map(a => <div key={a.arm}>{a.arm}: {a.passed ? 'PASS' : 'FAIL'} in {a.attempts}</div>)}{c.comparison && <div className="muted">{c.comparison.reason}</div>}</td>
            <td className="actions">
              {c.status === 'candidate' && c.kind !== 'memory' && <button disabled={busy === c.id} onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/evaluate`, {}))}>{busy === c.id ? t('Replaying…') : t('Evaluate (replay)')}</button>}
              {c.status === 'candidate' && (c.kind === 'memory' || GOVERNANCE[c.kind] === 'evidence + human') && <>
                <button onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/decide`, { approved: true }))} data-testid="candidate-approve">{t('Approve')}</button>
                <button className="danger" onClick={() => act(c.id, api('POST', `/api/learning/${c.id}/decide`, { approved: false }))}>{t('Reject')}</button>
              </>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      {!items.length && <p className="muted">{t('No candidates yet — they appear after tasks pass.')}</p>}
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
      <h3>{t('Health')}</h3>
      <div className="health-row">
        <span data-testid="health-chief" className={`badge ${chief?.failed ? 'warn' : ''}`}>{t('Chief wake: ')}{chief ? (chief.enabled ? t('on · {n} pending', { n: chief.pending }) + (chief.failed ? t(' · {n} failed', { n: chief.failed }) : '') : t('off')) : '—'}</span>
        <span className="badge">{t('last wake: ')}{chief?.lastDelivery ? new Date(chief.lastDelivery.at).toLocaleTimeString() : t('never')}</span>
        <span data-testid="health-arch" className={`badge ${errors ? 'warn' : ''}`}>{t('architecture: ')}{arch ? t('{m} modules · {e} drift error(s)', { m: arch.stats.modules, e: errors }) + (arch.freshness?.stale ? t(' · rescanning') : '') : '—'}</span>
      </div>
      {chief && chief.recent.length > 0 && (
        <details><summary>{t('Recent Chief wakes')}</summary>
          <ul>{chief.recent.map(w => <li key={w.id}>[{w.priority}] {w.reason} — {w.status}: {w.summary}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
