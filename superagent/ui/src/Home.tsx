/** Home: all projects at a glance — progress, Workers now, failures, decisions waiting, latest files. */
import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { t, tState, tx } from './i18n.ts'

interface ProjectCard {
  id: string; name: string; root: string
  goal: { id: string; objective: string; status: string; blocker?: string } | null
  progress: { passed: number; total: number }
  running: Array<{ id: string; title: string; attempt: number }>
  failed: Array<{ id: string; title: string }>
  decisions: Array<{ id: string; reason: string; detail: string }>
  files: Array<{ id: string; name: string; createdAt: string }>
  testGate: boolean
}

export function HomeView({ onOpen, onAdd }: { onOpen: (id: string, tab?: string) => void; onAdd: () => void }) {
  const [cards, setCards] = useState<ProjectCard[] | null>(null)
  useEffect(() => {
    const load = () => api<ProjectCard[]>('GET', '/api/overview').then(setCards, () => {})
    void load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [])
  if (!cards) return <p className="muted">{t('Loading…')}</p>
  const decisions = cards.reduce((n, c) => n + c.decisions.length, 0)
  const working = cards.reduce((n, c) => n + c.running.length, 0)
  return (
    <div className="home" data-testid="home">
      <div className="home-summary">
        <span className="badge">{t('{n} project(s)', { n: cards.length })}</span>
        <span className={`badge ${working ? 'ok' : ''}`}>{t('{n} Worker(s) working', { n: working })}</span>
        <span className={`badge ${decisions ? 'warn' : ''}`}>{t('{n} decision(s) waiting', { n: decisions })}</span>
      </div>
      <div className="home-grid">
        {cards.map(c => (
          <section key={c.id} className={`card home-card ${c.decisions.length ? 'attention' : ''}`} data-testid={`home-${c.id}`}>
            <header className="row"><button className="link" onClick={() => onOpen(c.id)}><strong>{c.name}</strong></button><span className="spacer" />{c.goal && <span className={`state ${c.goal.status}`}>{tState(c.goal.status)}</span>}</header>
            {c.goal ? <>
              <p className="home-goal">{c.goal.objective}</p>
              {c.progress.total > 0 && <div className="row"><progress max={c.progress.total} value={c.progress.passed} /> <span className="muted">{t('{p}/{n} tasks done', { p: c.progress.passed, n: c.progress.total })}</span></div>}
            </> : <p className="muted">{t('No goal yet.')}</p>}
            {c.running.map(r => <div key={r.id} className="home-line">⚙ {r.title} <span className="muted">{t('attempt {n}', { n: r.attempt })}</span></div>)}
            {c.decisions.map(d => <div key={d.id} className="home-line warn-text">! {t(d.reason)}: {tx(d.detail)} <button className="small" onClick={() => onOpen(c.id)}>{t('Decide')}</button></div>)}
            {c.failed.map(f => <div key={f.id} className="home-line error-text">✕ {f.title}</div>)}
            {c.files.length > 0 && <div className="home-line muted">▤ {c.files.map(f => f.name).join(' · ')} <button className="small" onClick={() => onOpen(c.id, 'files')}>{t('Files')}</button></div>}
            {!c.testGate && <div className="home-line muted">{t('no test command: checks only cover architecture')}</div>}
          </section>
        ))}
        <button className="card home-add" onClick={onAdd}>{t('＋ Add project')}</button>
      </div>
    </div>
  )
}
