/** SuperAgent minimal Web/PWA (Freeze §12.1): projects, goal, workers/loop, architecture, model selection, approve/stop/steer. */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, eventStream, fmtModel, type ProjectDetail, type Project, type SAEvent, type Task } from './api.ts'
import { ArchitectureView } from './ArchitectureView.tsx'

type Tab = 'overview' | 'workers' | 'architecture' | 'events'

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(() => localStorage.getItem('superagent-project'))
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('superagent-tab') as Tab) ?? 'overview')
  const [events, setEvents] = useState<SAEvent[]>([])
  const [archKey, setArchKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const loadProjects = useCallback(() => api<Project[]>('GET', '/api/projects').then(p => {
    setProjects(p)
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
      window.clearTimeout(timer)
      timer = window.setTimeout(loadDetail, 150)
    })
    const poll = window.setInterval(loadDetail, 5000)
    return () => { stop(); window.clearInterval(poll); window.clearTimeout(timer) }
  }, [current, loadDetail])
  useEffect(() => { localStorage.setItem('superagent-tab', tab) }, [tab])

  const act = (p: Promise<unknown>) => p.then(() => { setError(null); loadDetail(); void loadProjects() }, e => setError(String(e)))

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>SuperAgent</h1>
        <nav data-testid="project-list">
          {projects.map(p => (
            <button key={p.id} className={p.id === current ? 'active' : ''} onClick={() => setCurrent(p.id)} data-testid={`project-${p.id}`}>
              <span>{p.name}</span>
              <small>{p.goal?.status ?? 'no goal'}{p.openHumanGates ? ` · ${p.openHumanGates} decision(s)` : ''}</small>
            </button>
          ))}
        </nav>
        <AddProject onAdd={(name, root) => act(api('POST', '/api/projects', { name, root }))} />
      </aside>
      <main>
        {error && <div className="error" onClick={() => setError(null)} data-testid="error">{error}</div>}
        {!detail ? <p className="muted">Add or select a project.</p> : (
          <>
            <header className="project-header">
              <h2 data-testid="project-title">{detail.project.name}</h2>
              <code>{detail.project.root}</code>
              <div className="tabs">
                {(['overview', 'workers', 'architecture', 'events'] as Tab[]).map(t => (
                  <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{t}</button>
                ))}
              </div>
            </header>
            {tab === 'overview' && <Overview detail={detail} act={act} />}
            {tab === 'workers' && <Workers detail={detail} />}
            {tab === 'architecture' && <ArchitectureView projectId={detail.project.id} refreshKey={archKey} />}
            {tab === 'events' && <Events events={events} />}
          </>
        )}
      </main>
    </div>
  )
}

function AddProject({ onAdd }: { onAdd: (name: string, root: string) => void }) {
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); if (name && root) { onAdd(name, root); setName(''); setRoot('') } }
  return (
    <form className="add-project" onSubmit={submit}>
      <input placeholder="project name" value={name} onChange={e => setName(e.target.value)} data-testid="new-project-name" />
      <input placeholder="/absolute/path" value={root} onChange={e => setRoot(e.target.value)} data-testid="new-project-root" />
      <button type="submit" data-testid="add-project">Add project</button>
    </form>
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
          <h3>Needs your decision</h3>
          {openGates.map(g => <HumanGateCard key={g.id} gate={g} task={detail.tasks.find(t => t.id === g.taskId)} onDecide={(d, note) => act(api('POST', `/api/projects/${pid}/human-gates/${g.id}`, { decision: d, resolution: note }))} />)}
        </section>
      )}
      <section className="card">
        <h3>Goal</h3>
        {goal ? (
          <div data-testid="goal">
            <p><strong>{goal.objective}</strong> <span className={`state ${goal.status}`} data-testid="goal-status">{goal.status}</span></p>
            {goal.blocker && <p className="muted">{goal.blocker}</p>}
            <button disabled={running || tasks.length === 0} onClick={() => act(api('POST', `/api/projects/${pid}/goals/${goal.id}/run`, {}))} data-testid="run-goal">{running ? 'Running…' : 'Start / continue'}</button>
          </div>
        ) : <p className="muted">No goal yet.</p>}
        <form className="inline" onSubmit={e => { e.preventDefault(); if (objective) act(api('POST', `/api/projects/${pid}/goals`, { objective })); setObjective('') }}>
          <input placeholder="New goal objective" value={objective} onChange={e => setObjective(e.target.value)} data-testid="new-goal" />
          <button type="submit" data-testid="create-goal">Create goal</button>
        </form>
      </section>
      {goal && (
        <section className="card">
          <h3>Tasks</h3>
          <table className="tasks" data-testid="tasks">
            <thead><tr><th>Task</th><th>State</th><th>Attempts</th><th>Worker model</th><th>Last verdict</th><th /></tr></thead>
            <tbody>{tasks.map(t => <TaskRow key={t.id} task={t} pid={pid} act={act} />)}</tbody>
          </table>
          <form className="new-task" onSubmit={e => {
            e.preventDefault()
            if (!title) return
            act(api('POST', `/api/projects/${pid}/goals/${goal.id}/tasks`, { title, instructions, policy: model ? { model: { worker: parseModel(model) } } : undefined }))
            setTitle(''); setInstructions('')
          }}>
            <input placeholder="Task title" value={title} onChange={e => setTitle(e.target.value)} data-testid="new-task-title" />
            <textarea placeholder="Instructions for the Worker" value={instructions} onChange={e => setInstructions(e.target.value)} data-testid="new-task-instructions" />
            <ModelInput value={model} onChange={setModel} testId="new-task-model" />
            <button type="submit" data-testid="add-task">Add task</button>
          </form>
        </section>
      )}
      <section className="card"><h3>Chief report</h3><pre data-testid="chief-report">{detail.report}</pre></section>
    </div>
  )
}

const parseModel = (s: string) => (s === 'local-default' ? { provider: 'local-default', model: 'default' } : { provider: s.split('/')[0], model: s.split('/').slice(1).join('/') })

function ModelInput({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <>
      <input list="models" placeholder="model (provider/model, default local)" value={value} onChange={e => onChange(e.target.value)} data-testid={testId} />
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
      <td>{task.title}{task.steer && <div className="muted">steer: {task.steer}</div>}</td>
      <td><span className={`state ${task.state}`} data-testid="task-state">{task.state}</span></td>
      <td>{task.attempts.length}/{task.policy.maxAttempts}{last && <div className="muted">{last.strategy}</div>}</td>
      <td>
        <div>{fmtModel(task.policy.model.worker)}</div>
        {!task.running && <form className="inline" onSubmit={e => { e.preventDefault(); if (model) act(api('POST', `/api/projects/${pid}/tasks/${task.id}/model`, { role: 'worker', model })); setModel('') }}>
          <ModelInput value={model} onChange={setModel} testId="task-model" /><button type="submit">Set</button>
        </form>}
      </td>
      <td data-testid="task-verdict">{last?.verdict ?? '—'}</td>
      <td className="actions">
        <button disabled={['passed', 'failed', 'stopped'].includes(task.state)} onClick={() => act(api('POST', `/api/projects/${pid}/tasks/${task.id}/stop`, {}))} data-testid="stop-task">Stop</button>
        <form className="inline" onSubmit={e => { e.preventDefault(); if (steer) act(api('POST', `/api/projects/${pid}/tasks/${task.id}/steer`, { text: steer })); setSteer('') }}>
          <input placeholder="steer next attempt" value={steer} onChange={e => setSteer(e.target.value)} data-testid="steer-input" /><button type="submit" data-testid="steer-task">Steer</button>
        </form>
      </td>
    </tr>
  )
}

function HumanGateCard({ gate, task, onDecide }: { gate: ProjectDetail['humanGates'][number]; task?: Task; onDecide: (d: 'approved' | 'rejected', note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <div className="gate" data-testid={`gate-${gate.id}`}>
      <div><span className="badge warn">{gate.reason}</span> {task && <strong>{task.title}</strong>}</div>
      <p>{gate.detail}</p>
      <input placeholder="decision note / direction" value={note} onChange={e => setNote(e.target.value)} data-testid="gate-note" />
      <button onClick={() => onDecide('approved', note)} data-testid="approve">Approve</button>
      <button className="danger" onClick={() => onDecide('rejected', note)} data-testid="reject">Reject</button>
    </div>
  )
}

function Workers({ detail }: { detail: ProjectDetail }) {
  const workers = [...detail.workers].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return (
    <section className="card">
      <h3>Workers / Loop</h3>
      <table className="tasks" data-testid="workers">
        <thead><tr><th>Worker</th><th>Task</th><th>Attempt</th><th>Status</th><th>Model</th><th>Last report</th><th>Modules</th></tr></thead>
        <tbody>{workers.map(w => (
          <tr key={w.id}>
            <td><code>{w.id}</code><div className="muted">{w.executor}</div></td>
            <td>{detail.tasks.find(t => t.id === w.taskId)?.title ?? w.taskId}</td>
            <td>{w.attempt}</td>
            <td><span className={`state ${w.status}`}>{w.status}</span></td>
            <td>{fmtModel(w.model)}</td>
            <td>{w.lastReport ? <><div>{w.lastReport.kind}: {w.lastReport.current_state}</div><progress max={100} value={w.lastReport.progress} /> <span className="muted">claim {w.lastReport.verification_result}</span></> : '—'}</td>
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
      <h3>Live events</h3>
      <ol className="events" data-testid="events">{events.map(e => (
        <li key={`${e.seq}`}><time>{new Date(e.ts).toLocaleTimeString()}</time> <strong>{e.type}</strong> <code>{JSON.stringify(e.data).slice(0, 200)}</code></li>
      ))}</ol>
    </section>
  )
}
