/** SuperAgent Web/PWA (Freeze §12.1): ask, Chief chat, files, terminal, workers/loop, architecture, policy — desktop and phone. */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { activityStream, api, eventStream, fmtModel, type ActivityEvent, type ActivityLine, type ProjectDetail, type Project, type SAEvent, type Task } from './api.ts'
import { useAppearance } from './theme.ts'
import { BackgroundLayer } from './Background.tsx'
import { AppearancePanel } from './Appearance.tsx'
import { TerminalPanel } from './Terminal.tsx'
import { inline } from './Markdown.tsx'
import { SystemPanel, type SystemTab } from './System.tsx'
import { ProjectWizard } from './ProjectWizard.tsx'
import type { HealthReport, PresetView } from './api.ts'
import { ArchitectureView } from './ArchitectureView.tsx'
import { lang, setLang, t, tState, tx } from './i18n.ts'
import { HealthPanel, LearningPanel, PolicyPanel } from './Panels.tsx'
import { ChiefChat } from './Chat.tsx'
import { FilesPanel } from './Files.tsx'
import { TranscriptDrawer } from './Transcript.tsx'

type Tab = 'overview' | 'chat' | 'files' | 'terminal' | 'workers' | 'architecture' | 'learning' | 'policy' | 'events'
const TABS: Array<[Tab, string, string]> = [
  ['overview', 'Overview', '◎'], ['chat', 'Chief', '✦'], ['files', 'Files', '▤'], ['terminal', 'Terminal', '›_'], ['workers', 'Workers', '⚙'],
  ['architecture', 'Architecture', '◇'], ['learning', 'Learning', '✧'], ['policy', 'Policy', '⚖'], ['events', 'Events', '≡'],
]
/** Shown in the phone's bottom bar; the rest sit behind "More". */
const PRIMARY: Tab[] = ['overview', 'chat', 'files', 'terminal']

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(() => localStorage.getItem('superagent-project'))
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('superagent-tab') as Tab) ?? 'overview')
  const [events, setEvents] = useState<SAEvent[]>([])
  const [archKey, setArchKey] = useState(0)
  const [chatKey, setChatKey] = useState(0)
  const [filesKey, setFilesKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showAppearance, setShowAppearance] = useState(false)
  const [system, setSystem] = useState<SystemTab | null>(null)
  const [wizard, setWizard] = useState(false)
  const [health, setHealth] = useState<HealthReport['overall'] | null>(null)
  const loadHealth = useCallback(() => api<HealthReport>('GET', '/api/system/health').then(h => setHealth(h.overall), () => setHealth(null)), [])
  useEffect(() => { void loadHealth() }, [loadHealth])
  const [more, setMore] = useState(false)
  const [cmdKey, setCmdKey] = useState(0)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [chiefFeed, setChiefFeed] = useState<Array<{ seq: number; projectId: string; role: string; text: string }>>([])
  const look = useAppearance(setError)

  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const loadProjects = useCallback(() => api<Project[]>('GET', '/api/projects').then(p => {
    setProjects(p)
    setProjectsLoaded(true)
    if (!current && p[0]) setCurrent(p[0].id)
  }, e => setError(String(e))), [current])
  const loadDetail = useCallback(() => {
    if (!current) return
    api<ProjectDetail>('GET', `/api/projects/${current}`).then(setDetail, e => setError(String(e)))
  }, [current])

  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => {
    if (!current) return
    localStorage.setItem('superagent-project', current)
    setEvents([])
    loadDetail()
    let timer: number | undefined
    const stop = eventStream(current, e => {
      setEvents(prev => [e, ...prev].slice(0, 300))
      if (e.type.startsWith('architecture/') || e.type === 'receipt/created' || e.type === 'worker/started' || e.type === 'worker/exited') setArchKey(k => k + 1)
      if (e.type === 'chief/message') setChatKey(k => k + 1)
      if (e.type === 'file/shared') setFilesKey(k => k + 1)
      if (e.type === 'command/updated') setCmdKey(k => k + 1)
      if (e.type === 'chief/message') setChiefFeed(prev => [...prev, { seq: e.seq, projectId: e.projectId, role: String(e.data.role), text: String(e.data.text) }].slice(-50))
      window.clearTimeout(timer)
      timer = window.setTimeout(loadDetail, 150)
    })
    const stopActivity = activityStream(current, a => setActivity(prev => [...prev, a].slice(-50)))
    const poll = window.setInterval(loadDetail, 5000)
    return () => { stop(); stopActivity(); window.clearInterval(poll); window.clearTimeout(timer) }
  }, [current, loadDetail])
  useEffect(() => { localStorage.setItem('superagent-tab', tab) }, [tab])

  const act = (p: Promise<unknown>) => p.then(() => { setError(null); loadDetail(); void loadProjects() }, e => setError(String(e)))

  const b = look.effective.background
  const bgUrl = look.assetUrl(b.assetId)
  const chatAsHuman = (text: string) => { if (current) act(api('POST', `/api/projects/${current}/chief/messages`, { text })) }
  const go = (t: Tab) => { setTab(t); setMore(false) }
  return (
    <>
    <BackgroundLayer a={look.effective} url={bgUrl} theme={look.resolvedTheme}
      feed={{ activity, chief: chiefFeed, project: detail ? { id: detail.project.id, name: detail.project.name } : null }}
      onChat={chatAsHuman} onNotice={setError} />
    {/* Above every modal: an error raised inside the System page or a wizard must be visible there. */}
    {error && <div className="error toast" role="alert" onClick={() => setError(null)} data-testid="error">{tx(error.replace(/^Error: /, ""))}<span className="toast-close">✕</span></div>}
    {system && <SystemPanel initial={system} onClose={() => { setSystem(null); void loadHealth() }} onError={setError} />}
    {(wizard || (projectsLoaded && projects.length === 0)) && !system && <ProjectWizard onClose={() => setWizard(false)} onCreated={id => { setWizard(false); setCurrent(id); void loadProjects() }} onError={setError} />}
    {showAppearance && <AppearancePanel view={look.view} current={look.effective} isLocal={look.isLocal} onSave={look.save} onReload={look.reload} onClose={() => setShowAppearance(false)} onError={setError} />}
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1><span className="brand-mark">✳</span> SuperAgent</h1>
          {health && <button className={`health-dot ${health}`} title={t('System health: {h}', { h: t(health) })} aria-label={`System health ${health}`} onClick={() => setSystem('health')} data-testid="health-dot" />}
          <button className="icon" title={t('System')} aria-label="System" onClick={() => setSystem('health')} data-testid="open-system">⚙</button>
          <button className="icon" title={t('Appearance')} aria-label="Appearance" onClick={() => setShowAppearance(true)} data-testid="open-appearance">◐</button>
          <button className="icon lang" title={t('Language')} aria-label="Language" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} data-testid="toggle-lang">{lang === 'zh' ? 'EN' : '中'}</button>
        </div>
        <nav data-testid="project-list">
          {projects.map(p => (
            <button key={p.id} className={p.id === current ? 'active' : ''} onClick={() => setCurrent(p.id)} data-testid={`project-${p.id}`}>
              <span>{p.name}</span>
              <small>{p.goal?.status ? tState(p.goal.status) : t('no goal')}{p.openHumanGates ? t(' · {n} decision(s)', { n: p.openHumanGates }) : ''}</small>
            </button>
          ))}
        </nav>
        <button className="add-project-btn" onClick={() => setWizard(true)} data-testid="add-project-toggle">{t('＋ Add project')}</button>
      </aside>
      <main>
        {!detail ? <><Guide onModels={() => setSystem('models')} onAdd={() => setWizard(true)} always /><p className="muted">{t('Add or select a project.')}</p></> : (
          <>
            <header className="project-header">
              <h2 data-testid="project-title">{detail.project.name}</h2>
              <code>{detail.project.root}</code>
              <div className="tabs" role="tablist">
                {TABS.map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => go(k)} data-testid={`tab-${k}`}>{t(label)}</button>
                ))}
              </div>
            </header>
            <nav className="bottom-bar" aria-label="sections">
              {TABS.filter(([k]) => PRIMARY.includes(k)).map(([k, label, icon]) => (
                <button key={k} className={tab === k ? 'active' : ''} onClick={() => go(k)} data-testid={`nav-${k}`}><span className="nav-icon">{icon}</span>{t(label)}</button>
              ))}
              <button className={!PRIMARY.includes(tab) ? 'active' : ''} onClick={() => setMore(m => !m)} data-testid="nav-more"><span className="nav-icon">⋯</span>{t('More')}</button>
              {more && (
                <div className="more-sheet" data-testid="more-sheet">
                  {TABS.filter(([k]) => !PRIMARY.includes(k)).map(([k, label, icon]) => <button key={k} onClick={() => go(k)} data-testid={`more-${k}`}><span className="nav-icon">{icon}</span>{t(label)}</button>)}
                  <button onClick={() => { setMore(false); setShowAppearance(true) }} data-testid="more-appearance"><span className="nav-icon">◐</span>{t('Appearance')}</button>
                  <button onClick={() => { setMore(false); setSystem('health') }} data-testid="more-system"><span className="nav-icon">⚙</span>{t('System')}</button>
                </div>
              )}
            </nav>
            {tab === 'overview' && <>{!detail.goal && <Guide onModels={() => setSystem('models')} onAdd={() => setWizard(true)} gates={detail.project.defaultGates ?? []} />}<Ask detail={detail} act={act} onHealth={() => setSystem('health')} /><Activity projectId={detail.project.id} refreshKey={events.length} /><HealthPanel projectId={detail.project.id} refreshKey={archKey} /><Overview detail={detail} act={act} /></>}
            {tab === 'learning' && <LearningPanel projectId={detail.project.id} onError={setError} refreshKey={events.length} />}
            {tab === 'policy' && <PolicyPanel projectId={detail.project.id} onError={setError} />}
            {tab === 'chat' && <ChiefChat projectId={detail.project.id} refreshKey={chatKey} onError={setError} />}
            {tab === 'files' && <FilesPanel projectId={detail.project.id} refreshKey={filesKey} onError={setError} />}
            {tab === 'terminal' && <TerminalPanel projectId={detail.project.id} root={detail.project.root} refreshKey={cmdKey} onError={setError} />}
            {tab === 'workers' && <Workers detail={detail} onError={setError} />}
            {tab === 'architecture' && <ArchitectureView projectId={detail.project.id} refreshKey={archKey} />}
            {tab === 'events' && <Events events={events} />}
          </>
        )}
      </main>
    </div>
    </>
  )
}

/** First-run guide: the whole loop in four steps, each with the button that does it. */
function Guide({ onModels, onAdd, gates, always }: { onModels: () => void; onAdd: () => void; gates?: Array<{ id: string; kind?: string }>; always?: boolean }) {
  const [hidden, setHidden] = useState(() => { try { return !always && localStorage.getItem('superagent-guide-done') === '1' } catch (noStorage) { void noStorage; return false } })
  if (hidden) return null
  const onlyArch = gates && gates.length > 0 && gates.every(g => g.id === 'architecture')
  return (
    <section className="card guide" data-testid="guide">
      <h3>{t('How SuperAgent works')}</h3>
      <ol>
        <li><strong>{t('Connect a model.')}</strong> {t('System → Models: add your local server or a cloud API (DeepSeek, OpenAI, Claude…), then press “Use” on a preset.')} <button className="small" onClick={onModels}>{t('Open Models')}</button></li>
        <li><strong>{t('Add a project.')}</strong> {t('Pick a folder on this machine. SuperAgent scans it and proposes the checks (tests) that decide when a change is “done”.')} <button className="small" onClick={onAdd}>{t('＋ Add project')}</button></li>
        <li><strong>{t('Say what you want.')}</strong> {t('Type it in “What do you want?” and press Go. The Chief plans it into tasks, Workers (AI) do them, and the checks — not the AI — decide whether each task passed.')}</li>
        <li><strong>{t('Watch and decide.')}</strong> {t('Activity shows progress in plain words. When something needs you (a risky command, repeated failures), it appears under “Needs your decision”: approve or reject.')}</li>
      </ol>
      {onlyArch && <p className="warn-text">{t('This project has no test command yet, so “checks passed” only means nothing broke structurally — add a test command to the project for real checking.')}</p>}
      {!always && <div className="row-end"><button className="small" onClick={() => { try { localStorage.setItem('superagent-guide-done', '1') } catch (noStorage) { void noStorage } setHidden(true) }} data-testid="guide-close">{t('Got it')}</button></div>}
    </section>
  )
}

/** The one box: describe the change; the Chief plans it, Workers build it, checks decide. */
function Ask({ detail, act, onHealth }: { detail: ProjectDetail; act: (p: Promise<unknown>) => void; onHealth: () => void }) {
  const [request, setRequest] = useState('')
  const [review, setReview] = useState(false)
  const [preset, setPreset] = useState('')
  const [presets, setPresets] = useState<PresetView[]>([])
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => { api<{ presets: PresetView[] }>('GET', '/api/system/presets').then(r => setPresets(r.presets.filter(p => p.available)), () => {}) }, [])
  const gates = detail.project.defaultGates ?? []
  const send = (force = false) => {
    if (!request.trim() || busy) return
    setBusy(true)
    setBlocked(null)
    api('POST', `/api/projects/${detail.project.id}/requests`, { request, review, force, ...(preset ? { preset } : {}) })
      .then(() => { setRequest(''); act(Promise.resolve()) }, e => { const m = String((e as Error).message ?? e); if (/^not ready/.test(m)) setBlocked(m); else act(Promise.reject(e)) })
      .finally(() => setBusy(false))
  }
  const submit = (e: FormEvent) => { e.preventDefault(); send() }
  return (
    <form className="card ask" onSubmit={submit} data-testid="ask">
      <h3>{t('What do you want?')}</h3>
      <textarea placeholder={t('Describe the change in plain words, e.g. “the signup form should reject emails without an @”')} value={request} onChange={e => setRequest(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e) }} data-testid="ask-input" rows={3} />
      <div className="ask-row">
        <label><input type="checkbox" checked={review} onChange={e => setReview(e.target.checked)} data-testid="ask-review" /> {t('also have a reviewer check the change')}</label>
        {presets.length > 0 && <select value={preset} onChange={e => setPreset(e.target.value)} title={t('Models for this request only')} data-testid="ask-preset">
          <option value="">{t('models: current')}</option>{presets.map(p => <option key={p.id} value={p.id}>{t('this time: {name}', { name: t(p.name) })}</option>)}
        </select>}
        <span className="muted">{t('checks: ')}{gates.length ? gates.map(g => g.id + (g.heldOut ? t(' (hidden)') : '')).join(', ') : t('none — add a test gate')}</span>
        <button type="submit" disabled={busy || !request.trim()} data-testid="ask-submit">{busy ? t('Planning…') : t('Go')}</button>
      </div>
      {blocked && <div className="warn-box" data-testid="ask-blocked">{tx(blocked)}<div className="row"><button type="button" onClick={onHealth}>{t('Open Health')}</button><button type="button" className="danger" onClick={() => send(true)} data-testid="ask-force">{t('Run anyway')}</button></div></div>}
    </form>
  )
}

function Activity({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [lines, setLines] = useState<ActivityLine[]>([])
  useEffect(() => {
    const timer = window.setTimeout(() => { api<ActivityLine[]>('GET', `/api/projects/${projectId}/activity?limit=30&lang=${lang}`).then(setLines, () => {}) }, 200)
    return () => window.clearTimeout(timer)
  }, [projectId, refreshKey])
  if (!lines.length) return null
  return (
    <section className="card">
      <h3>{t('Activity')}</h3>
      <ol className="activity" data-testid="activity">{[...lines].reverse().map(l => (
        <li key={l.seq} className={`tone-${l.tone}`}><time>{new Date(l.ts).toLocaleTimeString()}</time> {inline(l.text)}</li>
      ))}</ol>
    </section>
  )
}


function Overview({ detail, act }: { detail: ProjectDetail; act: (p: Promise<unknown>) => void }) {
  const pid = detail.project.id
  const goal = detail.goal
  const [objective, setObjective] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('')
  const tasks = goal ? detail.tasks.filter(t => t.goalId === goal.id) : []
  const running = goal ? detail.runningGoals.includes(goal.id) : false
  const openGates = detail.humanGates.filter(g => g.status === 'open')
  return (
    <div className="overview">
      {openGates.length > 0 && (
        <section className="card attention" data-testid="human-gates">
          <h3>{t('Needs your decision')}</h3>
          {openGates.map(g => <HumanGateCard key={g.id} gate={g} task={detail.tasks.find(t => t.id === g.taskId)} onDecide={(d, note) => act(api('POST', `/api/projects/${pid}/human-gates/${g.id}`, { decision: d, resolution: note }))} />)}
        </section>
      )}
      <section className="card">
        <h3>{t('Goal')}</h3>
        {goal ? (
          <div data-testid="goal">
            <p><strong>{goal.objective}</strong> <span className={`state ${goal.status}`} data-testid="goal-status">{tState(goal.status)}</span>{goal.runRequested && !running && <span className="badge" data-testid="goal-queued">{t('queued')}</span>}</p>
            {goal.request && goal.request !== goal.objective && <p className="muted">{t('asked: {r}', { r: goal.request })}</p>}
            {goal.blocker && <p className="muted">{tx(goal.blocker)}</p>}
            <button disabled={running || tasks.length === 0} onClick={() => act(api('POST', `/api/projects/${pid}/goals/${goal.id}/run`, {}))} data-testid="run-goal">{running ? t('Running…') : t('Start / continue')}</button>
          </div>
        ) : <p className="muted">{t('No goal yet.')}</p>}
        <form className="inline" onSubmit={e => { e.preventDefault(); if (objective) act(api('POST', `/api/projects/${pid}/goals`, { objective })); setObjective('') }}>
          <input placeholder={t('New goal objective')} value={objective} onChange={e => setObjective(e.target.value)} data-testid="new-goal" />
          <button type="submit" data-testid="create-goal">{t('Create goal')}</button>
        </form>
      </section>
      {goal && (
        <section className="card">
          <h3>{t('Tasks')}</h3>
          <table className="tasks" data-testid="tasks">
            <thead><tr><th>{t('Task')}</th><th>{t('State')}</th><th>{t('Attempts')}</th><th>{t('Worker model')}</th><th>{t('Last verdict')}</th><th /></tr></thead>
            <tbody>{tasks.map(t => <TaskRow key={t.id} task={t} pid={pid} act={act} />)}</tbody>
          </table>
          <form className="new-task" onSubmit={e => {
            e.preventDefault()
            if (!title) return
            act(api('POST', `/api/projects/${pid}/goals/${goal.id}/tasks`, { title, instructions, policy: model ? { model: { worker: parseModel(model) } } : undefined }))
            setTitle(''); setInstructions('')
          }}>
            <input placeholder={t('Task title')} value={title} onChange={e => setTitle(e.target.value)} data-testid="new-task-title" />
            <textarea placeholder={t('Instructions for the Worker')} value={instructions} onChange={e => setInstructions(e.target.value)} data-testid="new-task-instructions" />
            <ModelInput value={model} onChange={setModel} testId="new-task-model" />
            <button type="submit" data-testid="add-task">{t('Add task')}</button>
          </form>
        </section>
      )}
      <section className="card"><h3>{t('Chief report')}</h3><pre data-testid="chief-report">{detail.report}</pre></section>
    </div>
  )
}

const parseModel = (s: string) => (s === 'local-default' ? { provider: 'local-default', model: 'default' } : { provider: s.split('/')[0], model: s.split('/').slice(1).join('/') })

function ModelInput({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <>
      <input list="models" placeholder={t('model (provider/model, default local)')} value={value} onChange={e => onChange(e.target.value)} data-testid={testId} />
      <datalist id="models">
        <option value="local-default" /><option value="anthropic/claude-opus-5-5" /><option value="deepseek-official/deepseek-flash" /><option value="deepseek-official/deepseek-pro" />
      </datalist>
    </>
  )
}

function TaskRow({ task, pid, act }: { task: Task; pid: string; act: (p: Promise<unknown>) => void }) {
  const [model, setModel] = useState('')
  const [steer, setSteer] = useState('')
  const last = task.attempts.at(-1)
  return (
    <tr data-testid={`task-${task.id}`}>
      <td>{task.title}{task.review && <span className="badge" title={t('reviewed after checks pass')}>{t('review')}</span>}{task.steer && <div className="muted">{t('steer: {s}', { s: task.steer })}</div>}{task.reviews?.at(-1) && !task.reviews.at(-1)!.approve && <div className="muted">{t('reviewer: {c}', { c: task.reviews.at(-1)!.comments })}</div>}</td>
      <td><span className={`state ${task.state}`} data-testid="task-state">{tState(task.state)}</span></td>
      <td>{task.attempts.length}/{task.policy.maxAttempts}{last && <div className="muted">{last.strategy}</div>}</td>
      <td>
        <div>{fmtModel(task.policy.model.worker)}</div>
        {!task.running && <form className="inline" onSubmit={e => { e.preventDefault(); if (model) act(api('POST', `/api/projects/${pid}/tasks/${task.id}/model`, { role: 'worker', model })); setModel('') }}>
          <ModelInput value={model} onChange={setModel} testId="task-model" /><button type="submit">{t('Set')}</button>
        </form>}
      </td>
      <td data-testid="task-verdict">{last?.verdict ? tState(last.verdict) : '—'}</td>
      <td className="actions">
        <button disabled={['passed', 'failed', 'stopped'].includes(task.state)} onClick={() => act(api('POST', `/api/projects/${pid}/tasks/${task.id}/stop`, {}))} data-testid="stop-task">{t('Stop')}</button>
        <form className="inline" onSubmit={e => { e.preventDefault(); if (steer) act(api('POST', `/api/projects/${pid}/tasks/${task.id}/steer`, { text: steer })); setSteer('') }}>
          <input placeholder={t('steer next attempt')} value={steer} onChange={e => setSteer(e.target.value)} data-testid="steer-input" /><button type="submit" data-testid="steer-task">{t('Steer')}</button>
        </form>
      </td>
    </tr>
  )
}

function HumanGateCard({ gate, task, onDecide }: { gate: ProjectDetail['humanGates'][number]; task?: Task; onDecide: (d: 'approved' | 'rejected', note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <div className="gate" data-testid={`gate-${gate.id}`}>
      <div><span className="badge warn">{t(gate.reason)}</span> {task && <strong>{task.title}</strong>}</div>
      <p>{tx(gate.detail)}</p>
      {gate.actions && gate.actions.length > 0 && (
        <details open data-testid="gate-actions"><summary>{t('{n} action(s) blocked before execution — approving allows exactly these', { n: gate.actions.length })}</summary>
          <ul>{gate.actions.map(a => <li key={a.fingerprint}><code>{a.summary}</code> <span className="muted">[{a.category}: {a.rule}]</span></li>)}</ul>
        </details>
      )}
      <input placeholder={t('decision note / direction')} value={note} onChange={e => setNote(e.target.value)} data-testid="gate-note" />
      <button onClick={() => onDecide('approved', note)} data-testid="approve">{t('Approve')}</button>
      <button className="danger" onClick={() => onDecide('rejected', note)} data-testid="reject">{t('Reject')}</button>
    </div>
  )
}

function Workers({ detail, onError }: { detail: ProjectDetail; onError: (e: string) => void }) {
  const workers = [...detail.workers].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section className="card">
      <h3>{t('Workers / Loop')} <span className="muted">{t('— tap a Worker to see exactly what it did')}</span></h3>
      {open && <TranscriptDrawer projectId={detail.project.id} workerId={open} onClose={() => setOpen(null)} onError={onError} />}
      <table className="tasks" data-testid="workers">
        <thead><tr><th>{t('Worker')}</th><th>{t('Task')}</th><th>{t('Attempt')}</th><th>{t('Status')}</th><th>{t('Model')}</th><th>{t('Last report')}</th><th>{t('Modules')}</th></tr></thead>
        <tbody>{workers.map(w => (
          <tr key={w.id} className="clickable" onClick={() => setOpen(w.id)} data-testid={`worker-${w.id}`}>
            <td><code>{w.id}</code><div className="muted">{w.executor}</div></td>
            <td>{detail.tasks.find(t => t.id === w.taskId)?.title ?? w.taskId}</td>
            <td>{w.attempt}</td>
            <td><span className={`state ${w.status}`}>{tState(w.status)}</span></td>
            <td>{fmtModel(w.model)}</td>
            <td>{w.lastReport ? <><div>{w.lastReport.kind}: {w.lastReport.current_state}</div><progress max={100} value={w.lastReport.progress} /> <span className="muted">{t('claim {c}', { c: w.lastReport.verification_result })}</span></> : '—'}</td>
            <td>{w.activeModules.join(', ') || '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  )
}

function Events({ events }: { events: SAEvent[] }) {
  return (
    <section className="card">
      <h3>{t('Live events')}</h3>
      <ol className="events" data-testid="events">{events.map(e => (
        <li key={`${e.seq}`}><time>{new Date(e.ts).toLocaleTimeString()}</time> <strong>{e.type}</strong> <code>{JSON.stringify(e.data).slice(0, 200)}</code></li>
      ))}</ol>
    </section>
  )
}
